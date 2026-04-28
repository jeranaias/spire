/**
 * <ErrorState> — chassis-consistent error affordance with required retry.
 *
 * The E1 contract: "every error has <ErrorState> with retry." A bare
 * stack trace is operator-hostile; this primitive forces the call site
 * to provide:
 *   - what failed (title, e.g. "Telemetry Offline")
 *   - the human reason (description, e.g. "Backend may be cycling")
 *   - the technical detail (detail, raw error string for the curious)
 *   - a retry path (onRetry — optional but strongly preferred)
 */
import type { ReactNode } from "react";
import clsx from "clsx";
import { Button } from "./Button";

export interface ErrorStateProps {
  /** Headline. Short, all-caps in render. */
  title: string;
  /** One-sentence human description of what's wrong. */
  description?: string;
  /** Optional raw error text — formatApiError(e) etc. Renders below. */
  detail?: string;
  /** Retry handler. Strongly encouraged. */
  onRetry?: () => void;
  /** Override the default "Retry" label. */
  retryLabel?: string;
  /** Optional secondary action (e.g. "Switch role"). */
  secondaryAction?: ReactNode;
  /** Pending state on the retry button. */
  retrying?: boolean;
  /** `panel` centers in the parent; `inline` renders as a banner row. */
  variant?: "panel" | "inline";
  className?: string;
}

export function ErrorState({
  title,
  description,
  detail,
  onRetry,
  retryLabel = "Retry",
  secondaryAction,
  retrying = false,
  variant = "panel",
  className,
}: ErrorStateProps) {
  if (variant === "inline") {
    return (
      <div
        role="alert"
        className={clsx(
          "flex items-center gap-3 rounded-sm border border-[var(--color-danger-muted)] bg-[color-mix(in_oklab,var(--color-danger-muted)_18%,var(--color-surface))] p-3",
          className,
        )}
      >
        <span aria-hidden className="text-[var(--color-danger)]">▲</span>
        <div className="flex-1">
          <div className="font-mono text-xs uppercase text-[var(--color-danger)] tracking-widest">
            {title}
          </div>
          {description && (
            <div className="mt-0.5 font-mono text-xs text-[var(--color-text-secondary)] tracking-wide">
              {description}
            </div>
          )}
        </div>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry} pending={retrying}>
            {retryLabel}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className={clsx("flex h-full items-center justify-center p-6", className)}>
      <div
        role="alert"
        className="max-w-md rounded-md border border-[var(--color-danger-muted)] bg-[var(--color-surface)] p-6 text-center"
      >
        <div className="font-mono text-xs uppercase text-[var(--color-danger)] tracking-widest">
          {title}
        </div>
        {description && (
          <div className="mt-2 spire-body text-sm">{description}</div>
        )}
        {detail && (
          <div className="mt-3 break-words font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            {detail}
          </div>
        )}
        {(onRetry || secondaryAction) && (
          <div className="mt-4 flex items-center justify-center gap-2">
            {onRetry && (
              <Button onClick={onRetry} pending={retrying}>
                {retryLabel}
              </Button>
            )}
            {secondaryAction}
          </div>
        )}
      </div>
    </div>
  );
}
