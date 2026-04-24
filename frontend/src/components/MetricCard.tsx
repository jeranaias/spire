import clsx from "clsx";

interface Props {
  label: string;
  value: string | number;
  delta?: number;
  deltaLabel?: string;
  tone?: "neutral" | "success" | "warning" | "danger";
  unit?: string;
}

const TONE_FILL: Record<NonNullable<Props["tone"]>, string> = {
  neutral: "border-[var(--color-border)]",
  success: "border-[var(--color-success-muted)] bg-[color-mix(in_oklab,var(--color-success-muted)_15%,var(--color-surface))]",
  warning: "border-[var(--color-warning-muted)] bg-[color-mix(in_oklab,var(--color-warning-muted)_15%,var(--color-surface))]",
  danger:  "border-[var(--color-danger-muted)]  bg-[color-mix(in_oklab,var(--color-danger-muted)_20%,var(--color-surface))]",
};

export function MetricCard({ label, value, delta, deltaLabel = "7d", tone = "neutral", unit }: Props) {
  const deltaRender = delta != null && (
    <span
      className={clsx(
        "ml-2 inline-flex items-center gap-1 text-xs tabular-nums",
        delta > 0 ? "text-[var(--color-success)]" : delta < 0 ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]",
      )}
    >
      {delta > 0 ? "▲" : delta < 0 ? "▼" : "—"}
      {Math.abs(delta).toFixed(1)}
      {unit}
      <span className="text-[var(--color-text-muted)]">({deltaLabel})</span>
    </span>
  );

  return (
    <div
      className={clsx(
        "flex flex-col justify-between rounded-md border bg-[var(--color-surface)] p-4 transition-colors",
        TONE_FILL[tone],
      )}
    >
      <div className="text-[11px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-2 flex items-baseline">
        <span className="font-mono text-3xl font-semibold tabular-nums text-[var(--color-text)]">
          {value}
          {unit && <span className="ml-0.5 text-xl text-[var(--color-text-secondary)]">{unit}</span>}
        </span>
      </div>
      {deltaRender && <div className="mt-1">{deltaRender}</div>}
    </div>
  );
}
