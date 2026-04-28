/**
 * DdilDesyncBanner — sticky cockpit-wide banner that warns when the
 * operator has DDIL-queued writes pending OR a recent write was dropped
 * on the wire by an INTERMITTENT comms lane.
 *
 * Why this exists: the demo cockpit already gets a sticky "backend out
 * of sync" banner when the scripted player's `scenario.control seek`
 * fails (see ScenarioSyncBanner). The same silent-failure pattern
 * exists across every domain mutation in the app — SENTRY release,
 * audit clearance, cannibalization proposal, etc. all catch the DDIL
 * "queued" / "dropped" ApiError with a per-call toast that disappears
 * in 5 seconds. A presenter or operator deep in the next narration
 * beat can easily miss them.
 *
 * This banner aggregates both signals into a single chrome-level alert:
 *   - any non-empty `ddilQueue` (DISCONNECTED-mode queued writes), and
 *   - any recent `ddilDroppedWrites` (INTERMITTENT-mode wire drops in
 *     the last 30s, pruned on a 5s tick).
 *
 * Stays sticky until the queue is empty AND no recent drops remain, OR
 * the operator hits Dismiss. Dismissal is timestamp-based: a fresh
 * queued / dropped write whose timestamp is newer than `dismissedAt`
 * re-summons the banner so the operator can't accidentally hide
 * follow-on failures.
 *
 * Excluded: `/system/scenario/control` — the ScenarioSyncBanner already
 * owns that surface and we don't want two banners shouting about the
 * same dispatch.
 *
 * Mounted at the App shell — survives route changes, sits at the same
 * z-stack as ScenarioSyncBanner, and offsets itself below it when
 * both are visible.
 */
import { useEffect, useMemo, useState } from "react";
import { drainDdilQueue } from "../state/ddilSync";
import { useScenarioPlayer } from "../state/scenarioPlayer";
import {
  useSpireStore,
  type DdilDroppedWrite,
  type DdilQueuedWrite,
} from "../state/store";
import { Pressable } from "./ui";

// How long an INTERMITTENT-mode drop counts as "recent" for the banner.
// Matches the task brief ("last ~30s") and the half-life of the original
// per-call toast.
const DROP_RECENCY_MS = 30_000;
// Re-render cadence for pruning aged-out drops. Cheap (one set comparison)
// and bounded — only ticks while drops exist.
const PRUNE_TICK_MS = 5_000;
// Scenario player owns its own banner for this path; don't double-shout.
const SCENARIO_CONTROL_PATH = "/system/scenario/control";

interface NormalizedItem {
  id: string;
  method: string;
  path: string;
  surface: string;
  /** Common timestamp axis (ms-since-epoch) so we can compare against
   * `ddilDesyncDismissedAt`. */
  ts: number;
  kind: "queued" | "dropped";
}

/**
 * Map a method+path to a human-readable surface label. The label is the
 * action noun that gets pluralized in the summary line ("3 SENTRY
 * releases queued"). Order matters — the most specific patterns must
 * come first so e.g. coalition release wins over the generic
 * /sentry/review/.../release pattern.
 */
