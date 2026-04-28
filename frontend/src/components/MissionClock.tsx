/**
 * MissionClock — H+HHH:MM topbar element + scenario phase pill + operator
 * playback controls (B4).
 *
 * The clock is the single source of "what time is it in the war game."
 * Every view that wants to render a phase-aware overlay reads from the
 * Zustand store (`scenarioOffsetMin`, `scenarioPhase`, …) — this component
 * is the only writer.
 *
 * Polls `/api/system/scenario/state` at 1Hz when paused or running 1×, and
 * 4Hz when running at 4×/16× so the displayed minute keeps up with the
 * compressed timeline. Newly-fired events are dispatched as
 * `spire:scenario-event` window events so downstream lanes (B3 blood
 * vignette, A1 scenario engine) can subscribe without coupling.
 *
 * Operator controls (play/pause/speed/reset) are visible only to roles in
 * SCENARIO_OPERATOR_ROLES — matches the backend gate. Other identities see
 * a read-only display.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { api, ApiError, type ScenarioControlAction, type ScenarioState } from "../api";
import { useSpireStore, type Role } from "../state/store";
import { Pressable, useIdempotentAction } from "./ui";

// Operator-class identities that may pilot the demo clock. Mirror of the
// backend SCENARIO_CONTROL_ROLES; FE shows the controls only when the
// authenticated role is in this set so judges using a maintenance_chief
// identity don't see disabled chrome they can't act on.
const SCENARIO_OPERATOR_ROLES: ReadonlySet<Role> = new Set<Role>([
  "mef_commander",
  "g4",
  "security_manager",
]);

// Colour the phase pill so the four phases read at a glance — neutral
// during pre-conflict, warming through initial action and crisis, cooling
// back down for recovery. Mirrors the FPCON tone palette used elsewhere
// so the chrome feels consistent.
const PHASE_TONE: Record<string, { fg: string; bg: string }> = {
  "Pre-conflict":       { fg: "var(--color-text-secondary)", bg: "color-mix(in oklab, var(--color-surface) 90%, var(--color-bg))" },
  "Initial action":     { fg: "var(--color-warning)",        bg: "color-mix(in oklab, var(--color-warning-muted) 25%, var(--color-bg))" },
  "Sustainment crisis": { fg: "var(--color-danger)",         bg: "color-mix(in oklab, var(--color-danger-muted) 30%, var(--color-bg))" },
  "Recovery":           { fg: "var(--color-success)",        bg: "color-mix(in oklab, var(--color-success-muted) 25%, var(--color-bg))" },
};

function tone(phase: string) {
  return PHASE_TONE[phase] ?? PHASE_TONE["Pre-conflict"];
}

export function MissionClock() {
  const role = useSpireStore((s) => s.role);
  const setScenario = useSpireStore((s) => s.setScenario);
  const pushToast = useSpireStore((s) => s.pushToast);

  const offsetLabelRaw = useSpireStore((s) => s.scenarioOffsetLabel);
  const phaseRaw = useSpireStore((s) => s.scenarioPhase);
  const running = useSpireStore((s) => s.scenarioRunning);
  const rate = useSpireStore((s) => s.scenarioRate);
  const offsetMin = useSpireStore((s) => s.scenarioOffsetMin);
  const maxOffsetMin = useSpireStore((s) => s.scenarioMaxOffsetMin);
  // QA #47 — until /scenario/state hydrates the store on a freshly
  // mounted view we must not display the seed defaults (H+000:00 /
  // Pre-conflict). Otherwise a route change makes the clock appear to
  // jump from H+0 to whatever the backend's actual offset is the
  // moment the first poll resolves. Show "—" placeholders instead so
  // the chip reads as "loading" rather than "we are at H+0."
  const scenarioLoaded = useSpireStore((s) => s.scenarioLoaded);
  const offsetLabel = scenarioLoaded ? offsetLabelRaw : "H+—";
  const phase = scenarioLoaded ? phaseRaw : "Loading";

  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  // Track which event ids we've already fanned out as window events so a
  // jittery /state poll doesn't emit duplicates.
  const dispatched = useRef<Set<string>>(new Set());
  const isOperator = SCENARIO_OPERATOR_ROLES.has(role);

  // Polling — 1Hz baseline, 4Hz when fast-forwarding so the displayed
  // minute keeps up with compressed scenario time. The backend computes
  // the offset on demand, so missing a tick doesn't lose state.
  useEffect(() => {
    let alive = true;
    let timer: number | null = null;

    async function tick() {
      try {
        const s = await api.system.scenarioState();
        if (!alive) return;
        applyScenarioState(s);
      } catch (e) {
        // Tolerant — auth failures redirect via the unauthenticated handler;
        // anything else is a transient backend hiccup that the next poll
        // will recover from. Don't toast on every tick.
        if (e instanceof ApiError && e.status !== 401) {
          // No-op; the StatusFooter already surfaces backend health.
        }
      } finally {
        if (alive) {
          const intervalMs = (running && rate >= 4) ? 250 : 1000;
          timer = window.setTimeout(tick, intervalMs);
        }
      }
    }

    tick();
    return () => {
      alive = false;
      if (timer != null) window.clearTimeout(timer);
    };
    // Re-poll cadence is driven by running/rate so a flip from 1× → 16×
    // tightens the loop immediately. Not depending on `setScenario` — it's
    // a stable Zustand action that never changes identity in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, rate]);

  function applyScenarioState(s: ScenarioState) {
    const firedIds = s.fired_events.map((e) => e.event_id);
    setScenario({
      running: s.running,
      rate: s.rate,
      offsetMin: s.offset_min,
      offsetLabel: s.offset_label,
      phase: s.phase,
      maxOffsetMin: s.max_offset_min,
      firedEventIds: firedIds,
    });
    // Fan out newly-fired events as window events so other lanes can
    // subscribe without importing this component or coupling to its
    // polling cadence.
    for (const ev of s.fired_events) {
      if (dispatched.current.has(ev.event_id)) continue;
      dispatched.current.add(ev.event_id);
      try {
        window.dispatchEvent(
          new CustomEvent("spire:scenario-event", {
            detail: {
              event_id: ev.event_id,
              offset_min: ev.offset_min,
              fired_at_offset: ev.fired_at_offset,
              fired_wall: ev.fired_wall,
              title: ev.title,
              phase: s.phase,
              payload: ev.payload,
            },
          }),
        );
      } catch {
        /* tolerant */
      }
    }
  }

  // Click-outside + Escape close for the controls dropdown.
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

  const controlAction = useIdempotentAction(
    "scenario:control",
    async (
      action: ScenarioControlAction,
      opts: { rate?: number; offset_min?: number } = {},
    ) => {
      try {
        const s = await api.system.scenarioControl(action, opts);
        applyScenarioState(s);
      } catch (e) {
        const msg = e instanceof ApiError && typeof e.body === "object" && e.body && "detail" in (e.body as Record<string, unknown>)
          ? String((e.body as Record<string, unknown>).detail)
          : (e as Error).message;
        pushToast({ tone: "error", text: `Mission clock: ${action} failed — ${msg}` });
      }
    },
    { lockoutMs: 250 },
  );

  const t = tone(phase);
  const pct = Math.max(0, Math.min(1, offsetMin / Math.max(1, maxOffsetMin))) * 100;

  return (
    <div
      ref={wrap}
      className="pointer-events-auto relative flex shrink-0 items-stretch"
      role="region"
      aria-label="Mission clock and scenario phase"
    >
      <Pressable
        onClick={() => isOperator && setOpen((v) => !v)}
        block={false}
        disabled={!isOperator}
        aria-haspopup={isOperator ? "menu" : undefined}
        aria-expanded={isOperator ? open : undefined}
        aria-label={`Mission clock ${offsetLabel}, phase ${phase}${running ? `, running ${rate}×` : ", paused"}${isOperator ? " — click for controls" : ""}`}
        title={
          isOperator
            ? `Scenario time ${offsetLabel} · ${phase} · ${running ? `running ${rate}×` : "paused"} — click for controls`
            : `Scenario time ${offsetLabel} · ${phase} · ${running ? `running ${rate}×` : "paused"}`
        }
        className="!min-h-0 group flex h-11 items-center gap-2 rounded-sm border border-[var(--color-border-active)] bg-[color-mix(in_oklab,var(--color-surface)_92%,var(--color-bg))] px-2.5 font-mono text-xs uppercase tracking-wider text-[var(--color-text)] transition-colors hover:border-[var(--color-primary)] disabled:cursor-default"
      >
        {/* Tiny play/pause indicator dot — pulses while running so the
         * operator can see at a glance whether the clock is advancing. */}
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          {running && (
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
              style={{ background: "var(--color-primary)" }}
            />
          )}
          <span
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ background: running ? "var(--color-primary)" : "var(--color-text-muted)" }}
          />
        </span>
        <div className="flex flex-col items-start leading-tight">
          <span className="text-[10px] tracking-widest text-[var(--color-text-muted)]">
            Mission Clock {running && rate > 1 ? `· ${rate}×` : ""}
          </span>
          <span className="font-semibold tabular-nums text-[13px] tracking-wide text-[var(--color-text)]">
            {offsetLabel}
          </span>
        </div>
        <span
          className="ml-1 hidden h-7 items-center gap-1 rounded-sm border px-2 font-mono text-[10px] font-semibold uppercase tracking-widest md:inline-flex"
          style={{
            color: t.fg,
            background: t.bg,
            borderColor: `color-mix(in oklab, ${t.fg} 40%, var(--color-border))`,
          }}
        >
          {phase}
        </span>
        {isOperator && (
          <svg
            className={clsx(
              "ml-0.5 h-3 w-3 shrink-0 text-[var(--color-text-muted)] transition-transform",
              open && "rotate-180",
            )}
            viewBox="0 0 12 12"
            fill="currentColor"
            aria-hidden
          >
            <path d="M2 4l4 4 4-4H2z" />
          </svg>
        )}
      </Pressable>

      {/* Sub-pixel progress bar — unobtrusive but lets the operator see how
       * far through the scripted timeline we are without opening the
       * dropdown. Anchored to the bottom edge of the chip. */}
      <div
        className="pointer-events-none absolute -bottom-px left-1 right-1 h-px overflow-hidden"
        aria-hidden
      >
        <div
          className="h-full transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%`, background: t.fg, opacity: 0.7 }}
        />
      </div>

      {open && isOperator && (
        <div
          role="menu"
          aria-label="Mission clock controls"
          className="absolute left-1/2 top-[calc(100%+6px)] z-[8500] w-72 -translate-x-1/2 rounded-md border border-[var(--color-border-active)] bg-[var(--color-surface)] p-3 shadow-2xl"
        >
          <div
            className="mb-2 flex items-center justify-between font-mono uppercase text-[var(--color-text-muted)]"
            style={{ fontSize: "10px", letterSpacing: "var(--tracking-widest)" }}
          >
            <span>Scenario Control</span>
            <span className="text-[var(--color-text-secondary)] tabular-nums">{offsetLabel}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Pressable
              role="menuitem"
              onClick={() => controlAction.run(running ? "pause" : "play")}
              block={false}
              disabled={controlAction.pending}
              className="!min-h-0 flex h-9 items-center justify-center gap-1.5 rounded-sm border border-[var(--color-border-active)] bg-[var(--color-bg)] font-mono text-xs uppercase tracking-widest text-[var(--color-text)] hover:border-[var(--color-primary)]"
            >
              {running ? "❚❚ Pause" : "▶ Play"}
            </Pressable>
            <Pressable
              role="menuitem"
              onClick={() => controlAction.run("reset")}
              block={false}
              disabled={controlAction.pending}
              className="!min-h-0 flex h-9 items-center justify-center gap-1.5 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] font-mono text-xs uppercase tracking-widest text-[var(--color-text-secondary)] hover:border-[var(--color-warning)] hover:text-[var(--color-warning)]"
              title="Reset clock to H+0 (paused) and clear fired events"
            >
              ⟲ Reset
            </Pressable>
          </div>
          <div
            className="mt-3 mb-1 font-mono uppercase text-[var(--color-text-muted)]"
            style={{ fontSize: "10px", letterSpacing: "var(--tracking-widest)" }}
          >
            Speed
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[1, 4, 16].map((r) => (
              <Pressable
                key={r}
                role="menuitemradio"
                aria-checked={rate === r}
                onClick={() => controlAction.run("set_rate", { rate: r })}
                block={false}
                disabled={controlAction.pending}
                className={clsx(
                  "!min-h-0 flex h-8 items-center justify-center rounded-sm border font-mono text-xs font-semibold uppercase tracking-widest transition-colors",
                  rate === r
                    ? "border-[var(--color-primary)] bg-[color-mix(in_oklab,var(--color-primary)_15%,var(--color-surface))] text-[var(--color-primary)]"
                    : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-secondary)] hover:border-[var(--color-border-active)] hover:text-[var(--color-text)]",
                )}
              >
                {r}×
              </Pressable>
            ))}
          </div>
          <div
            className="mt-3 mb-1 font-mono uppercase text-[var(--color-text-muted)]"
            style={{ fontSize: "10px", letterSpacing: "var(--tracking-widest)" }}
          >
            Jump to phase
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "H+0",  off: 0,        sub: "Pre-conflict" },
              { label: "H+24", off: 24 * 60,  sub: "Initial action" },
              { label: "H+48", off: 48 * 60,  sub: "Sustainment" },
              { label: "H+72", off: 72 * 60,  sub: "Recovery" },
            ].map((stop) => (
              <Pressable
                key={stop.off}
                role="menuitem"
                onClick={() => controlAction.run("seek", { offset_min: stop.off })}
                block={false}
                disabled={controlAction.pending}
                className="!min-h-0 flex h-10 flex-col items-center justify-center rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-primary)] hover:text-[var(--color-text)]"
                title={`Seek to ${stop.label} (${stop.sub})`}
              >
                <span className="font-semibold text-[var(--color-text)] tabular-nums">{stop.label}</span>
                <span className="text-[9px] text-[var(--color-text-muted)] tracking-wider">{stop.sub}</span>
              </Pressable>
            ))}
          </div>
          <div
            className="mt-3 border-t border-[var(--color-border)] pt-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]"
          >
            Scripted events fire at H+24 / H+48 / H+72.
          </div>
        </div>
      )}
    </div>
  );
}
