/**
 * SystemStatusChip — consolidated system-health pill for the TopBar right
 * group. Replaces three separate chips (NodeStatus, GcssMcSyncPill,
 * ModeBadge) with a single dot + 3-segment label.
 *
 * Sub-statuses:
 *  - SYNC: distributed sync state vs the peer node (gated on ops roles +
 *    security_manager — same gate as the legacy NodeStatus chip).
 *  - GCSS: GCSS-MC reference adapter freshness (REF tag stays — the link
 *    is mocked).
 *  - MODE: backend mode (LIVE / LITE) — mirrors operatingMode from store.
 *
 * Combined health drives the leading dot:
 *   green  — every sub-status all-clear.
 *   amber  — any sub-status degraded (REF, behind/ahead, lite mode).
 *   red    — any sub-status down (sync conflict, gcss unreachable).
 *
 * Click opens a panel that shows each sub-status' full label + last poll
 * time + a primary action. Conflict resolution drawer is kept here so the
 * security manager can drill from the chip into the resolution UI in two
 * clicks (chip → "Resolve conflicts" → drawer), preserving the parity the
 * old NodeStatus drawer offered.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  api,
  type GcssMcLastSync,
  type SyncConflict,
  type SyncStateResponse,
} from "../api";
import { formatApiError, pollWithBackoff } from "../api-retry";
import { useSpireStore, type Role } from "../state/store";
import { Button, IconButton, Pressable } from "./ui";
import { ClockCard, ConflictRow } from "./NodeStatus";

const SYNC_VISIBLE_ROLES: ReadonlySet<Role> = new Set<Role>([
  "security_manager",
  "mef_commander",
  "g4",
]);

const CMP_LABEL: Record<string, string> = {
  equal: "IN SYNC",
  before: "BEHIND",
  after: "AHEAD",
  concurrent: "CONFLICT",
  no_peer_data: "SOLO",
};

const CMP_TONE: Record<string, "ok" | "warn" | "down" | "info"> = {
  equal: "ok",
  before: "warn",
  after: "warn",
  concurrent: "down",
  no_peer_data: "info",
};

const TONE_COLOR: Record<"ok" | "warn" | "down" | "info", string> = {
  ok: "var(--color-success)",
  warn: "var(--color-warning)",
  down: "var(--color-danger)",
  info: "var(--color-text-muted)",
};

function combineTones(tones: ("ok" | "warn" | "down" | "info")[]): "ok" | "warn" | "down" {
  if (tones.includes("down")) return "down";
  if (tones.includes("warn")) return "warn";
  return "ok";
}

function formatAgeShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

function formatClock(ts: number | null): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}

export function SystemStatusChip() {
  const role = useSpireStore((s) => s.role);
  const operatingMode = useSpireStore((s) => s.operatingMode);
  const pushToast = useSpireStore((s) => s.pushToast);
  const nav = useNavigate();

  const syncVisible = SYNC_VISIBLE_ROLES.has(role);

  const [syncState, setSyncState] = useState<SyncStateResponse | null>(null);
  const [syncConflicts, setSyncConflicts] = useState<SyncConflict[]>([]);
  const [syncPolledAt, setSyncPolledAt] = useState<number | null>(null);

  const [gcss, setGcss] = useState<GcssMcLastSync | null>(null);
  const [gcssUnreachable, setGcssUnreachable] = useState<boolean>(false);
  const [gcssPolledAt, setGcssPolledAt] = useState<number | null>(null);

  const [open, setOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);

  // Sync poll — same back-off as the legacy chip. Gated by role visibility
  // so a maintenance_chief identity doesn't pull data they can't act on.
  useEffect(() => {
    if (!syncVisible) return;
    const ctrl = pollWithBackoff(
      async () => {
        const [s, c] = await Promise.all([
          api.system.syncState(),
          api.system.syncConflicts(),
        ]);
        return { s, c };
      },
      {
        baseMs: 5000,
        maxMs: 60000,
        fingerprint: ({ s, c }) =>
          `${s.compare}|${s.events_logged}|${c.pending.length}|${c.pending.map((x) => x.id).join(",")}`,
        onResult: ({ s, c }) => {
          setSyncState(s);
          setSyncConflicts(c.pending);
          setSyncPolledAt(Date.now());
        },
      },
    );
    return () => ctrl.stop();
  }, [syncVisible]);

  // GCSS-MC sync poll — every 7s, same as legacy GcssMcSyncPill.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function tick() {
      try {
        const r = await api.system.gcssMcLastSync();
        if (cancelled) return;
        setGcss(r);
        setGcssUnreachable(false);
        setGcssPolledAt(Date.now());
      } catch {
        if (cancelled) return;
        setGcssUnreachable(true);
        setGcssPolledAt(Date.now());
      } finally {
        if (!cancelled) timer = setTimeout(tick, 7000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Click-outside / Escape on the dropdown panel.
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

  // Lock body scroll while the conflicts drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const prior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prior;
    };
  }, [drawerOpen]);

  // Sub-status derivations.
  const syncTone: "ok" | "warn" | "down" | "info" = syncVisible && syncState
    ? CMP_TONE[syncState.compare] ?? "info"
    : "info";
  const syncShort = syncVisible && syncState
    ? CMP_LABEL[syncState.compare] ?? "—"
    : "—";

  const gcssTone: "ok" | "warn" | "down" | "info" = gcssUnreachable
    ? "down"
    : gcss?.environment === "REFERENCE_IMPLEMENTATION"
      ? "warn"
      : "ok";
  const gcssShort = gcssUnreachable
    ? "GCSS DOWN"
    : gcss?.environment === "REFERENCE_IMPLEMENTATION"
      ? "GCSS REF"
      : gcss
        ? "GCSS LIVE"
        : "GCSS …";

  const modeTone: "ok" | "warn" = operatingMode === "full" ? "ok" : "warn";
  const modeShort = operatingMode === "full" ? "LIVE" : "LITE";

  const tones = syncVisible ? [syncTone, gcssTone, modeTone] : [gcssTone, modeTone];
  const combined = combineTones(tones);
  const dotColor = TONE_COLOR[combined];

  const conflictCount = syncConflicts.length;
  const ariaSummary = `System status — ${combined === "ok" ? "all clear" : combined === "warn" ? "degraded" : "down"}. ${
    syncVisible ? `Sync ${syncShort.toLowerCase()}, ` : ""
  }${gcssShort.replace("GCSS", "GCSS-MC").toLowerCase()}, backend ${modeShort.toLowerCase()}.${
    conflictCount > 0 ? ` ${conflictCount} sync conflict${conflictCount === 1 ? "" : "s"} pending.` : ""
  }`;

  const labelSegments = syncVisible
    ? [syncShort, gcssShort, modeShort]
    : [gcssShort, modeShort];

  async function refreshSync() {
    try {
      const [s, c] = await Promise.all([
        api.system.syncState(),
        api.system.syncConflicts(),
      ]);
      setSyncState(s);
      setSyncConflicts(c.pending);
      setSyncPolledAt(Date.now());
    } catch (e) {
      console.warn("sync refresh failed", e);
    }
  }

  async function resolveConflict(id: string, winner: "local" | "peer") {
    try {
      await api.system.syncResolve(id, winner, role);
      pushToast({
        tone: "ok",
        text: `Conflict resolved · ${winner} write wins · loser preserved in audit chain`,
        ttlMs: 5000,
      });
      await refreshSync();
    } catch (e) {
      pushToast({ tone: "error", text: `Resolve failed: ${formatApiError(e)}` });
    }
  }

  async function seedConflict() {
    try {
      const c = await api.system.syncSeedConflict(role);
      if (!c || !c.id || !c.detected_at || !c.local_event || !c.peer_event) {
        pushToast({ tone: "error", text: "Seed returned an incomplete conflict — check backend logs" });
        return;
      }
      setSyncConflicts((prev) => [...prev.filter((x) => x.id !== c.id), c]);
      await refreshSync();
      pushToast({ tone: "info", text: "Demo conflict seeded · vector clocks refreshed", ttlMs: 4500 });
    } catch (e) {
      pushToast({ tone: "error", text: `Seed failed: ${formatApiError(e)}` });
    }
  }

  return (
    <div ref={wrap} className="relative shrink-0">
      <Pressable
        onClick={() => setOpen((v) => !v)}
        block={false}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaSummary}
        title={ariaSummary}
        data-testid="system-status-chip"
        className="!min-h-0 inline-flex h-9 shrink-0 items-center gap-2 rounded-sm border bg-[var(--color-surface)] px-2 font-mono text-[11px] uppercase tracking-widest transition-colors hover:border-[var(--color-primary)]"
        style={{
          borderColor:
            combined === "ok"
              ? "var(--color-border)"
              : `color-mix(in oklab, ${dotColor} 50%, var(--color-border))`,
          background:
            combined === "down"
              ? "color-mix(in oklab, var(--color-danger-muted) 22%, var(--color-surface))"
              : combined === "warn"
                ? "color-mix(in oklab, var(--color-warning-muted) 14%, var(--color-surface))"
                : "var(--color-surface)",
        }}
      >
        {/* Ping animation reserved for `down` (actual outage). The
         * `warn` state covers steady-state conditions like running
         * against the GCSS-MC reference implementation or LITE mode —
         * those are honest signals but not urgent, so a static dot
         * communicates posture without pulsing in the operator's
         * peripheral vision. */}
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          {combined === "down" && (
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-50"
              style={{ background: dotColor }}
            />
          )}
          <span
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ background: dotColor }}
          />
        </span>
        {/* The label only renders at 2xl+ so the chip stays a tight icon
         * pill at the cramped 1024–1535 range and expands gracefully on
         * the wide displays the spec calls out (1920+). */}
        <span
          className="hidden 2xl:inline-flex items-center gap-1.5 text-[var(--color-text-secondary)]"
          aria-hidden
        >
          {labelSegments.map((seg, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-[var(--color-text-muted)]">·</span>}
              <span
                className={
                  seg === labelSegments[0] ? "font-semibold" : ""
                }
                style={{
                  color:
                    seg === gcssShort && gcssTone !== "ok"
                      ? TONE_COLOR[gcssTone]
                      : seg === modeShort && modeTone !== "ok"
                        ? TONE_COLOR[modeTone]
                        : seg === syncShort && syncTone !== "ok" && syncTone !== "info"
                          ? TONE_COLOR[syncTone]
                          : "var(--color-text-secondary)",
                }}
              >
                {seg}
              </span>
            </span>
          ))}
        </span>
        {conflictCount > 0 && (
          <span
            className="rounded-sm border border-[var(--color-danger)] px-1 text-[10px] font-semibold tabular-nums tracking-wider"
            style={{ color: "var(--color-danger)" }}
            aria-label={`${conflictCount} sync conflicts pending`}
          >
            {conflictCount}
          </span>
        )}
      </Pressable>

      {open && (
        <div
          role="menu"
          aria-label="System status detail"
          data-testid="system-status-panel"
          className="absolute right-0 top-[calc(100%+6px)] z-[8500] w-[22rem] rounded-md border border-[var(--color-border-active)] bg-[var(--color-surface)] p-3 shadow-2xl"
        >
          <div className="mb-2 flex items-baseline justify-between">
            <div className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-primary)]">
              System status
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
              consolidated
            </div>
          </div>

          {syncVisible && (
            <StatusRow
              label="Sync"
              value={
                syncState
                  ? `${syncState.node_id} · ${CMP_LABEL[syncState.compare] ?? syncState.compare}`
                  : "polling…"
              }
              tone={syncTone}
              polledAt={syncPolledAt}
              extra={
                conflictCount > 0
                  ? `${conflictCount} conflict${conflictCount === 1 ? "" : "s"} pending`
                  : syncState
                    ? `${syncState.events_logged} events logged · peer ${syncState.peer_node_id}`
                    : null
              }
              action={
                syncState ? (
                  <Button
                    size="sm"
                    variant={conflictCount > 0 ? "warning" : "secondary"}
                    onClick={() => {
                      setOpen(false);
                      setDrawerOpen(true);
                    }}
                    data-testid="system-status-open-conflicts"
                  >
                    {conflictCount > 0 ? `Resolve (${conflictCount})` : "Open drawer"}
                  </Button>
                ) : null
              }
            />
          )}

          <StatusRow
            label="GCSS-MC"
            value={
              gcssUnreachable
                ? "STALE — backend unreachable"
                : gcss
                  ? `synced ${formatAgeShort(gcss.age_seconds)} ago`
                  : "polling…"
            }
            tone={gcssTone}
            polledAt={gcssPolledAt}
            extra={
              gcss?.environment === "REFERENCE_IMPLEMENTATION"
                ? "Reference implementation — connection is mocked"
                : null
            }
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setOpen(false);
                  nav("/integrations/gcss-mc");
                }}
              >
                Contract
              </Button>
            }
          />

          <StatusRow
            label="Backend"
            value={operatingMode === "full" ? "Local backend online" : "Lite mode — reduced features"}
            tone={modeTone}
            polledAt={null}
            extra={null}
            action={null}
          />

          {/* "Mission timeline" fallback row for the cramped breakpoints
           * where the full MissionClock is hidden. The compact chip is
           * already in the right group below xl, but the dropdown row gives
           * the operator a second discoverable entry. */}
          <MissionTimelineRow onClose={() => setOpen(false)} />
        </div>
      )}

      {drawerOpen && syncState && (
        <div
          className="fixed inset-0 z-[8800] flex items-start justify-end bg-black/40 backdrop-blur-sm"
          onClick={() => setDrawerOpen(false)}
          role="presentation"
        >
          <div
            className="m-4 flex w-[34rem] max-h-[90vh] flex-col gap-3 overflow-y-auto rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Distributed sync drawer"
          >
            <div className="flex items-baseline justify-between">
              <div>
                <div className="font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
                  Distributed Sync
                </div>
                <div className="mt-0.5 font-mono text-lg font-semibold text-[var(--color-text)] tracking-wide">
                  {syncState.node_id} ↔ {syncState.peer_node_id}
                </div>
                <div className="mt-1 spire-body-muted text-sm">
                  Vector-clock-based reconciliation. Loser-preserving last-writer-wins on conflict.
                </div>
              </div>
              <IconButton onClick={() => setDrawerOpen(false)} aria-label="Close sync drawer">
                ✕
              </IconButton>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <ClockCard title={`Local · ${syncState.node_id}`} clock={syncState.local_clock} />
              <ClockCard title={`Peer · ${syncState.peer_node_id}`} clock={syncState.peer_clock} />
            </div>

            <div className="flex items-center gap-2">
              <span
                className="rounded-sm border px-2 py-[2px] font-mono text-xs font-semibold uppercase tracking-widest"
                style={{
                  color: dotColor,
                  borderColor: `color-mix(in oklab, ${dotColor} 40%, var(--color-border))`,
                  background: `color-mix(in oklab, ${dotColor} 12%, transparent)`,
                }}
              >
                {CMP_LABEL[syncState.compare] ?? syncState.compare}
              </span>
              <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
                {syncState.events_logged} events logged
              </span>
              <Button
                onClick={seedConflict}
                variant="warning"
                size="sm"
                className="ml-auto"
                title="Inject a deliberate conflict for demo / training"
              >
                Seed Demo Conflict
              </Button>
            </div>

            <div>
              <div className="mb-2 font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
                Pending conflicts ({conflictCount})
              </div>
              {conflictCount === 0 && (
                <div className="rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
                  NO CONFLICTS — clocks reconciled
                </div>
              )}
              <div className="flex flex-col gap-2">
                {syncConflicts.map((c) => (
                  <ConflictRow key={c.id} conflict={c} onResolve={resolveConflict} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusRow({
  label,
  value,
  tone,
  polledAt,
  extra,
  action,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "down" | "info";
  polledAt: number | null;
  extra: string | null;
  action: React.ReactNode;
}) {
  const color = TONE_COLOR[tone];
  return (
    <div className="mb-2 flex items-start gap-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <span
        className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
            {label}
          </span>
          {polledAt != null && (
            <span className="font-mono text-[10px] tabular-nums text-[var(--color-text-muted)]">
              · polled {formatClock(polledAt)}
            </span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-xs tracking-wide" style={{ color }}>
          {value}
        </div>
        {extra && (
          <div className="mt-0.5 font-mono text-[11px] text-[var(--color-text-secondary)] tracking-wide">
            {extra}
          </div>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// Surface the live mission-clock state inside the System chip dropdown so
// at the cramped sm viewport, where MissionClock is hidden entirely, the
// operator still has a one-click path to the timeline.
function MissionTimelineRow({ onClose }: { onClose: () => void }) {
  const offsetLabel = useSpireStore((s) => s.scenarioOffsetLabel);
  const phase = useSpireStore((s) => s.scenarioPhase);
  const running = useSpireStore((s) => s.scenarioRunning);
  const rate = useSpireStore((s) => s.scenarioRate);
  return (
    <div className="mt-2 flex items-center gap-3 rounded-sm border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] p-2">
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: running ? "var(--color-primary)" : "var(--color-text-muted)" }}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
          Mission timeline
        </div>
        <div className="mt-0.5 font-mono text-xs tabular-nums tracking-wide text-[var(--color-text)]">
          {offsetLabel} · {phase} · {running ? `running ${rate}×` : "paused"}
        </div>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          onClose();
          // Bubble a custom event so the MissionClock chip (when mounted)
          // can pop its own dropdown. Falls through silently when the chip
          // isn't mounted (sm viewport).
          window.dispatchEvent(new CustomEvent("spire:open-mission-clock"));
        }}
      >
        Controls
      </Button>
    </div>
  );
}
