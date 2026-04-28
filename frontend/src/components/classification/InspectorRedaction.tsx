/**
 * Shared click-to-reveal PII masking primitives for SENTRY inspectors.
 *
 * The Review Queue inspector pioneered the pattern (black ██ block by default,
 * click-to-reveal gated on `useClearance().can(recordClass)`, plus a presenter
 * "REDACT for projection" toggle that masks every span regardless of clearance
 * for stage projection / camera safety). The Coalition release tab, the
 * classified-spillage Mark tab, and the sanitized-export preview reuse the
 * same highlighted-remark layout, so they reuse the same masking primitives
 * here. Centralising the gate keeps the OPSEC story consistent across the
 * SENTRY suite — a presenter clicking through tabs in front of a CDAO
 * audience will not leak PII on one surface that the queue would have masked.
 */
import { useCallback, useState } from "react";
import clsx from "clsx";
import { normalizeClassification, type Classification } from "./levels";
import { useClearance } from "./useClearance";

// PII span categories that the inspectors mask by default. `geo` (MGRS) and
// `pii` (EDIPI / SSN4 / POC / ext) carry persistent identifiers; `controlled`
// (USA/USMC serials) is operationally sensitive but not PII per se. The
// presenter "REDACTED for projection" toggle masks all categories regardless.
export const PII_MASK_CATEGORIES: ReadonlySet<string> = new Set(["pii", "geo"]);

// Per-flag-category accent colour. Centralised so the four inspector
// surfaces (Review Queue, Coalition, Mark, Export) all use the same
// palette rather than each redefining their own.
export const FLAG_COLOR: Record<string, string> = {
  pii: "var(--color-info)",
  geo: "var(--color-primary)",
  comms: "var(--color-warning)",
  classified: "var(--color-danger)",
  controlled: "#fb923c",
};

export interface PiiRedactionController {
  projectionMode: boolean;
  setProjectionMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  recordClass: Classification;
  canRevealPII: boolean;
  isRevealed: (key: string) => boolean;
  reveal: (key: string) => void;
  unreveal: (key: string) => void;
  resetRevealed: () => void;
}

/**
 * Hook used by every SENTRY inspector that surfaces PII spans. Owns the
 * projection-mode state, the revealed-spans set, and the clearance gate.
 *
 * `recordClass` is normalised; pass the source/detected classification of the
 * record (or the highest classification visible on the surface). The hook
 * does not store recordClass in state — it reflects the current input every
 * render so a record swap reflects immediately.
 */
