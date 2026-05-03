import { useSpireStore } from "../state/store";

// ClassificationBannerStrip — DoDM 5200.01-V2 page-level marking.
//
// DoDM 5200.01-V2 requires a classification banner at the top AND bottom
// of every screen displaying DoD information. This is the canonical solid
// color block (full width, white text, no glyph, no decoration) that
// codes the highest classification visible in the session. SPIRE's
// synthetic dataset is U-only; future ATO-grade builds will derive this
// string from the highest watermark in the active dataset.
//
// Two reasons this lives separately from per-route ClassificationBadge
// chips:
//   1. Page-level vs data-level marking — the strip stamps the screen,
//      the chip stamps the artifact (export, COP feed, audit row). Both
//      are required by the manual; collapsing them loses the audit story.
//   2. Projector legibility — judges sit 30ft from the screen at MDM.
//      A 10-px DEMO chip in the corner is invisible at that distance;
//      the strip is sized + colored so a classification-policy reviewer
//      can clock the marking in the first frame, before any data renders.
//
// Color codes follow CAPCO (DoDM 5200.01 / ICS 700-1):
//   UNCLASSIFIED        → green   (#007A33)  white text
//   CUI                 → purple  (#502B85)  white text
//   CONFIDENTIAL        → blue    (#0033A0)  white text
//   SECRET              → red     (#C8102E)  white text
//   TOP SECRET          → orange  (#FF8C00)  white text
//   TOP SECRET // SCI   → yellow  (#FFD100)  black text
// Demo build: cap displayed banner colors at CUI. The synthetic
// dataset never produces a SECRET/TOP_SECRET marking and the operator
// shouldn't see one even if a fixture leaks an upper-rank key.
const CLASS_COLOR = {
  UNCLASSIFIED: { bg: "#007A33", fg: "#FFFFFF" },
  CUI:          { bg: "#502B85", fg: "#FFFFFF" },
  CONFIDENTIAL: { bg: "#502B85", fg: "#FFFFFF" },
  SECRET:       { bg: "#502B85", fg: "#FFFFFF" },
  TOP_SECRET:   { bg: "#502B85", fg: "#FFFFFF" },
  TS_SCI:       { bg: "#502B85", fg: "#FFFFFF" },
} as const;

// FPCON → color map. Mirrors the previous ClassificationBand. BRAVO is
// the calm institutional state; CHARLIE amber; DELTA flashes red. The
// FPCON badge is opt-in via showFpcon — only the top strip in the App
// shell carries it, since FPCON is session state, not page marking.
const FPCON_COLOR: Record<string, { fg: string; bg: string; flash?: boolean }> = {
  NORMAL:  { fg: "var(--color-success)", bg: "color-mix(in oklab, var(--color-success-muted) 20%, var(--color-bg))" },
  ALPHA:   { fg: "var(--color-success)", bg: "color-mix(in oklab, var(--color-success-muted) 20%, var(--color-bg))" },
  BRAVO:   { fg: "var(--color-primary)", bg: "color-mix(in oklab, var(--color-primary) 14%, var(--color-bg))" },
  CHARLIE: { fg: "var(--color-warning)", bg: "color-mix(in oklab, var(--color-warning-muted) 28%, var(--color-bg))" },
  DELTA:   { fg: "var(--color-danger)",  bg: "color-mix(in oklab, var(--color-danger-muted) 32%, var(--color-bg))", flash: true },
};

// Default banner copy — the page-level marking. Reads as a single
// canonical sentence so a screenshot escaping its chrome still carries
// the disclaimer alongside the classification level.
//
// Build-aware copy: the demo build carries the "DEMO DATA / NOT FOR
// OPERATIONAL USE" disclaimer (judging panels and stakeholder demos
// must see this); the operational build carries the standard
// "UNCLASSIFIED // FOUO" marking that pilot CWOs and SSgts would
// expect on a live system.
import { pickByBuild as _pickByBuild } from "../state/buildMode";
export const DEFAULT_BANNER_TEXT = _pickByBuild({
  demo: "UNCLASSIFIED // DEMO DATA // NOT FOR OPERATIONAL USE",
  operational: "UNCLASSIFIED // FOUO",
});

interface Props {
  // Default "top". The bottom strip omits the FPCON badge (state lives
  // in TopBar / StatusFooter chrome) so it stays legible under the
  // marquee at any density.
  position?: "top" | "bottom";
  // Show the FPCON state badge inline. Only the App-shell top strip
  // sets this true — /auth doesn't have a session yet, and the bottom
  // strip is a plain marking band by spec.
  showFpcon?: boolean;
  // Override the canonical text for surfaces that need a different
  // default (none today). Caller is responsible for passing a string
  // that still parses as a CAPCO marking.
  text?: string;
}

export function ClassificationBannerStrip({
  position = "top",
  showFpcon = false,
  text = DEFAULT_BANNER_TEXT,
}: Props) {
  const fpcon = useSpireStore((s) => s.fpcon);
  const cls = CLASS_COLOR.UNCLASSIFIED;
  const tone = FPCON_COLOR[fpcon] || FPCON_COLOR.BRAVO;

  // Height: spec calls for ≥18px to be legible on a projector at 30ft.
  // We use minHeight 24px with vertical padding so the band scales with
  // the operator's font preference (browser zoom, OS text scaling)
  // without ever falling below the legibility floor. Text is sized with
  // tracking + uppercase weight so "UNCLASSIFIED" reads as a wordmark,
  // not a sentence.
  return (
    <div
      className="flex w-full shrink-0 items-center justify-center gap-3 px-2 py-1 font-mono font-semibold uppercase tracking-wider sm:px-4 sm:tracking-widest"
      style={{
        background: cls.bg,
        color: cls.fg,
        minHeight: 24,
        // Fluid font-size: 10px on a 320px phone, 14px on a 1024px+ laptop,
        // never clips the marking text per DoDM 5200.01 visibility rule.
        fontSize: "clamp(0.625rem, 1.25vw + 0.25rem, 0.875rem)",
      }}
      role="region"
      aria-label={
        position === "top"
          ? "Classification banner — top of page"
          : "Classification banner — bottom of page"
      }
      data-classification-strip={position}
    >
      <span className="text-center leading-none">
        {text}
      </span>
      {showFpcon && (
        <span
          className="ml-auto flex shrink-0 items-center gap-2 rounded-sm border px-2.5 py-[2px] font-mono text-xs leading-none tracking-widest"
          style={{
            borderColor: `color-mix(in oklab, ${tone.fg} 60%, transparent)`,
            background: `color-mix(in oklab, ${cls.bg} 70%, #000)`,
            color: tone.fg,
            animation: tone.flash ? "fpcon-flash 1.2s ease-in-out infinite" : undefined,
          }}
        >
          <span style={{ color: `color-mix(in oklab, ${cls.fg} 70%, transparent)` }}>FPCON</span>
          <span className="font-bold">{fpcon}</span>
        </span>
      )}
    </div>
  );
}
