import { useSpireStore } from "../state/store";

// FPCON → color map. BRAVO is the calm institutional state; CHARLIE glows
// amber; DELTA flashes red. A ThermalHawk sim (see BastionView) temporarily
// escalates BRAVO → CHARLIE for the duration of the incident.
const FPCON_COLOR: Record<string, { fg: string; bg: string; flash?: boolean }> = {
  NORMAL:   { fg: "var(--color-success)",       bg: "color-mix(in oklab, var(--color-success-muted) 20%, var(--color-bg))" },
  ALPHA:    { fg: "var(--color-success)",       bg: "color-mix(in oklab, var(--color-success-muted) 20%, var(--color-bg))" },
  BRAVO:    { fg: "var(--color-primary)",       bg: "color-mix(in oklab, var(--color-primary) 14%, var(--color-bg))" },
  CHARLIE:  { fg: "var(--color-warning)",       bg: "color-mix(in oklab, var(--color-warning-muted) 28%, var(--color-bg))" },
  DELTA:    { fg: "var(--color-danger)",        bg: "color-mix(in oklab, var(--color-danger-muted) 32%, var(--color-bg))", flash: true },
};

export function ClassificationBand() {
  const fpcon = useSpireStore((s) => s.fpcon);
  const tone = FPCON_COLOR[fpcon] || FPCON_COLOR.BRAVO;

  return (
    <div
      className="flex h-7 shrink-0 items-center justify-between border-b border-[var(--color-border)] px-4 font-mono text-[10px] uppercase"
      style={{
        background: "linear-gradient(180deg, color-mix(in oklab, var(--color-warning) 14%, var(--color-surface)) 0%, var(--color-surface) 100%)",
        letterSpacing: "0.22em",
      }}
      aria-label="Classification and force-protection banner"
    >
      <div className="flex items-center gap-3">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "var(--color-warning)", boxShadow: "0 0 6px var(--color-warning)" }}
          aria-hidden
        />
        <span className="font-semibold text-[var(--color-warning)]">UNCLASSIFIED</span>
        <span className="text-[var(--color-border-active)]">│</span>
        <span className="text-[var(--color-text-secondary)]">Synthetic Data</span>
        <span className="text-[var(--color-border-active)]">│</span>
        <span className="text-[var(--color-text-muted)]">For Demonstration Only</span>
      </div>
      <div
        className="flex items-center gap-2 rounded-sm border px-2.5 py-[2px]"
        style={{
          borderColor: `color-mix(in oklab, ${tone.fg} 45%, var(--color-border))`,
          background: tone.bg,
          animation: tone.flash ? "fpcon-flash 1.2s ease-in-out infinite" : undefined,
        }}
      >
        <span className="text-[var(--color-text-muted)]">FPCON</span>
        <span className="font-semibold" style={{ color: tone.fg }}>
          {fpcon}
        </span>
      </div>
    </div>
  );
}
