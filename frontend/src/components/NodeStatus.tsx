/**
 * GC-2 distributed-sync drawer cards.
 *
 * The standalone NodeStatus chip was superseded by SystemStatusChip;
 * what remains here are the presentational pieces SystemStatusChip still
 * composes inside the conflict-resolution drawer: the per-node vector-
 * clock card and the per-conflict row. Kept in this file (rather than
 * renamed) to avoid churn on the SystemStatusChip import.
 */
import { type SyncConflict } from "../api";
import { Button } from "./ui";

export function ClockCard({ title, clock }: { title: string; clock: Record<string, number> }) {
  return (
    <div className="rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono">
      <div
        className="mb-1 text-xs uppercase text-[var(--color-text-muted)] tracking-widest"
      >
        {title}
      </div>
      <div className="flex flex-col gap-0.5 text-xs tracking-wide">
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

export function ConflictRow({
  conflict,
  onResolve,
}: {
  conflict: SyncConflict;
  onResolve: (id: string, winner: "local" | "peer") => void;
}) {
  return (
    <div className="rounded-sm border border-[var(--color-danger-muted)] bg-[color-mix(in_oklab,var(--color-danger-muted)_15%,var(--color-surface))] p-3">
      <div className="flex items-baseline justify-between">
        <div className="font-mono text-sm font-semibold text-[var(--color-text)] tracking-wide">
          {conflict.op_kind} · {conflict.record_id}
        </div>
        <div className="font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          {/* Walkthrough audit: prior format showed only HH:MM:SS without
           * date — a conflict logged yesterday read identical to one logged
           * 30s ago. Render full DD MMM YYYY HHMMz Zulu so audit reviews
           * disambiguate by date. */}
          {(() => {
            const iso = conflict.detected_at || "";
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return iso;
            const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
            const z = (n: number) => String(n).padStart(2, "0");
            return `${z(d.getUTCDate())} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${z(d.getUTCHours())}${z(d.getUTCMinutes())}z`;
          })()} detected
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
      <div className="mt-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
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
        <span className="text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
          {label}
        </span>
        <Button onClick={onPick} variant="primary" size="sm">
          Pick
        </Button>
      </div>
      <div className="mt-1 text-xs">
        <div className="text-[var(--color-text)]">{ev?.actor || "—"}</div>
        <div className="text-xs text-[var(--color-text-muted)] tracking-wide">
          {(ev?.at || "").slice(5, 19).replace("T", " ")}
        </div>
      </div>
      <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
        clock: <span className="tabular-nums text-[var(--color-text)]">{JSON.stringify(ev.clock)}</span>
      </div>
      <div className="mt-1 text-xs text-[var(--color-text-secondary)]">
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
