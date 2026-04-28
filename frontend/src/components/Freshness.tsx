/**
 * Task #136 — Reusable freshness + DDIL banner pieces for any
 * long-lived data surface (Model Registry / Detail, PULSE Risk
 * Board, SENTRY Review Queue, Audit · SOC, …).
 *
 * Originally co-located with the supply-chain views under W1 #83.
 * Promoted here once the same affordances landed on PULSE / SENTRY /
 * audit so every page reads "Loaded HH:MM:SS · ↻ Refresh · DDIL
 * banner" identically. Auto re-fetch on reconnect is owned by the
 * fetch hook (`hooks/useFreshFetch`); the banner is operator-facing
 * copy only.
 */
import { useEffect, useState } from "react";
import { Button } from "./ui";
import { useSpireStore, type DdilMode } from "../state/store";
import { formatFreshAge, formatLoadedAt } from "../hooks/useFreshFetch";

const MODE_BANNER_LABEL: Record<Exclude<DdilMode, "CONNECTED">, string> = {
  LIMITED: "DDIL · LIMITED COMMS — high latency on every fetch",
  INTERMITTENT: "DDIL · INTERMITTENT COMMS — ~30% of fetches drop on the wire",
  DISCONNECTED: "DDIL · COMMS DENIED — view is from cached fetch",
};

const MODE_BANNER_TONE: Record<Exclude<DdilMode, "CONNECTED">, string> = {
  LIMITED: "var(--color-warning)",
  INTERMITTENT: "var(--color-warning)",
  DISCONNECTED: "var(--color-danger)",
};

/**
 * Inline DDIL banner. Renders nothing in CONNECTED. Otherwise tells
 * the operator what the comms posture is doing to this view's
 * fetches and (when DISCONNECTED + we have a loadedAt) how stale the
 * data on screen actually is. Auto re-fetch on reconnect is handled
 * in the fetch hook; the banner is operator-facing copy only.
 */
export function DdilFreshnessBanner({
  loadedAt,
  className,
}: {
  loadedAt: number | null;
  /** Optional spacing override — most callers want the default mb-3,
   * but tab views inside SentryView prefer no top margin so the
   * banner hugs the sticky header. */
  className?: string;
}) {
  const ddilMode = useSpireStore((s) => s.ddilMode);
  // Re-render once every 30s so the "n min stale" label drifts
  // forward without spamming React on every interaction.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    if (ddilMode === "CONNECTED") return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [ddilMode]);

  if (ddilMode === "CONNECTED") return null;
  const tone = MODE_BANNER_TONE[ddilMode];
  const label = MODE_BANNER_LABEL[ddilMode];
  const detail = loadedAt
    ? `Cached fetch · loaded ${formatLoadedAt(loadedAt)} · ${formatFreshAge(Date.now() - loadedAt)} stale · auto-refresh on reconnect`
    : "View will auto-refresh when comms are restored";
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "flex items-center gap-3 rounded-sm border px-3 py-2 font-mono text-[11px] uppercase tracking-widest " +
        (className ?? "mb-3")
      }
      style={{
        color: tone,
        background: `color-mix(in oklab, ${tone} 12%, var(--color-surface))`,
        borderColor: tone,
      }}
    >
      <span aria-hidden className="inline-block h-2 w-2 rounded-full" style={{ background: tone }} />
      <span className="font-semibold">{label}</span>
      <span className="text-[var(--color-text-secondary)] tracking-wide">· {detail}</span>
    </div>
  );
}

/**
 * "Loaded HH:MM:SS · [Refresh]" affordance for the page header. The
 * refresh button is the operator's manual escape hatch when they
 * don't want to wait for the auto-refresh on reconnect (or just
 * want a fresh pull during a steady CONNECTED state).
 */
export function FreshnessHeader({
  loadedAt,
  refreshing,
  onRefresh,
  refreshLabel = "Refresh registry",
  refreshTitle = "Pull fresh data now",
}: {
  loadedAt: number | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** Accessible label for the refresh button. Defaults to the
   * registry copy for back-compat with existing callers. */
  refreshLabel?: string;
  /** Tooltip / title for the refresh button. */
  refreshTitle?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {loadedAt
          ? `Loaded ${formatLoadedAt(loadedAt)} (${formatFreshAge(Date.now() - loadedAt)} ago)`
          : "Loading…"}
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={onRefresh}
        pending={refreshing}
        aria-label={refreshLabel}
        title={refreshTitle}
      >
        ↻ Refresh
      </Button>
    </div>
  );
}
