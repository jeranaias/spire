/**
 * W1 — DDIL mode dramatization (SATCOM denial drill).
 *
 * Topbar control with four explicit comms states + a scripted 60s "DDIL
 * drill" sequence. Distinct from the AirGapToggle (which is a server-side
 * posture toggle gated to security_manager / mef_commander) — this lane
 * is purely client-side simulation: the API client interceptor reads the
 * `ddilMode` from the store and applies latency / loss / queue+cache
 * behavior on every request.
 *
 * - CONNECTED    — passthrough.
 * - LIMITED      — every API call sleeps 800–2000ms.
 * - INTERMITTENT — ~30% of calls drop with one retry; flicker pattern.
 * - DISCONNECTED — reads serve last-known-good cache; writes queue locally.
 *
 * On a DISCONNECTED → other transition, the queued writes replay in order
 * with a visible "syncing" overlay and an "all caught up" toast on
 * completion. The replay path bypasses the interceptor (replayQueuedWrite)
 * so a queued write is not re-queued.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useSpireStore, type DdilMode } from "../state/store";
import { drainDdilQueue } from "../state/ddilSync";
import { Button, Pressable } from "./ui";

const MODES: { mode: DdilMode; label: string; short: string; tone: string }[] = [
  { mode: "CONNECTED",    label: "Connected",    short: "CONN", tone: "var(--color-success)" },
  { mode: "LIMITED",      label: "Limited",      short: "LIM",  tone: "var(--color-warning)" },
  { mode: "INTERMITTENT", label: "Intermittent", short: "INT",  tone: "var(--color-warning)" },
  { mode: "DISCONNECTED", label: "Disconnected", short: "DISC", tone: "var(--color-danger)" },
];

const MODE_DESC: Record<DdilMode, string> = {
  CONNECTED: "Steady-state SATCOM. All API calls passthrough.",
  LIMITED: "High latency / partial bandwidth. Every call adds 800–2000ms.",
  INTERMITTENT: "Random packet loss. ~30% of calls drop on the wire — operator re-issues the request to retry.",
  DISCONNECTED: "SATCOM denied. Reads serve last-known-good cache; writes queue locally and replay on reconnect.",
};

function formatStale(ageMs: number): string {
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 ? ` ${min % 60}m` : ""}`;
}

function formatClock(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  } catch {
    return new Date(ts).toISOString().slice(11, 19);
  }
}

const DRILL_STEPS: { mode: DdilMode; ms: number }[] = [
  { mode: "CONNECTED",    ms: 5000 },
  { mode: "LIMITED",      ms: 15000 },
  { mode: "INTERMITTENT", ms: 15000 },
  { mode: "DISCONNECTED", ms: 20000 },
  { mode: "CONNECTED",    ms: 5000 },
];

export function CommsControl() {
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const setDdilMode = useSpireStore((s) => s.setDdilMode);
  const ddilQueue = useSpireStore((s) => s.ddilQueue);
  const ddilSyncing = useSpireStore((s) => s.ddilSyncing);
  const ddilDrillActive = useSpireStore((s) => s.ddilDrillActive);
  const setDdilDrillActive = useSpireStore((s) => s.setDdilDrillActive);
  const pushToast = useSpireStore((s) => s.pushToast);

  const [open, setOpen] = useState(false);
  const [drainTotal, setDrainTotal] = useState(0);
  const wrap = useRef<HTMLDivElement | null>(null);
  const drillTimers = useRef<number[]>([]);

  const queueDepth = ddilQueue.length;
  const current = MODES.find((m) => m.mode === ddilMode) ?? MODES[0];

  // Click-outside / Escape closes the popover.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrap.current) return;
      if (!wrap.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Cleanup any pending drill timers on unmount so HMR / sign-out doesn't
  // leave a stale setTimeout flipping the store after the component is gone.
  useEffect(() => {
    return () => {
      drillTimers.current.forEach((id) => window.clearTimeout(id));
      drillTimers.current = [];
    };
  }, []);

  function transitionTo(next: DdilMode, options: { fromUI?: boolean } = {}) {
    const prev = useSpireStore.getState().ddilMode;
    if (prev === next) return;
    setDdilMode(next);
    if (prev === "DISCONNECTED" && next !== "DISCONNECTED") {
      // Defer the drain by a tick so the chip color flips first; the
      // operator sees the link come back, THEN the syncing overlay.
      window.setTimeout(() => { void drainDdilQueue({ setDrainTotal }); }, 150);
    }
    if (options.fromUI) {
      const labelByMode = Object.fromEntries(MODES.map((m) => [m.mode, m.label]));
      pushToast({
        tone: next === "CONNECTED" ? "ok" : next === "DISCONNECTED" ? "error" : "warn",
        text: `Comms ${labelByMode[next]} — ${MODE_DESC[next]}`,
        ttlMs: 4000,
      });
    }
  }

  function startDrill() {
    if (ddilDrillActive) return;
    setDdilDrillActive(true);
    pushToast({
      tone: "info",
      text: "DDIL drill engaged — 60-second SATCOM denial sequence",
      ttlMs: 4000,
    });
    let elapsed = 0;
    DRILL_STEPS.forEach((step, idx) => {
      const at = elapsed;
      const id = window.setTimeout(() => {
        transitionTo(step.mode);
        if (idx === DRILL_STEPS.length - 1) {
          // Last step is the return to CONNECTED; mark drill complete after
          // its dwell so the queue replay overlay can finish too.
          const finalId = window.setTimeout(() => {
            setDdilDrillActive(false);
          }, step.ms);
          drillTimers.current.push(finalId);
        }
      }, at);
      drillTimers.current.push(id);
      elapsed += step.ms;
    });
  }

  function abortDrill() {
    drillTimers.current.forEach((id) => window.clearTimeout(id));
    drillTimers.current = [];
    setDdilDrillActive(false);
    transitionTo("CONNECTED");
    pushToast({ tone: "info", text: "DDIL drill aborted — comms restored" });
  }

  // The chip — color-coded mode + queue-depth badge if anything is pending.
  return (
    <div ref={wrap} className="relative shrink-0">
      <Pressable
        onClick={() => setOpen((v) => !v)}
        block={false}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Comms ${current.label} — DDIL switcher`}
        title={`Comms ${current.label} · click to switch DDIL mode${queueDepth > 0 ? ` · ${queueDepth} write${queueDepth === 1 ? "" : "s"} queued` : ""}`}
        className="!min-h-0 inline-flex h-9 items-center gap-2 rounded-sm border px-2 font-mono text-xs uppercase tracking-wider transition-colors"
        style={{
          borderColor: current.tone,
          background:
            ddilMode === "CONNECTED"
              ? "transparent"
              : `color-mix(in oklab, ${current.tone} 15%, transparent)`,
          color: current.tone,
        }}
      >
        <span className="relative flex h-2 w-2" aria-hidden>
          {ddilMode !== "CONNECTED" && (
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
              style={{ background: current.tone }}
            />
          )}
          <span
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ background: current.tone }}
          />
        </span>
        <span className="text-[var(--color-text-muted)]">DDIL</span>
        <span className="font-semibold">{current.short}</span>
        {queueDepth > 0 && (
          <span
            className="ml-1 rounded-sm border px-1 text-[10px] tabular-nums tracking-wider"
            style={{
              borderColor: "color-mix(in oklab, var(--color-warning) 50%, transparent)",
              color: "var(--color-warning)",
              background: "color-mix(in oklab, var(--color-warning) 15%, transparent)",
            }}
            title={`${queueDepth} pending write${queueDepth === 1 ? "" : "s"} — replays on reconnect`}
          >
            Q{queueDepth}
          </span>
        )}
        {ddilDrillActive && (
          <span
            className="ml-1 rounded-sm border px-1 text-[10px] uppercase tracking-widest"
            style={{
              borderColor: "color-mix(in oklab, var(--color-primary) 50%, transparent)",
              color: "var(--color-primary)",
              background: "color-mix(in oklab, var(--color-primary) 18%, transparent)",
            }}
          >
            DRILL
          </span>
        )}
      </Pressable>

      {open && (
        <div
          role="menu"
          aria-label="DDIL mode menu"
          className="absolute right-0 top-[calc(100%+6px)] z-[8500] w-[22rem] rounded-md border border-[var(--color-border-active)] bg-[var(--color-surface)] p-3 shadow-2xl"
        >
          <div className="mb-2 flex items-baseline justify-between">
            <div className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-primary)]">
              DDIL · SATCOM denial drill
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              client-side simulation
            </div>
          </div>
          <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
            {MODE_DESC[ddilMode]}
          </p>

          {/* 4-state segmented switcher */}
          <div className="grid grid-cols-4 gap-1">
            {MODES.map((m) => {
              const active = m.mode === ddilMode;
              return (
                <Pressable
                  key={m.mode}
                  onClick={() => transitionTo(m.mode, { fromUI: true })}
                  block={false}
                  className={clsx(
                    "!min-h-0 flex h-9 flex-col items-center justify-center rounded-sm border px-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
                  )}
                  style={{
                    borderColor: active ? m.tone : "var(--color-border)",
                    background: active
                      ? `color-mix(in oklab, ${m.tone} 22%, transparent)`
                      : "var(--color-bg)",
                    color: active ? m.tone : "var(--color-text-secondary)",
                  }}
                  aria-pressed={active}
                  title={MODE_DESC[m.mode]}
                >
                  <span className="font-semibold">{m.short}</span>
                  <span className="text-[9px] opacity-80">{m.label}</span>
                </Pressable>
              );
            })}
          </div>

          {/* Drill button */}
          <div className="mt-3 flex items-center gap-2">
            {!ddilDrillActive ? (
              <Button
                variant="warning"
                size="sm"
                onClick={startDrill}
                title="Walk the four DDIL states on a 60s schedule (5s + 15s + 15s + 20s + 5s)"
              >
                ▶ Run DDIL drill (60s)
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={abortDrill}>
                ■ Abort drill
              </Button>
            )}
            <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              {ddilSyncing ? "SYNCING…" : queueDepth > 0 ? `${queueDepth} QUEUED` : "QUEUE EMPTY"}
            </span>
          </div>

          {/* Pending writes tray */}
          <div className="mt-3 border-t border-[var(--color-border)] pt-2">
            <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              Pending writes ({queueDepth})
            </div>
            {queueDepth === 0 ? (
              <div className="rounded-sm border border-dashed border-[var(--color-border)] p-2 text-center font-mono text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
                no queued writes
              </div>
            ) : (
              <div className="max-h-44 overflow-y-auto">
                <ul className="flex flex-col gap-1">
                  {ddilQueue.map((w) => (
                    <li
                      key={w.id}
                      className="flex items-center justify-between gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 font-mono text-[11px] tracking-wide"
                    >
                      <span
                        className="rounded-sm border border-[color-mix(in_oklab,var(--color-warning)_45%,transparent)] px-1 text-[10px] font-semibold tracking-wider text-[var(--color-warning)]"
                      >
                        {w.method}
                      </span>
                      <span className="flex-1 truncate text-[var(--color-text)]" title={`${w.method} ${w.path} · queued ${w.queuedAt} by ${w.actor}`}>
                        {w.path}
                      </span>
                      <span className="text-[10px] uppercase text-[var(--color-text-muted)]">
                        {w.actor}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {ddilSyncing && <SyncingOverlay queueAtStart={drainTotal} />}
      {!ddilSyncing && (ddilMode === "DISCONNECTED" || ddilMode === "LIMITED") && (
        <ModeOverlay mode={ddilMode} queueDepth={queueDepth} />
      )}
    </div>
  );
}

// Lightweight global hint that hangs below the topbar whenever the
// operator is in a non-CONNECTED, non-syncing state. Tells them at a
// glance that what they're reading isn't live (DISCONNECTED → cached) or
// that requests are slow (LIMITED → high latency). Pointer-events off so
// it never blocks clicks underneath.
function ModeOverlay({ mode, queueDepth }: { mode: DdilMode; queueDepth: number }) {
  const lastCacheHit = useSpireStore((s) => s.ddilLastCacheHit);
  // Tick once a minute so the "n minutes stale" label updates without
  // a re-render storm.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (mode !== "DISCONNECTED") return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [mode]);

  const isDisc = mode === "DISCONNECTED";
  const tone = isDisc ? "var(--color-danger)" : "var(--color-warning)";
  const label = isDisc ? "CACHED · COMMS DENIED" : "HIGH LATENCY · 800–2000MS";
  let detail: string;
  if (isDisc) {
    const stalePart = lastCacheHit
      ? ` · ${formatStale(Date.now() - lastCacheHit.cachedAt)} stale (cached ${formatClock(lastCacheHit.cachedAt)})`
      : "";
    const queuePart = queueDepth > 0
      ? ` · ${queueDepth} write${queueDepth === 1 ? "" : "s"} queued for replay`
      : "";
    detail = `Reading last-known-good cache${stalePart}${queuePart}`;
  } else {
    detail = "Every API call is slowed to demo a degraded SATCOM lane";
  }
  return (
    <div
      className="fixed inset-x-0 top-14 z-[8400] pointer-events-none flex justify-center"
      role="status"
      aria-live="polite"
    >
      <div
        className="pointer-events-none flex items-center gap-2 rounded-b-md border border-t-0 px-3 py-1 font-mono text-[11px] uppercase tracking-widest"
        style={{
          color: tone,
          background: `color-mix(in oklab, ${tone} 14%, var(--color-surface))`,
          borderColor: tone,
        }}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: tone }} />
        <span className="font-semibold">{label}</span>
        <span className="text-[var(--color-text-secondary)] tracking-wide">· {detail}</span>
      </div>
    </div>
  );
}

// Visible "syncing" beacon while the drain runs. Mounted as a thin
// top-of-viewport bar so it's noticed without stealing attention from the
// main work surface.
function SyncingOverlay({ queueAtStart }: { queueAtStart: number }) {
  const ddilQueue = useSpireStore((s) => s.ddilQueue);
  const remaining = ddilQueue.length;
  const total = Math.max(queueAtStart, remaining);
  const done = total - remaining;
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  return (
    <div
      className="fixed inset-x-0 top-14 z-[8400] pointer-events-none flex justify-center"
      role="status"
      aria-live="polite"
    >
      <div
        className="pointer-events-none flex items-center gap-3 rounded-b-md border border-t-0 border-[var(--color-primary)] bg-[var(--color-surface)] px-4 py-2 font-mono text-xs uppercase tracking-wider shadow-2xl"
        style={{
          color: "var(--color-primary)",
          background: "color-mix(in oklab, var(--color-primary) 12%, var(--color-surface))",
        }}
      >
        <span className="relative flex h-2 w-2" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-primary)] opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--color-primary)]" />
        </span>
        <span>Syncing queued writes</span>
        <span className="tabular-nums">{done}/{total}</span>
        <span className="h-1.5 w-32 overflow-hidden rounded-sm bg-[var(--color-bg)]">
          <span
            className="block h-full transition-all"
            style={{ width: `${pct}%`, background: "var(--color-primary)" }}
          />
        </span>
      </div>
    </div>
  );
}
