import { useSpireStore } from "../state/store";

// CAPCO classification banner — DoDM 5200.01 / ICS 700-1 spec.
//
// Shape: solid color block, full width, white text, no gradient, no glyph,
// no decorative dot. Color codes the highest classification visible in the
// session:
//   UNCLASSIFIED        → green     (#007A33)
//   CUI                 → purple    (#502B85)
//   CONFIDENTIAL        → blue      (#0033A0)
//   SECRET              → red       (#C8102E)
//   TOP SECRET          → orange    (#FF8C00)
//   TOP SECRET // SCI   → yellow    (#FFD100, black text)
//
// SPIRE's synthetic dataset is U-only; future ATO-grade builds will derive
// this string from the highest watermark in the active dataset. The amber
// gradient version got a unanimous "this is consumer dashboard cosplay"
// from the design panel — every Marine has seen the spec block 10,000
// times and clocks the difference in <2s.
const CLASS_COLOR = {
  UNCLASSIFIED: { bg: "#007A33", fg: "#FFFFFF" },
  CUI:          { bg: "#502B85", fg: "#FFFFFF" },
  CONFIDENTIAL: { bg: "#0033A0", fg: "#FFFFFF" },
  SECRET:       { bg: "#C8102E", fg: "#FFFFFF" },
  TOP_SECRET:   { bg: "#FF8C00", fg: "#FFFFFF" },
  TS_SCI:       { bg: "#FFD100", fg: "#000000" },
} as const;

// FPCON → color map. BRAVO is the calm institutional state; CHARLIE amber;
// DELTA flashes red. ThermalHawk sim escalates BRAVO → CHARLIE for the
// duration of the incident.
const FPCON_COLOR: Record<string, { fg: string; bg: string; flash?: boolean }> = {
  NORMAL:  { fg: "var(--color-success)", bg: "color-mix(in oklab, var(--color-success-muted) 20%, var(--color-bg))" },
  ALPHA:   { fg: "var(--color-success)", bg: "color-mix(in oklab, var(--color-success-muted) 20%, var(--color-bg))" },
  BRAVO:   { fg: "var(--color-primary)", bg: "color-mix(in oklab, var(--color-primary) 14%, var(--color-bg))" },
  CHARLIE: { fg: "var(--color-warning)", bg: "color-mix(in oklab, var(--color-warning-muted) 28%, var(--color-bg))" },
  DELTA:   { fg: "var(--color-danger)",  bg: "color-mix(in oklab, var(--color-danger-muted) 32%, var(--color-bg))", flash: true },
};

export function ClassificationBand() {
  const fpcon = useSpireStore((s) => s.fpcon);
  const cls = CLASS_COLOR.UNCLASSIFIED;
  const tone = FPCON_COLOR[fpcon] || FPCON_COLOR.BRAVO;

  return (
    <div
      // h-8 (was h-7) + flex items-center keeps the banner aligned to the
      // 14px TopBar baseline rather than sitting flush against it; the
      // operator scans the chrome as one band, not pasted layers.
      className="flex h-8 shrink-0 items-center justify-between px-4 py-1 font-mono text-sm font-semibold uppercase tracking-widest"
      style={{
        background: cls.bg,
        color: cls.fg,
      }}
      role="region"
      aria-label="Classification and force-protection banner"
    >
      <div className="flex items-center gap-3 leading-none">
        {/* Single canonical SYNTHETIC mention — was repeated in COP header,
         * footer, and inline tags. Removing the dupes makes this banner the
         * load-bearing classification statement, not redundant chrome. */}
        <span className="whitespace-nowrap">
          UNCLASSIFIED // SYNTHETIC DATA // FOR DEMONSTRATION ONLY
        </span>
      </div>
      <div
        className="flex shrink-0 items-center gap-2 rounded-sm border px-2.5 py-[2px] font-mono text-xs leading-none tracking-widest"
        style={{
          borderColor: `color-mix(in oklab, ${tone.fg} 60%, transparent)`,
          background: `color-mix(in oklab, ${cls.bg} 70%, #000)`,
          color: tone.fg,
          animation: tone.flash ? "fpcon-flash 1.2s ease-in-out infinite" : undefined,
        }}
      >
        <span style={{ color: `color-mix(in oklab, ${cls.fg} 70%, transparent)` }}>FPCON</span>
        <span className="font-bold">{fpcon}</span>
      </div>
    </div>
  );
}
