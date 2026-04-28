/**
 * DemoSurfaceMarker — Task #125 (extension of Task #50 / F-08).
 *
 * Task #50 hardened the demo cockpit (`/demo`) and the bottom narration
 * overlay so a single screenshot of either self-marks with the per-beat
 * classification + a fixed "DEMO DATA · NOT REAL UNITS" chip. But once
 * the player navigates the operator out of `/demo` and into the four
 * module views the underlying pages render alerts, maps, forecasts, and
 * audit chains without any per-beat classification stamp visible above
 * their content. A judge's screenshot of the PULSE alerts feed during
 * the H+12 casualty beat shows "14 casualties · 40 O- RBC · 39 FFP"
 * verbatim with only the global app-shell banner.
 *
 * This component closes that gap. It reads the scenario player store,
 * and when the player is `playing` or `paused`, renders the per-beat
 * classification badge alongside the DEMO DATA chip near the top of
 * the host page's main content area. It is suppressed for `idle` /
 * `ready` / `complete` so day-to-day operator views (and pre/post-demo
 * chrome) don't gain demo decoration.
 *
 * The chip + badge pair is the same one extracted from
 * `DemoView.tsx` (DemoDataChip helper) and `NarrationOverlay.tsx`,
 * factored here per the task hint so the four module surfaces and the
 * cockpit/overlay share one source of truth.
 */
import { useScenarioPlayer } from "../../state/scenarioPlayer";
import { ClassificationBadge } from "./ClassificationBadge";

export function DemoSurfaceMarker() {
  const status = useScenarioPlayer((s) => s.status);
  const beats = useScenarioPlayer((s) => s.beats);
  const idx = useScenarioPlayer((s) => s.currentBeatIndex);

  // Only stamp when the player is actively walking through beats. Idle
  // / ready / complete are normal operator-view states; we don't want
  // to paint demo chrome on the regular page surface in those modes.
  if (status !== "playing" && status !== "paused") return null;

  const beat = beats[idx];
  if (!beat) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2"
      role="note"
      aria-label="Demo beat classification"
      data-testid="demo-surface-marker"
    >
      <ClassificationBadge
        classification={beat.classification ?? "CUI"}
        size="lg"
      />
      <span
        className="inline-flex items-center rounded-sm border border-dashed border-[var(--color-border-active)] bg-[var(--color-surface)] px-2 py-[3px] font-mono text-[13px] font-semibold uppercase tracking-widest text-[var(--color-text-muted)]"
        title="Synthetic units, bases, and Class VIII PARs — SPIRE demo data, not real operational data."
      >
        Demo data · not real units
      </span>
      <span className="font-mono text-[13px] uppercase tracking-widest text-[var(--color-text-muted)]">
        Beat {String(idx + 1).padStart(2, "0")} · {beat.phase} · {beat.title}
      </span>
    </div>
  );
}
