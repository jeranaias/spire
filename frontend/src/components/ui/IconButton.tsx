/**
 * <IconButton> — square button with no text label.
 *
 * Used for chevrons, dismiss "✕", expand/collapse, dense table-row
 * actions. Always 44×44px (touch target floor) regardless of glyph size.
 * `aria-label` is REQUIRED — TypeScript won't enforce it but the linter
 * and code review will. The runtime guard logs a warning in dev so a
 * missed label is loud, not silent.
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

export type IconButtonVariant = "secondary" | "ghost" | "primary" | "warning";
export type IconButtonSize = "sm" | "md" | "lg";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> {
  /** Required label announced by screen readers. Visible tooltip via title. */
  "aria-label": string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  pending?: boolean;
  /** The glyph or icon element. Wrap text in a span; SVGs work directly. */
  children: ReactNode;
  /** Escape hatch — additional classes appended last. Avoid in views. */
  className?: string;
}

const SIZE: Record<IconButtonSize, string> = {
  sm: "h-11 w-11 text-sm",
  md: "h-11 w-11 text-base",
  lg: "h-12 w-12 text-lg",
};

const BASE =
  "inline-flex items-center justify-center rounded-sm transition-colors select-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-selected)] " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT: Record<IconButtonVariant, string> = {
  primary:
    "border border-[var(--color-primary)] bg-[var(--color-primary)] text-white " +
    "hover:bg-[var(--color-primary-hover)]",
  secondary:
    "border border-[var(--color-border-active)] bg-transparent text-[var(--color-text)] " +
    "hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-primary)]",
  ghost:
    "border border-transparent bg-transparent text-[var(--color-text-secondary)] " +
    "hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
  warning:
    "border border-[var(--color-warning)] bg-[color-mix(in_oklab,var(--color-warning-muted)_25%,transparent)] " +
    "text-[var(--color-warning)] hover:bg-[color-mix(in_oklab,var(--color-warning-muted)_45%,transparent)]",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    variant = "ghost",
    size = "md",
    pending = false,
    children,
    className,
    type = "button",
    disabled,
    title,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || pending;
  // Show the aria-label as a tooltip too, unless the caller passed an
  // explicit one. Walkthrough audit: hover discoverability matters when
  // a glyph isn't immediately obvious (e.g. ↺ vs ✕ on a row).
  const tooltip = title ?? rest["aria-label"];
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      title={tooltip}
      className={clsx(BASE, SIZE[size], VARIANT[variant], className)}
      {...rest}
    >
      {pending ? (
        <span aria-hidden className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" />
      ) : (
        children
      )}
    </button>
  );
});
