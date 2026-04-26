import clsx from "clsx";

interface Props {
  label: string;
  value: string | number;
  delta?: number;
  deltaLabel?: string;
  // Walkthrough #26 — tooltip explaining the delta value (week-over-week).
  deltaTooltip?: string;
  // Walkthrough #41 — small contextual footnote (e.g. "Target ≤ 14d").
  footnote?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  unit?: string;
}

const TONE = {
  neutral: {
    border: "border-[var(--color-border)]",
    bg: "bg-[var(--color-surface)]",
    accent: "var(--color-text-muted)",
    glow: "transparent",
  },
  success: {
    border: "border-[color-mix(in_oklab,var(--color-success)_25%,var(--color-border))]",
    bg: "bg-[color-mix(in_oklab,var(--color-success-muted)_10%,var(--color-surface))]",
    accent: "var(--color-success)",
    glow: "color-mix(in oklab, var(--color-success) 18%, transparent)",
  },
  warning: {
    border: "border-[color-mix(in_oklab,var(--color-warning)_25%,var(--color-border))]",
    bg: "bg-[color-mix(in_oklab,var(--color-warning-muted)_14%,var(--color-surface))]",
    accent: "var(--color-warning)",
    glow: "color-mix(in oklab, var(--color-warning) 18%, transparent)",
  },
  danger: {
    border: "border-[color-mix(in_oklab,var(--color-danger)_30%,var(--color-border))]",
    bg: "bg-[color-mix(in_oklab,var(--color-danger-muted)_18%,var(--color-surface))]",
    accent: "var(--color-danger)",
    glow: "color-mix(in oklab, var(--color-danger) 22%, transparent)",
  },
} as const;

function ChevronUp(props: { className?: string }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" className={props.className} fill="currentColor">
      <path d="M5 2l4 5H1l4-5z" />
    </svg>
  );
}
function ChevronDown(props: { className?: string }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" className={props.className} fill="currentColor">
      <path d="M5 8L1 3h8L5 8z" />
    </svg>
  );
}

export function MetricCard({ label, value, delta, deltaLabel = "7d", deltaTooltip, footnote, tone = "neutral", unit }: Props) {
  const t = TONE[tone];

  return (
    <div
      className={clsx(
        "relative flex flex-col justify-between overflow-hidden rounded-sm border p-4 transition-colors",
        t.border,
        t.bg,
      )}
      style={{
        backgroundImage: `linear-gradient(135deg, ${t.glow} 0%, transparent 55%)`,
      }}
    >
      {/* Left gutter accent */}
      <div
        className="absolute inset-y-0 left-0 w-[2px]"
        style={{ background: t.accent, opacity: tone === "neutral" ? 0.3 : 0.9 }}
      />

      {/* Label — mono, uppercase, tracked.
       * Walkthrough #29 — bumped from text-[10px] to text-xs (12px) so KPI
       * labels are legible without leaning in. */}
      <div
        className="font-mono font-medium uppercase tracking-wider"
        style={{ color: "var(--color-text-muted)", fontSize: "0.75rem" }}
      >
        {label}
      </div>

      {/* Value — hero numeral. Per Rafael R2 design panel: JetBrains Mono at
       * -3.5% tracking on a 2.6rem hero is wrong; mono is the typeface for
       * data, not for heroes. Hero gets IBM Plex Sans semibold with -0.02em
       * tracking. The unit/delta below stay mono because they ARE data. */}
      <div className="mt-2 flex items-baseline gap-0.5">
        <span
          className="font-sans font-semibold tabular-nums text-[var(--color-text)] tracking-tight"
          style={{ fontSize: "2.6rem", lineHeight: 1 }}
        >
          {value}
        </span>
        {unit && (
          <span
            className="font-mono font-medium tracking-tight"
            style={{
              fontSize: "1.25rem",
              color: "var(--color-text-secondary)",
              opacity: 0.55,
            }}
          >
            {unit}
          </span>
        )}
      </div>

      {/* Delta with graphic chevron.
       * Walkthrough #26 — `title` adds a hover-explanation of what 7D means. */}
      {delta != null && (
        <div
          className="mt-3 flex items-center gap-1.5 text-sm font-mono tabular-nums"
          title={deltaTooltip}
        >
          {delta > 0 ? (
            <ChevronUp className="text-[var(--color-success)]" />
          ) : delta < 0 ? (
            <ChevronDown className="text-[var(--color-danger)]" />
          ) : (
            <span className="inline-block h-px w-2 bg-[var(--color-text-muted)]" />
          )}
          <span
            className={clsx(
              "tabular-nums",
              delta > 0 ? "text-[var(--color-success)]" : delta < 0 ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]",
            )}
          >
            {Math.abs(delta).toFixed(1)}
            {unit}
          </span>
          <span className="text-[var(--color-text-muted)]">·</span>
          <span className="uppercase text-[var(--color-text-muted)] tracking-wider">
            {deltaLabel}
          </span>
        </div>
      )}
      {/* Walkthrough #41 — contextual footnote (target / supporting note). */}
      {footnote && (
        <div
          className="mt-2 font-mono uppercase text-[var(--color-text-muted)] tracking-wider"
          style={{ fontSize: "0.625rem" }}
        >
          {footnote}
        </div>
      )}
    </div>
  );
}
