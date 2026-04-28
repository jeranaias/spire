/**
 * W1 #83 — Reusable freshness + DDIL banner pieces for the model
 * registry / detail surfaces. Co-located with the views (admin/) rather
 * than promoted to /components/ until a third caller appears.
 */
import { useEffect, useState } from "react";
import { Button } from "../../components/ui";
import { useSpireStore, type DdilMode } from "../../state/store";
import { formatAge, formatLoadedAt } from "./useRegistryFetch";

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
 * Inline DDIL banner. Renders nothing in CONNECTED. Otherwise tells the
 * operator what the comms posture is doing to this view's fetches and
 * (when DISCONNECTED + we have a loadedAt) how stale the data on screen
 * actually is. Auto re-fetch on reconnect is handled in the fetch hook;
 * the banner is operator-facing copy only.
 */
export function DdilFreshnessBanner({ loadedAt }: { loadedAt: number | null }) {
  const ddilMode = useSpireStore((s) => s.ddilMode);
  // Re-render once a minute so the "n min stale" label drifts forward
  // without spamming React on every interaction.
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
    ? `Cached fetch · loaded ${formatLoadedAt(loadedAt)} · ${formatAge(Date.now() - loadedAt)} stale · auto-refresh on reconnect`
    : "View will auto-refresh when comms are restored";
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 flex items-center gap-3 rounded-sm border px-3 py-2 font-mono text-[11px] uppercase tracking-widest"
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
 * refresh button is the operator's manual escape hatch when they don't
 * want to wait for the auto-refresh on reconnect (or just want a fresh
 * pull during a steady CONNECTED state).
 */
export function FreshnessHeader({
  loadedAt,
  refreshing,
  onRefresh,
}: {
  loadedAt: number | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[11px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {loadedAt
          ? `Loaded ${formatLoadedAt(loadedAt)} (${formatAge(Date.now() - loadedAt)} ago)`
          : "Loading…"}
      </span>
      <Button
        variant="secondary"
        size="sm"
        onClick={onRefresh}
        pending={refreshing}
        aria-label="Refresh registry"
        title="Pull a fresh registry now"
      >
        ↻ Refresh
      </Button>
    </div>
  );
}

/**
 * Distinct error tile for `load_error` payloads. The backend returns a
 * non-null `load_error` when `dataset/data/model_registry.json` failed
 * to parse — surfacing the exception explicitly stops a parse failure
 * from looking identical to a legitimately empty registry.
 */
export function RegistryLoadErrorTile({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--color-danger-muted)] bg-[color-mix(in_oklab,var(--color-danger-muted)_18%,var(--color-surface))] p-4"
    >
      <div className="font-mono text-xs uppercase text-[var(--color-danger)] tracking-widest">
        Registry parse failure
      </div>
      <div className="mt-1 spire-body text-sm">
        SPIRE could not parse <code className="font-mono">dataset/data/model_registry.json</code>.
        The supply-chain view is suppressed until the file is repaired — this is NOT
        an empty registry.
      </div>
      <div className="mt-2 break-words rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        {message}
      </div>
    </div>
  );
}