function classifyWrite(w: { method: string; path: string }): string {
  const p = w.path;
  if (p.startsWith("/sentry/review/bulk")) return "SENTRY bulk review";
  if (/^\/sentry\/coalition\/[^/]+\/release/.test(p)) return "Coalition release";
  if (/^\/sentry\/review\/[^/]+\/release/.test(p)) return "SENTRY release";
  if (/^\/sentry\/review\/[^/]+\/(clear|cleared)/.test(p)) return "SENTRY clear";
  if (/^\/sentry\/review\/[^/]+\/(reject|hold|escalate)/.test(p)) return "SENTRY review";
  if (p.startsWith("/sentry/mark")) return "SENTRY mark";
  if (p.startsWith("/sentry/export")) return "SENTRY export";
  if (p.startsWith("/sentry/process")) return "SENTRY process";
  if (p.startsWith("/pulse/cannibalization/propose")) return "cannibalization proposal";
  if (p.startsWith("/pulse/draft-action")) return "PULSE draft action";
  if (/^\/pulse\/drafts\/[^/]+\/dismiss/.test(p)) return "PULSE draft dismiss";
  if (p.startsWith("/pulse/feedback/")) return "PULSE feedback";
  if (/^\/bastion\/alerts\/[^/]+\//.test(p)) return "BASTION alert action";
  if (p.startsWith("/bastion/simulate/clear/")) return "BASTION simulation clear";
  if (p.startsWith("/bastion/simulate/")) return "BASTION simulation";
  if (p.startsWith("/system/dha-rescue/")) return "DHA RESCUE audit";
  if (p.startsWith("/system/sync/resolve/")) return "sync resolve";
  if (p.startsWith("/system/sync/seed-conflict")) return "sync seed";
  if (p.startsWith("/system/admin/reset-demo")) return "demo reset";
  if (p.startsWith("/system/admin/inference-economics/extrapolate")) return "inference extrapolate";
  if (p.startsWith("/system/audit/spillage")) return "spillage audit";
  if (p.startsWith("/integrations/")) return "integration write";
  if (p.startsWith("/pulse/")) return "PULSE write";
  if (p.startsWith("/sentry/")) return "SENTRY write";
  if (p.startsWith("/bastion/")) return "BASTION write";
  if (p.startsWith("/system/")) return "system write";
  // Fallback — keep something useful in the unhappy path so the banner
  // still names the surface even on a brand-new endpoint.
  const seg = p.split("/").filter(Boolean);
  return seg.slice(0, 2).join(" ") || w.method.toLowerCase();
}

function pluralize(noun: string, n: number): string {
  if (n === 1) return noun;
  // Conservative — most surface labels are nouns that take a trailing s.
  // "feedback" stays singular even at >1 (mass noun).
  if (/feedback$/i.test(noun)) return noun;
  if (/s$/i.test(noun)) return noun;
  return `${noun}s`;
}

function summarize(items: NormalizedItem[]): { headline: string; detail: string } {
  const queued = items.filter((i) => i.kind === "queued").length;
  const dropped = items.filter((i) => i.kind === "dropped").length;

  // Group by surface for the breakdown ("1 SENTRY release, 2 SENTRY clears")
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.surface, (counts.get(i.surface) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([surface, n]) => `${n} ${pluralize(surface, n)}`)
    .join(", ");

  let headline: string;
  if (queued > 0 && dropped > 0) {
    headline = `${queued} write${queued === 1 ? "" : "s"} queued · ${dropped} dropped on the wire`;
  } else if (queued > 0) {
    headline = `${queued} write${queued === 1 ? "" : "s"} queued for replay`;
  } else {
    headline = `${dropped} write${dropped === 1 ? "" : "s"} dropped on the wire`;
  }
  return { headline, detail: breakdown };
}

function isExcluded(path: string): boolean {
  // Scenario-control writes are owned by ScenarioSyncBanner; suppress
  // them here so the same dispatch never raises two banners.
  return path.startsWith(SCENARIO_CONTROL_PATH);
}

function normalizeQueued(w: DdilQueuedWrite): NormalizedItem {
  return {
    id: w.id,
    method: w.method,
    path: w.path,
    surface: classifyWrite(w),
    ts: Date.parse(w.queuedAt) || Date.now(),
    kind: "queued",
  };
}

function normalizeDropped(d: DdilDroppedWrite): NormalizedItem {
  return {
    id: d.id,
    method: d.method,
    path: d.path,
    surface: classifyWrite(d),
    ts: d.droppedAt,
    kind: "dropped",
  };
}

export function DdilDesyncBanner() {
  const ddilQueue = useSpireStore((s) => s.ddilQueue);
  const ddilDroppedWrites = useSpireStore((s) => s.ddilDroppedWrites);
  const ddilSyncing = useSpireStore((s) => s.ddilSyncing);
  const dismissedAt = useSpireStore((s) => s.ddilDesyncDismissedAt);
  const dismiss = useSpireStore((s) => s.dismissDdilDesyncBanner);
  const pruneDropped = useSpireStore((s) => s.pruneDdilDroppedWrites);
  // Offset the banner below ScenarioSyncBanner when both are visible
  // (mission-clock desync + DDIL desync) so neither obscures the other.
  const scenarioBannerVisible = useScenarioPlayer(
    (s) => Boolean(s.syncError) && s.status !== "idle",
  );
  const [replaying, setReplaying] = useState(false);
  // Drives recency cutoff for dropped-writes — re-renders the banner
  // every PRUNE_TICK_MS so a 30s-old drop slides out without a manual
  // refresh.
  const [, setNow] = useState(Date.now());

  useEffect(() => {
    if (ddilDroppedWrites.length === 0) return;
    const id = window.setInterval(() => {
      pruneDropped(DROP_RECENCY_MS);
      setNow(Date.now());
    }, PRUNE_TICK_MS);
    return () => window.clearInterval(id);
  }, [ddilDroppedWrites.length, pruneDropped]);

  // Build the visible item set. Filter excluded paths first, then drop
  // anything older than the dismissal timestamp so the operator can hide
  // a stale state without losing future failures.
  const items = useMemo<NormalizedItem[]>(() => {
    const cutoff = Date.now() - DROP_RECENCY_MS;
    const all: NormalizedItem[] = [];
    for (const w of ddilQueue) {
      if (isExcluded(w.path)) continue;
      all.push(normalizeQueued(w));
    }
    for (const d of ddilDroppedWrites) {
      if (isExcluded(d.path)) continue;
      if (d.droppedAt < cutoff) continue;
      all.push(normalizeDropped(d));
    }
    if (dismissedAt !== null) {
      return all.filter((i) => i.ts > dismissedAt);
    }
    return all;
  }, [ddilQueue, ddilDroppedWrites, dismissedAt]);

  // Suppress while a drain is in flight — CommsControl's SyncingOverlay
  // already owns that beat. We re-appear once the drain finishes if the
  // queue (or a fresh drop) refilled it.
  if (ddilSyncing) return null;
  if (items.length === 0) return null;

  const { headline, detail } = summarize(items);
  const queuedCount = items.filter((i) => i.kind === "queued").length;
  const droppedCount = items.filter((i) => i.kind === "dropped").length;

  // Replay only makes sense for queued writes — dropped-on-wire writes
  // are already lost (the operator must re-issue them). When the
  // visible set is dropped-only, hide the Replay button.
  const canReplay = queuedCount > 0 && !replaying;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 z-[7900] flex justify-center px-4"
      style={{
        // Stack below ScenarioSyncBanner when it's also visible. The
        // scenario banner sits at top-0 + pt-2 with ~88px content height
        // for its worst case (4 lines of detail).
        top: scenarioBannerVisible ? 96 : 8,
      }}
    >
      <div className="pointer-events-auto flex w-full max-w-[1280px] items-start gap-3 rounded-sm border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning)_18%,var(--color-surface))] px-3 py-2 shadow-lg">
        <span aria-hidden className="mt-0.5 font-mono text-[14px] text-[var(--color-warning)]">
          ▲
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-widest text-[var(--color-warning)]">
            DDIL out of sync — backend writes pending or lost
          </div>
          <div className="mt-1 font-mono text-[11px] text-[var(--color-text)]">
            {headline}
          </div>
          {detail && (
            <div className="mt-0.5 font-sans text-[11px] text-[var(--color-text-secondary)]">
              {detail}
            </div>
          )}
          <div className="mt-0.5 font-mono text-[10px] tracking-wide text-[var(--color-text-muted)]">
            {queuedCount > 0
              ? "Queued writes will replay automatically when comms restore — or hit Replay Now."
              : "Dropped writes were lost on the wire — re-issue from the originating screen."}
          </div>
        </div>
        {queuedCount > 0 && (
          <Pressable
            onClick={async () => {
              if (!canReplay) return;
              setReplaying(true);
              try {
                await drainDdilQueue();
              } finally {
                setReplaying(false);
              }
            }}
            disabled={!canReplay}
            block={false}
            aria-label="Replay queued DDIL writes now"
            className="!min-h-0 flex h-7 shrink-0 items-center rounded-sm border border-[var(--color-warning)] bg-[var(--color-bg)] px-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning)_15%,var(--color-bg))] disabled:opacity-50"
          >
            {replaying ? "Replaying…" : "Replay now"}
          </Pressable>
        )}
        <Pressable
          onClick={() => dismiss()}
          block={false}
          aria-label="Dismiss DDIL desync banner"
          className="!min-h-0 flex h-7 shrink-0 items-center rounded-sm border border-[var(--color-border)] bg-transparent px-2 font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"
          title={
            droppedCount > 0
              ? "Hide for now — banner will reappear if a new write is queued or dropped"
              : "Hide for now — banner will reappear if a new write is queued"
          }
        >
          Dismiss
        </Pressable>
      </div>
    </div>
  );
}
