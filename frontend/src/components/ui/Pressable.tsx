/**
 * <Pressable> — un-styled accessible button for card-shaped or row-shaped
 * selectable surfaces.
 *
 * Use when the visual chassis (card, row, list item) does not fit a
 * <Button> shape. Pressable contributes nothing visual beyond the
 * mandatory focus ring and the 44×44 touch-target floor; the caller
 * supplies layout via `className`.
 *
 * Why this exists: views frequently need a clickable card (a need-row,
 * a risk-board row, a review-queue card). Wrapping those in <Button>
 * forces uppercase font-mono text and a 44px height — wrong for cards.
 * Raw <button> drops the focus ring and the touch-target floor.
 * Pressable is the principled middle ground.
 *
 * Required: aria-label OR aria-labelledby OR visible text content.
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

export interface PressableProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** Render as a row (full width, left-aligned text). Default true. */
  block?: boolean;
}

const BASE =
  "min-h-[44px] text-left transition-colors select-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-selected)] " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const Pressable = forwardRef<HTMLButtonElement, PressableProps>(function Pressable(
  { children, className, type = "button", block = true, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(BASE, block && "block w-full", className)}
      {...rest}
    >
      {children}
    </button>
  );
});
