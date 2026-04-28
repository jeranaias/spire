/**
 * LinkStatusStrip — operator's primary "is the lane live?" honesty cue.
 *
 * Lifted from `views/DecisionBridge.tsx` (Task #47) into a shared
 * component so every primary view (BASTION, PULSE, SENTRY, ADMIN) can
 * mount the same strip — Task #128. Previously the strip lived only on
 * the bridge, which let an operator scroll a long table on another view
 * and forget the lane was degraded.
 *
 * The strip is driven entirely off the Zustand store (ddilMode,
 * ddilLastCacheHit, ddilLastSyncAt, ddilSyncing, ddilQueue) plus an
 * optional `lastSuccessAt` value the host view can pass in if it tracks
 * its own per-poll success wall-clock. Views that don't track it (most
 * of them) just omit the prop and the strip falls back to the
 * store-derived `ddilLastSyncAt`.
 *
 * `commsCadenceMultiplier` is also exported here so per-view pollers can
 * import the same multiplier and slow down on degraded comms — the
 * strip says "showing cached"; the pollers must actually back off.
 */
import { useEffect, useState } from "react";

import { useSpireStore, type DdilMode } from "../state/store";

// ---------------------------------------------------------------------------
// DDIL-aware polling cadence.
//
// When the operator drives comms out of CONNECTED the per-view pollers
// should slow down (4-8x) instead of hammering against a lossy/queued
// lane. Returns the multiplier applied to both `baseMs` and `maxMs`.
// ---------------------------------------------------------------------------
export function commsCadenceMultiplier(mode: DdilMode): number {
  switch (mode) {
    case "LIMITED":      return 4;
    case "INTERMITTENT": return 6;
    case "DISCONNECTED": return 8;
    case "CONNECTED":
    default:             return 1;
  }
}

function relMs(deltaMs: number): string {
  const sec = Math.max(0, Math.floor(deltaMs / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remS = sec % 60;
  if (min < 60) return remS ? `${min}m${remS}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60 ? ` ${min % 60}m` : ""}`;
}

const LINK_TONE: Record<DdilMode, string> = {
  CONNECTED:    "var(--color-success)",
  LIMITED:      "var(--color-warning)",
  INTERMITTENT: "var(--color-warning)",
  DISCONNECTED: "var(--color-danger)",
};

interface LinkStatusStripProps {
  /**
   * Optional wall-clock of the host view's most recent successful poll.
   * Bridge populates this from its tile pollers; other views typically
   * omit it and rely on the store's `ddilLastSyncAt`.
   */
  lastSuccessAt?: number | null;
  /** Optional outer wrapper class so a host view can adjust margins. */
  className?: string;
}

export function LinkStatusStrip({ lastSuccessAt = null, className }: LinkStatusStripProps) {
  const ddilMode = useSpireStore((s) => s.ddilMode);
  const ddilLastCacheHit = useSpireStore((s) => s.ddilLastCacheHit);
  const ddilLastSyncAt = useSpireStore((s) => s.ddilLastSyncAt);
  const ddilSyncing = useSpireStore((s) => s.ddilSyncing);
  const queueDepth = useSpireStore((s) => s.ddilQueue.length);

  // Tick once a second so the "12s ago" clock advances live without the
  // pollers having to rerender — the strip is the operator's primary
  // honesty cue, so it has to feel alive even when the lane is silent.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const tone = LINK_TONE[ddilMode] ?? LINK_TONE.CONNECTED;
  const isDegraded = ddilMode !== "CONNECTED";

  // Pick the most honest "last fresh" timestamp we can produce.
  //   CONNECTED   → the most recent of `lastSuccessAt` (per-tile poll
  //                  success) and `ddilLastSyncAt` (set by CommsControl
  //                  after a queue replay completes). The poll value is
  //                  usually fresher; the sync value covers the case
  //                  where we just came out of DISCONNECTED but no poll
  //                  has fired yet.
  //   DEGRADED    → prefer the cache-hit's `cachedAt` (the moment the
  //                  upstream payload we're serving was actually fresh)
  //                  and fall back through `ddilLastSyncAt` and finally
  //                  `lastSuccessAt`. If none are known, render `—`.
  const cacheCachedAt = ddilLastCacheHit?.cachedAt ?? null;
  const candidates = isDegraded
    ? [cacheCachedAt, ddilLastSyncAt, lastSuccessAt]
    : [lastSuccessAt, ddilLastSyncAt];
  const freshAt = candidates.reduce<number | null>(
    (acc, v) => (v == null ? acc : acc == null ? v : Math.max(acc, v)),
    null,
  );
  const freshLabel = freshAt != null ? `${relMs(now - freshAt)} ago` : "—";
  const freshKind = isDegraded ? "LAST FRESH" : "LAST SYNC";

  // Mode-specific tail text.
  const tail = (() => {
    if (ddilSyncing) return "syncing queued writes";
    if (ddilMode === "CONNECTED") return null;
    if (ddilMode === "LIMITED") return "slow lane";
    return "showing cached";
  })();

  return (
    <div
      className={
        "flex items-center gap-2 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-widest" +
        (className ? ` ${className}` : "")
      }
      role="status"
      aria-live="polite"
      aria-label={`Link status ${ddilMode}, ${freshKind.toLowerCase()} ${freshLabel}`}
      style={{
        color: tone,
        borderColor: tone,
        background: `color-mix(in oklab, ${tone} 10%, var(--color-surface))`,
      }}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {isDegraded && (
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
            style={{ background: tone }}
          />
        )}
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: tone }}
        />
      </span>
      <span className="text-[var(--color-text-muted)]">LINK ·</span>
      <span className="font-semibold">{ddilMode}</span>
      <span className="text-[var(--color-text-muted)]">·</span>
      <span className="text-[var(--color-text-muted)]">{freshKind}</span>
      <span className="tabular-nums text-[var(--color-text-secondary)]">{freshLabel}</span>
      {tail && (
        <>
          <span className="text-[var(--color-text-muted)]">—</span>
          <span className="text-[var(--color-text-secondary)]">{tail}</span>
        </>
      )}
      {queueDepth > 0 && (
        <>
          <span className="text-[var(--color-text-muted)]">·</span>
          <span style={{ color: "var(--color-warning)" }}>
            {queueDepth} write{queueDepth === 1 ? "" : "s"} queued
          </span>
        </>
      )}
    </div>
  );
}
