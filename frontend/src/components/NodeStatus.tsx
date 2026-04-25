/**
 * NodeStatus — GC-2 distributed-consensus indicator + conflict resolution.
 *
 * Mounted in the TopBar. Shows this node's identity (e.g. MLG-NODE-0)
 * + sync state vs the peer + pending-conflict count. Click the chip to
 * open the conflict resolution drawer.
 *
 * In the demo, "Seed conflict" injects a deliberate concurrent edit so
 * the CWO can walk through the resolution flow. In production this is
 * replaced by gossip-driven sync against real peer nodes.
 */
import { useEffect, useState } from "react";
import {
  api,
  type SyncStateResponse,
  type SyncConflict,
} from "../api";
import { useSpireStore } from "../state/store";

const CMP_COLOR: Record<string, string> = {
  equal: "var(--color-success)",
  before: "var(--color-info)",
  after: "var(--color-warning)",
  concurrent: "var(--color-danger)",
  no_peer_data: "var(--color-text-muted)",
};

const CMP_LABEL: Record<string, string> = {
  equal: "IN SYNC",
  before: "BEHIND",
  after: "AHEAD",
  concurrent: "CONFLICT",
  no_peer_data: "NO PEER",
};

export function NodeStatus() {
  const role = useSpireStore((s) => s.role);
  const pushToast = useSpireStore((s) => s.pushToast);
  const [state, setState] = useState<SyncStateResponse | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [open, setOpen] = useState(false);

  // Only show for ops roles + security manager.
  const visible = ["security_manager", "mef_commander", "g4"].includes(role);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    async function fetchAll() {
      try {
        const [s, c] = await Promise.all([
          api.system.syncState(),
          api.system.syncConflicts(),
        ]);
        if (!alive) return;
        setState(s);
        setConflicts(c.pending);
      } catch {
        /* tolerate */
      }
    }
    fetchAll();
    const id = setInterval(fetchAll, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [visible]);

  if (!visible || !state) return null;

  const cmp = state.compare;
  const color = CMP_COLOR[cmp];
  const label = CMP_LABEL[cmp];
  const hasConflicts = conflicts.length > 0;

  async function resolve(conflictId: string, winner: "local" | "peer") {
    try {
      await api.system.syncResolve(conflictId, winner, role);
      pushToast({
        tone: "ok",
        text: `Conflict resolved · ${winner === "local" ? "local" : "peer"} write wins · loser preserved in audit chain`,
        ttlMs: 5000,
      });
      const c = await api.system.syncConflicts();
      setConflicts(c.pending);
    } catch (e) {
      pushToast({ tone: "error", text: `Resolve failed: ${e}` });
    }
  }

  async function seed() {
    try {
      const c = await api.system.syncSeedConflict(role);
      // Defensive: backend should always return a fully-formed conflict, but
      // an older code path could return {} if vector-clock comparison didn't
      // classify the seeded events as concurrent. Reject incomplete objects
      // so we don't push a half-conflict that crashes the renderer.
      if (!c || !c.id || !c.detected_at || !c.local_event || !c.peer_event) {
        pushToast({ tone: "error", text: "Seed returned an incomplete conflict — check backend logs" });
        return;
      }
      setConflicts((prev) => [...prev.filter((x) => x.id !== c.id), c]);
      pushToast({ tone: "info", text: "Demo conflict seeded · open Node Status to resolve", ttlMs: 4500 });
    } catch (e) {
      pushToast({ tone: "error", text: `Seed failed: ${e}` });
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase transition-colors"
        style={{
          letterSpacing: "0.16em",
          borderColor: hasConflicts ? "var(--color-danger)" : "var(--color-border)",
          background: hasConflicts ? "color-mix(in oklab, var(--color-danger-muted) 28%, transparent)" : "transparent",
          color: hasConflicts ? "var(--color-danger)" : "var(--color-text-secondary)",
        }}
        title="Distributed sync state · click to inspect"
      >
        <span className="relative flex h-2 w-2" aria-hidden>
          {hasConflicts && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-danger)] opacity-60" />
          )}
          <span
            className="relative inline-flex h-2 w-2 rounded-full"
            style={{ background: color }}
          />
        </span>
        <span className="font-semibold" style={{ color }}>{state.node_id}</span>
        <span className="text-[var(--color-text-muted)]">·</span>
        <span style={{ color }}>{label}</span>
        {hasConflicts && (
          <span
            className="rounded-sm border border-[var(--color-danger)] px-1 text-[9px] tabular-nums"
            style={{ letterSpacing: "0.08em" }}
          >
            {conflicts.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[8800] flex items-start justify-end bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="m-4 flex w-[34rem] max-h-[90vh] flex-col gap-3 overflow-y-auto rounded-md border border-[var(--color-primary)] bg-[var(--color-surface)] p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-baseline justify-between">
              <div>
                <div
                  className="font-mono text-[10px] uppercase text-[var(--color-primary)]"
                  style={{ letterSpacing: "0.22em" }}
                >
                  Distributed Sync · GC-2
                </div>
                <div className="mt-0.5 font-mono text-[14px] font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
                  {state.node_id} ↔ {state.peer_node_id}
                </div>
                <div className="mt-1 spire-body-muted text-[11px]">
                  Vector-clock-based reconciliation. Loser-preserving last-writer-wins on conflict.
                  Works offline; replays on restore.
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded px-2 py-1 font-mono text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
              >
                ✕
              </button>
            </div>

            {/* Vector clocks side-by-side */}
            <div className="grid grid-cols-2 gap-3">
              <ClockCard title={`Local · ${state.node_id}`} clock={state.local_clock} />
              <ClockCard title={`Peer · ${state.peer_node_id}`} clock={state.peer_clock} />
            </div>

            <div className="flex items-center gap-2">
              <span
                className="rounded-sm border px-2 py-[2px] font-mono text-[10px] font-semibold uppercase"
                style={{
                  letterSpacing: "0.18em",
                  color,
                  borderColor: `color-mix(in oklab, ${color} 40%, var(--color-border))`,
                  background: `color-mix(in oklab, ${color} 12%, transparent)`,
                }}
              >
                {label}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.1em" }}>
                {state.events_logged} events logged
              </span>
              <button
                onClick={seed}
                className="ml-auto rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning-muted)_25%,transparent)] px-2 py-1 font-mono text-[10px] font-semibold uppercase text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning-muted)_40%,transparent)]"
                style={{ letterSpacing: "0.16em" }}
                title="Inject a deliberate conflict for demo / training"
              >
                Seed Demo Conflict
              </button>
            </div>

            {/* Pending conflicts */}
            <div>
              <div
                className="mb-2 font-mono text-[10px] uppercase text-[var(--color-text-muted)]"
                style={{ letterSpacing: "0.22em" }}
              >
                Pending conflicts ({conflicts.length})
              </div>
              {conflicts.length === 0 && (
                <div className="rounded-sm border border-dashed border-[var(--color-border)] p-4 text-center font-mono text-[10px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.14em" }}>
                  NO CONFLICTS — clocks reconciled
                </div>
              )}
              <div className="flex flex-col gap-2">
                {conflicts.map((c) => (
                  <ConflictRow key={c.id} conflict={c} onResolve={resolve} />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ClockCard({ title, clock }: { title: string; clock: Record<string, number> }) {
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono">
      <div
        className="mb-1 text-[9px] uppercase text-[var(--color-text-muted)]"
        style={{ letterSpacing: "0.22em" }}
      >
        {title}
      </div>
      <div className="flex flex-col gap-0.5 text-[10px]" style={{ letterSpacing: "0.04em" }}>
        {Object.entries(clock).length === 0 && (
          <span className="text-[var(--color-text-muted)]">[ no entries ]</span>
        )}
        {Object.entries(clock).map(([n, v]) => (
          <div key={n} className="flex items-center justify-between">
            <span className="text-[var(--color-text)]">{n}</span>
            <span className="tabular-nums text-[var(--color-text-secondary)]">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConflictRow({
  conflict,
  onResolve,
}: {
  conflict: SyncConflict;
  onResolve: (id: string, winner: "local" | "peer") => void;
}) {
  return (
    <div className="rounded-sm border border-[var(--color-danger-muted)] bg-[color-mix(in_oklab,var(--color-danger-muted)_15%,var(--color-surface))] p-3">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-[11px] font-semibold text-[var(--color-text)]" style={{ letterSpacing: "0.04em" }}>
          {conflict.op_kind} · {conflict.record_id}
        </div>
        <div className="font-mono text-[9px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.14em" }}>
          {(conflict.detected_at || "").slice(11, 19)}Z detected
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <ConflictSide
          label="Local"
          ev={conflict.local_event}
          onPick={() => onResolve(conflict.id, "local")}
        />
        <ConflictSide
          label="Peer"
          ev={conflict.peer_event}
          onPick={() => onResolve(conflict.id, "peer")}
        />
      </div>
      <div className="mt-2 font-mono text-[9px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.12em" }}>
        Whichever side you pick wins. Loser preserved in audit chain via comms_conflict_resolved entry.
      </div>
    </div>
  );
}

function ConflictSide({
  label,
  ev,
  onPick,
}: {
  label: string;
  ev: { event_id: string; actor: string; at: string; clock: Record<string, number>; payload: Record<string, unknown> };
  onPick: () => void;
}) {
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] uppercase text-[var(--color-text-muted)]" style={{ letterSpacing: "0.22em" }}>
          {label}
        </span>
        <button
          onClick={onPick}
          className="rounded-sm border border-[var(--color-primary)] bg-[var(--color-primary)] px-2 py-[1px] text-[9px] font-semibold uppercase text-white hover:bg-[var(--color-primary-hover)]"
          style={{ letterSpacing: "0.18em" }}
        >
          Pick
        </button>
      </div>
      <div className="mt-1 text-[10px]">
        <div className="text-[var(--color-text)]">{ev?.actor || "—"}</div>
        <div className="text-[9px] text-[var(--color-text-muted)]" style={{ letterSpacing: "0.08em" }}>
          {(ev?.at || "").slice(5, 19).replace("T", " ")}
        </div>
      </div>
      <div className="mt-2 text-[9px] text-[var(--color-text-secondary)]">
        clock: <span className="tabular-nums text-[var(--color-text)]">{JSON.stringify(ev.clock)}</span>
      </div>
      <div className="mt-1 text-[9px] text-[var(--color-text-secondary)]">
        payload:{" "}
        <span className="text-[var(--color-text)]">
          {Object.entries(ev.payload).slice(0, 2).map(([k, v]) => (
            <span key={k} className="block truncate">{k}={String(v)}</span>
          ))}
        </span>
      </div>
    </div>
  );
}
