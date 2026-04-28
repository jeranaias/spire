/**
 * RefreshAge — shared "stream last refreshed Nm Ns ago" indicator.
 *
 * Findings F6/F9 in `.local/critiques/bastion-cop.md`: when SATCOM goes
 * yellow the BASTION COP keeps projecting confidence in stale data.
 * Polling backs off to 60s when the alert/fused-threats fingerprints
 * are unchanged, so the visible feed can be a minute behind ground
 * truth without any on-screen cue.
 *
 * This component renders a ticking, colour-graded age stamp the
 * operator can read at a glance:
 *   - <30s  -> muted text
 *   - 30-90s -> amber  (cool down on degraded link)
 *   - >=90s  -> red    (likely SATCOM yellow / connection broken)
 *
 * The render itself ticks every second so motion = freshness across
 * the page, not just on the Mission Clock.
 */
import { useEffect, useState } from "react";
import clsx from "clsx";

function formatAge(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r > 0 ? `${m}m ${r}s ago` : `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}

export function RefreshAge({
  ts,
  label = "Stream last refreshed",
  className,
  tightened = false,
}: {
  /** Last-success timestamp from the poller (Date.now()), or null while
   * the first response is in flight. */
  ts: number | null;
  /** Leading copy. Defaults to "Stream last refreshed". */
  label?: string;
  /** Extra classes for layout / margin tuning. */
  className?: string;
  /** Task #140 — when the operator's link is known-yellow (SATCOM
   * degraded, or the presenter has engaged the drill override) the
   * recency thresholds tighten so the operator gets earlier warning
   * on a link that is *expected* to silently slow alert deliveries.
   *   - default ladder:  amber 30s / red 90s
   *   - tightened ladder: amber 15s / red 45s
   * The leading dot still pulses on red, and the label appends a
   * "(link yellow)" suffix so a hover/screen reader knows the
   * threshold isn't the steady-state default. */
  tightened?: boolean;
}) {
  // Re-render every second so the displayed age advances even when
  // the poller is silent. setInterval is cheap; the work it triggers
  // is one Date.now() + a tiny diff in formatAge.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const ageMs = ts == null ? null : Math.max(0, Date.now() - ts);
  // Threshold ladder is centralised so the alert sidebar header,
  // the fused-threats card, and any future poll-driven panel paint
  // staleness with the same colour at the same age. When `tightened`
  // is set (operator's link is yellow), halve the windows so amber
  // shows at 15s and red at 45s — gives the operator earlier warning
  // on a link that's already known to be lossy.
  const warnAt = tightened ? 15_000 : 30_000;
  const dangerAt = tightened ? 45_000 : 90_000;
  let tone: "muted" | "warn" | "danger" = "muted";
  if (ageMs != null) {
    if (ageMs >= dangerAt) tone = "danger";
    else if (ageMs >= warnAt) tone = "warn";
  }
  const color =
    tone === "danger" ? "var(--color-danger)" :
    tone === "warn"   ? "var(--color-warning)" :
                        "var(--color-text-muted)";
  const ageText = ageMs == null ? "awaiting first refresh…" : formatAge(ageMs);
  // Suffix is operator-facing ("link yellow"), matching the SATCOM
  // chip in the StatusStrip — same wording across the chrome so the
  // operator pattern-matches without translating jargon.
  const suffix = tightened ? " · link yellow" : "";

  return (
    <div
      className={clsx(
        "flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest",
        className,
      )}
      style={{ color }}
      role="status"
      aria-live="polite"
      title={
        ts == null
          ? `Awaiting first refresh${tightened ? " · thresholds tightened (link yellow)" : ""}`
          : `Last successful refresh at ${new Date(ts).toISOString()}${
              tightened
                ? " · thresholds tightened to 15s amber / 45s red while the link is yellow"
                : ""
            }`
      }
    >
      <span
        aria-hidden
        className={clsx(
          "inline-block h-1.5 w-1.5 rounded-full",
          tone === "danger" && "animate-pulse",
        )}
        style={{ background: color, boxShadow: `0 0 4px ${color}` }}
      />
      <span>
        {label} {ageText}{suffix}
      </span>
    </div>
  );
}
