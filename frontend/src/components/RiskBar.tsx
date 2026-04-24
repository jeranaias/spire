import clsx from "clsx";

interface Props {
  score: number | null;
  band?: string;
  compact?: boolean;
}

function colorForScore(score: number): string {
  if (score >= 76) return "bg-[var(--color-danger)]";
  if (score >= 51) return "bg-[#fb923c]";
  if (score >= 26) return "bg-[var(--color-warning)]";
  return "bg-[var(--color-success)]";
}

export function RiskBar({ score, band, compact }: Props) {
  if (score == null) {
    return (
      <div className="text-xs text-[var(--color-text-muted)] italic">Insufficient data</div>
    );
  }
  const pct = Math.min(100, Math.max(0, score));
  return (
    <div className={clsx("flex items-center gap-3", compact && "text-xs")}>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-bg)]">
        <div
          className={clsx("absolute inset-y-0 left-0 rounded-full transition-all", colorForScore(score))}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 text-right font-mono text-sm font-semibold tabular-nums text-[var(--color-text)]">
        {score.toFixed(0)}
      </span>
      {band && !compact && (
        <span
          className={clsx(
            "rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            band === "CRITICAL" && "bg-[var(--color-danger-muted)] text-[var(--color-danger)]",
            band === "HIGH" && "bg-[#7c2d12] text-[#fb923c]",
            band === "MODERATE" && "bg-[var(--color-warning-muted)] text-[var(--color-warning)]",
            band === "LOW" && "bg-[var(--color-success-muted)] text-[var(--color-success)]",
          )}
        >
          {band}
        </span>
      )}
    </div>
  );
}
