/**
 * ClassificationBanner — full-width CAPCO banner stripe meant for the top
 * and bottom of any tab that renders classified content. Wraps the
 * `ClassificationBadge` primitive in a tinted band so a presenter
 * screenshot or projector frame always carries a marking line per
 * DoDM 5200.01.
 *
 * Originally lifted out of `ProcessingTab.tsx` (Task #66) so the Review
 * Queue tab (Task #149) can reuse the exact same primitive instead of
 * rolling its own stripe. Color picker mirrors the swatches in
 * `levels.ts` rather than re-deriving them so the band tint matches the
 * badge fill.
 */
import clsx from "clsx";
import { ClassificationBadge } from "./ClassificationBadge";
import { type Classification } from "./levels";

export function ClassificationBanner({
  edge,
  classification,
  caveats,
}: {
  edge: "top" | "bottom";
  classification: Classification;
  caveats?: string[];
}) {
  const bg = `color-mix(in oklab, ${
    classification === "UNCLASSIFIED" ? "#007A33" :
    classification === "CUI" ? "#502B85" :
    classification === "CONFIDENTIAL" ? "#0033A0" :
    classification === "SECRET" ? "#C8102E" :
    classification === "TOP_SECRET" ? "#FF8C00" :
    "#FFD100"
  } 18%, var(--color-surface))`;
  return (
    <div
      role="region"
      aria-label={`Classification banner (${edge})`}
      className={clsx(
        "z-20 flex shrink-0 items-center justify-center gap-3 px-4 py-1.5",
        edge === "top"
          ? "border-b border-[var(--color-border)]"
          : "border-t border-[var(--color-border)]",
      )}
      style={{ background: bg }}
    >
      <ClassificationBadge
        classification={classification}
        caveats={caveats}
        size="md"
      />
    </div>
  );
}
