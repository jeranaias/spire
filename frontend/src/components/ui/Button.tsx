/**
 * <Button> — the only button primitive views are allowed to use.
 *
 * Variants
 *   primary    — blue chassis fill, white text. Use for the principal
 *                CTA on a surface (Approve, Sign, Dispatch, Apply).
 *   secondary  — bordered chassis, no fill. Use for non-destructive,
 *                non-principal actions (Snooze, Filter, Reset View).
 *   ghost      — text-only, hover background. Use for tertiary actions
 *                inside dense rows (chevrons, expand, "more").
 *   warning    — amber border. Caution actions that are not strictly
 *                destructive (Engage Air-Gap, Snooze, Override).
 *
 * Sizes — every size meets WCAG 2.5.5 AAA 44×44px touch target.
 *   sm  → h-11 px-3  (44px tall, compact horizontally — inline rows)
 *   md  → h-11 px-4  (44px tall, standard CTA)
 *   lg  → h-12 px-5  (48px tall, hero CTAs / onboarding)
 *
 * State
 *   `pending` — disables the button + shows a 1-character spinner. Used
 *               by useIdempotentAction; callers can also pass directly.
 *   `disabled` — visually muted, pointer disabled, no focus on click.
 *
 * Props pass through onClick / type / aria-* / form / name.
 *
 * Tailwind classes live HERE — usages compose via props. Per the E1
 * architectural constraint: "Tailwind classes live on the primitives,
 * not on usages."
 */
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "warning";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** When true, button is disabled and shows a spinner. */
  pending?: boolean;
  /** Optional left-side icon glyph or element. Not interactive on its own. */
  leadingIcon?: ReactNode;
  /** Optional right-side icon glyph or element. */
  trailingIcon?: ReactNode;
  /** Make the button take 100% of its parent's width. */
  fullWidth?: boolean;
  children?: ReactNode;
  /** Escape hatch — additional classes appended last. Avoid in views. */
  className?: string;
}

const SIZE: Record<ButtonSize, string> = {
  sm: "h-11 min-w-[44px] px-3 text-xs",
  md: "h-11 min-w-[44px] px-4 text-sm",
  lg: "h-12 min-w-[48px] px-5 text-sm",
};

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-sm font-mono font-semibold uppercase " +
  "tracking-widest transition-colors whitespace-nowrap select-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-selected)] " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "border border-[var(--color-primary)] bg-[var(--color-primary)] text-white " +
    "hover:bg-[var(--color-primary-hover)] active:bg-[var(--color-primary-hover)]",
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

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    pending = false,
    leadingIcon,
    trailingIcon,
    fullWidth = false,
    children,
    className,
    type = "button",
    disabled,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || pending;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={pending || undefined}
      className={clsx(
        BASE,
        SIZE[size],
        VARIANT[variant],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {pending ? (
        <span aria-hidden className="inline-block h-2 w-2 animate-pulse rounded-full bg-current" />
      ) : (
        leadingIcon && <span aria-hidden className="inline-flex shrink-0">{leadingIcon}</span>
      )}
      {children && <span className="truncate">{children}</span>}
      {trailingIcon && !pending && (
        <span aria-hidden className="inline-flex shrink-0">{trailingIcon}</span>
      )}
    </button>
  );
});
