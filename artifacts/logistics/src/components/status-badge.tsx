import { cn } from "@/lib/utils";

export type StatusTier = "green" | "amber" | "red";

const GLYPH: Record<StatusTier, string> = {
  green: "■",
  amber: "●",
  red:   "◆",
};

const TIER_CLASSES: Record<StatusTier, string> = {
  green:  "bg-success/15 text-success border-success/30",
  amber:  "bg-warning/15 text-warning border-warning/30",
  red:    "bg-destructive/15 text-destructive border-destructive/30",
};

export function getTier(pct: number): StatusTier {
  if (pct >= 90) return "green";
  if (pct >= 60) return "amber";
  return "red";
}

interface StatusBadgeProps {
  value: number;
  className?: string;
  showGlyph?: boolean;
  showPct?: boolean;
}

export function StatusBadge({ value, className, showGlyph = true, showPct = true }: StatusBadgeProps) {
  const tier = getTier(value);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs border px-1.5 py-0.5 rounded-sm tabular-nums",
        TIER_CLASSES[tier],
        className
      )}
    >
      {showGlyph && <span aria-hidden="true">{GLYPH[tier]}</span>}
      {showPct && <span>{value}%</span>}
    </span>
  );
}

interface StatusDotProps {
  tier: StatusTier;
  className?: string;
}

export function StatusDot({ tier, className }: StatusDotProps) {
  const colors: Record<StatusTier, string> = {
    green: "bg-success",
    amber: "bg-warning",
    red:   "bg-destructive animate-pulse",
  };
  return (
    <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", colors[tier], className)} />
  );
}

interface StatusCellProps {
  value: number;
  tier?: StatusTier;
  className?: string;
}

export function StatusCell({ value, tier, className }: StatusCellProps) {
  const resolvedTier = tier ?? getTier(value);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs border px-2 py-1 rounded-sm tabular-nums min-w-[5rem] justify-center",
        TIER_CLASSES[resolvedTier],
        className
      )}
    >
      <span aria-hidden="true">{GLYPH[resolvedTier]}</span>
      <span>{value}%</span>
    </span>
  );
}