export function usePiiRedaction(rawRecordClass: string | null | undefined): PiiRedactionController {
  const recordClass = normalizeClassification(rawRecordClass ?? "UNCLASSIFIED");
  const clearance = useClearance();
  const canRevealPII = clearance.can(recordClass);
  const [projectionMode, setProjectionMode] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());

  const isRevealed = useCallback((key: string) => revealed.has(key), [revealed]);
  const reveal = useCallback((key: string) => {
    setRevealed((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);
  const unreveal = useCallback((key: string) => {
    setRevealed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);
  const resetRevealed = useCallback(() => setRevealed(new Set()), []);

  return {
    projectionMode,
    setProjectionMode,
    recordClass,
    canRevealPII,
    isRevealed,
    reveal,
    unreveal,
    resetRevealed,
  };
}

/**
 * Header chip rendering the projection-mode toggle + the current PII state
 * legend. Drop into the inspector header next to the close button or title.
 */
export function RedactionToggle({
  controller,
  className,
  variant = "default",
  label,
}: {
  controller: PiiRedactionController;
  className?: string;
  variant?: "default" | "compact";
  label?: string;
}) {
  const { projectionMode, setProjectionMode, canRevealPII, recordClass } = controller;
  const stateLabel = label
    ?? (projectionMode
      ? "REDACTED for projection · all spans masked"
      : canRevealPII
        ? "PII masked · click to reveal"
        : `PII masked · ${recordClass} clearance required to reveal`);
  return (
    <div
      className={clsx(
        "flex items-center justify-between gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1",
        variant === "compact" && "py-[2px]",
        className,
      )}
      data-testid="pii-redaction-toggle"
    >
      <div className="font-mono text-[10px] uppercase tracking-widest text-[var(--color-text-muted)]">
        {stateLabel}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={projectionMode}
        aria-label="Toggle projection redaction"
        onClick={() => setProjectionMode((v) => !v)}
        className={clsx(
          "rounded-sm border px-2 py-[2px] font-mono text-[10px] font-semibold uppercase tracking-widest transition-colors",
          projectionMode
            ? "border-[var(--color-danger)] bg-[var(--color-danger)] text-white"
            : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:border-[var(--color-danger)]",
        )}
      >
        {projectionMode ? "REDACTED ✓" : "REDACT for projection"}
      </button>
    </div>
  );
}

export interface MaskedSpanProps {
  controller: PiiRedactionController;
  /** Stable identifier for this span — used as the reveal-set key. */
  spanKey: string;
  /** The original (unmasked) text. */
  text: string;
  /** Highlight category (`pii`, `geo`, `comms`, `classified`, `controlled`). */
  category?: string;
  /** Override the accent stripe colour (defaults to `FLAG_COLOR[category]`). */
  flagColor?: string;
  /** Force masking even if the category isn't in `PII_MASK_CATEGORIES`. */
  alwaysMask?: boolean;
  /** Extra className applied to the revealed span. */
  revealedClassName?: string;
  /** Extra style applied to the revealed span. */
  revealedStyle?: React.CSSProperties;
  /** Extra style merged into the masked span. */
  maskExtraStyle?: React.CSSProperties;
  /** Render-prop override for the revealed (unmasked) state. */
  renderRevealed?: (props: {
    text: string;
    onClick?: () => void;
    isPii: boolean;
  }) => React.ReactNode;
}

/**
 * Render a single span with PII masking. When the controller's projection
 * mode is on (or the span is a PII category and not yet revealed), renders a
 * black ██ block sized to the underlying token length so layout doesn't
 * reflow when the operator reveals. Click / Enter / Space reveals — gated on
 * the controller's clearance check. Click again to re-mask.
 */
export function MaskedSpan({
  controller,
  spanKey,
  text,
  category,
  flagColor,
  alwaysMask,
  revealedClassName,
  revealedStyle,
  maskExtraStyle,
  renderRevealed,
}: MaskedSpanProps) {
  const { projectionMode, canRevealPII, isRevealed, reveal, unreveal, recordClass } = controller;
  const isPii = !!alwaysMask || (category ? PII_MASK_CATEGORIES.has(category) : false);
  const shouldMask = projectionMode || (isPii && !isRevealed(spanKey));
  const accent = flagColor ?? (category ? FLAG_COLOR[category] : undefined) ?? "#fff";
  const categoryLabel = (category ?? (alwaysMask ? "pii" : "span")).toUpperCase();

  if (shouldMask) {
    const blockWidth = `${Math.max(2, text.length)}ch`;
    return (
      <span
        role={canRevealPII && !projectionMode ? "button" : undefined}
        tabIndex={canRevealPII && !projectionMode ? 0 : -1}
        title={
          projectionMode
            ? "Masked for projection"
            : canRevealPII
              ? `Click to reveal ${categoryLabel} span`
              : `Reveal blocked — ${recordClass} clearance required`
        }
        aria-label={
          projectionMode
            ? `Redacted ${categoryLabel.toLowerCase()} span`
            : canRevealPII
              ? `Reveal ${categoryLabel.toLowerCase()} span`
              : `Masked ${categoryLabel.toLowerCase()} span (insufficient clearance)`
        }
        onClick={() => {
          if (projectionMode || !canRevealPII) return;
          reveal(spanKey);
        }}
        onKeyDown={(e) => {
          if (projectionMode || !canRevealPII) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            reveal(spanKey);
          }
        }}
        className={clsx(
          "mx-px inline-block select-none align-baseline rounded-sm",
          canRevealPII && !projectionMode && "cursor-pointer",
        )}
        style={{
          background: "#0a0a0a",
          color: "#0a0a0a",
          minWidth: blockWidth,
          borderBottom: `2px solid ${accent}`,
          lineHeight: 1.1,
          ...maskExtraStyle,
        }}
        data-testid="pii-masked-span"
      >
        {"█".repeat(Math.max(2, text.length))}
      </span>
    );
  }

  const onClick = isPii ? () => unreveal(spanKey) : undefined;
  if (renderRevealed) {
    return <>{renderRevealed({ text, onClick, isPii })}</>;
  }
  return (
    <span
      className={clsx("rounded-sm px-0.5", revealedClassName)}
      style={{
        background: `color-mix(in oklab, ${accent} 28%, transparent)`,
        color: accent,
        ...revealedStyle,
      }}
      title={
        isPii
          ? `Revealed ${categoryLabel} span — click again to re-mask`
          : undefined
      }
      onClick={onClick}
      role={isPii ? "button" : undefined}
      tabIndex={isPii ? 0 : -1}
    >
      {text}
    </span>
  );
}
