import clsx from "clsx";

interface Props {
  score: number | null;
  band?: string;
  compact?: boolean;
}

function colorForScore(score: number): string {
  if (score >= 76) return "var(--color-danger)";
  if (score >= 51) return "#fb923c";
  if (score >= 26) return "var(--color-warning)";
  return "var(--color-success)";
}

// Five-segment meter — each segment = 20 points of risk.
// Read like a fuel gauge: glance tells you "warm" vs "danger" at a distance.
const SEGMENTS = 5;

export function RiskBar({ score, band, compact }: Props) {
  if (score == null) {
    return <div className="text-xs italic text-[var(--color-text-muted)]">Insufficient data</div>;
  }
  const pct = Math.min(100, Math.max(0, score));
  const color = colorForScore(score);
  const filledSegments = Math.ceil((pct / 100) * SEGMENTS);

  return (
    <div className={clsx("flex items-center gap-3", compact && "text-xs")}>
      <div className="flex flex-1 items-center gap-[3px]">
        {Array.from({ length: SEGMENTS }).map((_, i) => {
          const active = i < filledSegments;
          const isFractional = i === filledSegments - 1;
          const fill = isFractional
            ? ((pct - i * (100 / SEGMENTS)) / (100 / SEGMENTS)) * 100
            : 100;
          return (
            <div
              key={i}
              className="relative h-[6px] flex-1 overflow-hidden rounded-[1px]"
              style={{
                background: active
                  ? "color-mix(in oklab, var(--color-bg) 70%, transparent)"
                  : "var(--color-bg)",
                border: `1px solid ${active ? "color-mix(in oklab, " + color + " 40%, var(--color-border))" : "var(--color-border)"}`,
              }}
            >
              {active && (
                <div
                  className="absolute inset-y-0 left-0"
                  style={{
                    width: `${fill}%`,
                    background: color,
                    boxShadow: isFractional ? `0 0 6px ${color}` : "none",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
      <span
        className="w-10 text-right font-mono text-sm font-semibold tabular-nums"
        style={{ color, letterSpacing: "-0.01em" }}
      >
        {score.toFixed(0)}
      </span>
      {band && !compact && (
        <span
          className="rounded-sm border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase"
          style={{
            letterSpacing: "0.16em",
            color,
            borderColor: `color-mix(in oklab, ${color} 40%, var(--color-border))`,
            backgroundColor: `color-mix(in oklab, ${color} 10%, transparent)`,
          }}
        >
          {band}
        </span>
      )}
    </div>
  );
}
