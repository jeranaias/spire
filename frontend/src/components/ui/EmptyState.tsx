/**
 * <EmptyState> — chassis-consistent "nothing to show yet" affordance.
 *
 * Empty states need a CTA. A blank box invites a tap, then frustration
 * when nothing happens. The `action` slot accepts any of our primitives
 * (Button / DangerButton / IconButton wrapped in something) so the
 * caller wires the recovery path explicitly.
 */
import type { ReactNode } from "react";
import clsx from "clsx";

export interface EmptyStateProps {
  /** Headline. Short, sentence-case ("No alerts in this view"). */
  title: string;
  /** Optional secondary copy. One sentence describing the why. */
  description?: string;
  /** Optional CTA — a <Button> or anchor primitive. */
  action?: ReactNode;
  /** Optional decorative leading glyph (single character / inline svg). */
  glyph?: ReactNode;
  /** Variant — `card` for inline panels, `panel` for full-card centering. */
  variant?: "card" | "panel";
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  glyph,
  variant = "panel",
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={clsx(
        "flex flex-col items-center justify-center gap-2 rounded-sm border border-dashed border-[var(--color-border)] p-6 text-center",
        variant === "panel" && "min-h-[140px]",
        className,
      )}
    >
      {glyph && (
        <div aria-hidden className="font-mono text-2xl text-[var(--color-text-muted)]">
          {glyph}
        </div>
      )}
      <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
        {title}
      </div>
      {description && (
        <div className="max-w-sm font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
          {description}
        </div>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
