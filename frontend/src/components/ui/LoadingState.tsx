/**
 * <LoadingState> — chassis-consistent loading affordance.
 *
 * Three sizes for context:
 *   inline — single-row replacement inside a list / card
 *   panel  — fills a card or panel
 *   page   — fills the whole view region (full height + center)
 *
 * Includes a "Waking up — one moment" copy variant for the cold-start
 * Fly-machine spin-up case (matches the existing BastionView/AdminView
 * `waking` pattern).
 */
import clsx from "clsx";

export type LoadingStateSize = "inline" | "panel" | "page";

export interface LoadingStateProps {
  size?: LoadingStateSize;
  /** Override the displayed message. Defaults to "Loading…". */
  label?: string;
  /** When true, show the "waking up" cold-start copy. */
  waking?: boolean;
  className?: string;
}

const SIZE_CONTAINER: Record<LoadingStateSize, string> = {
  inline: "flex items-center justify-center gap-3 py-3",
  panel: "flex h-full min-h-[120px] items-center justify-center gap-3 p-6",
  page: "flex h-full items-center justify-center gap-3",
};

export function LoadingState({
  size = "panel",
  label = "Loading…",
  waking = false,
  className,
}: LoadingStateProps) {
  const text = waking ? "Waking up — one moment" : label;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={text}
      className={clsx(
        SIZE_CONTAINER[size],
        "font-mono text-sm text-[var(--color-text-secondary)] tracking-wider",
        className,
      )}
    >
      <span
        aria-hidden
        className="inline-block h-2 w-2 animate-pulse rounded-full bg-[var(--color-primary)]"
      />
      <span>{text}</span>
    </div>
  );
}
