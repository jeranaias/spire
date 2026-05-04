/**
 * pushUndoToast / <UndoToast/> — destructive-action undo affordance.
 *
 *   "Every destructive action shows an undo toast for ≥5 seconds with a
 *    single-tap undo."  (W0/E1 spec)
 *
 * Two surfaces, same contract:
 *   • `pushUndoToast(...)` / `useUndoToast()` — imperative; ride the
 *     existing global toast lane. Use these from event handlers /
 *     mutation callbacks (the common case).
 *   • `<UndoToast/>` — declarative React component; render in-place
 *     when a destructive action wants its own scoped undo card
 *     (e.g. inside a confirmation modal that survives even after the
 *     toast lane has been dismissed). Both honour the ≥5000ms floor
 *     and use the same Pressable + IconButton primitives so focus +
 *     touch-target contract holds.
 */
import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useSpireStore, type ToastTone } from "../../state/store";
import { Pressable } from "./Pressable";
import { IconButton } from "./IconButton";

export interface PushUndoToastOptions {
  /** Past-tense human description of what just happened. */
  text: string;
  /** Single-tap reversal handler. */
  onUndo: () => void;
  /** Defaults to "Undo". */
  undoLabel?: string;
  /** TTL in ms; floor is 5000 per the E1 contract. */
  ttlMs?: number;
  /** Tone defaults to "warn" for destructive actions. */
  tone?: ToastTone;
  /** Optional click-through links rendered alongside the Undo affordance —
   *  typically a deep-link to the audit chain entry the action wrote. */
  links?: { label: string; href: string }[];
}

const DESTRUCTIVE_TTL_FLOOR_MS = 5000;

export function pushUndoToast(opts: PushUndoToastOptions): string {
  const ttl = Math.max(opts.ttlMs ?? DESTRUCTIVE_TTL_FLOOR_MS, DESTRUCTIVE_TTL_FLOOR_MS);
  return useSpireStore.getState().pushToast({
    tone: opts.tone ?? "warn",
    text: opts.text,
    ttlMs: ttl,
    undo: {
      label: opts.undoLabel ?? "Undo",
      onUndo: opts.onUndo,
    },
    links: opts.links,
  });
}

/**
 * Hook variant — same payload, but bound to the store's pushToast through
 * a hook subscription so React 19 strict-mode + concurrent rendering
 * doesn't fight the imperative call.
 */
export function useUndoToast(): (opts: PushUndoToastOptions) => string {
  const pushToast = useSpireStore((s) => s.pushToast);
  return (opts) => {
    const ttl = Math.max(opts.ttlMs ?? DESTRUCTIVE_TTL_FLOOR_MS, DESTRUCTIVE_TTL_FLOOR_MS);
    return pushToast({
      tone: opts.tone ?? "warn",
      text: opts.text,
      ttlMs: ttl,
      undo: {
        label: opts.undoLabel ?? "Undo",
        onUndo: opts.onUndo,
      },
      links: opts.links,
    });
  };
}

export interface UndoToastProps {
  /** Past-tense human description of what just happened. */
  text: string;
  /** Single-tap reversal handler. Called once; subsequent taps no-op. */
  onUndo: () => void;
  /** Fired when the toast auto-expires without an undo tap. */
  onExpire?: () => void;
  /** Fired when the operator dismisses (X) without undo. */
  onDismiss?: () => void;
  /** TTL in ms; floor is 5000 per the W0 contract. */
  ttlMs?: number;
  /** Defaults to "Undo". */
  undoLabel?: string;
  /** Tone defaults to "warn" for destructive actions. */
  tone?: ToastTone;
  className?: string;
}

const TONE_BORDER: Record<ToastTone, string> = {
  ok: "border-[var(--color-ok)] text-[var(--color-ok)]",
  warn: "border-[var(--color-warning)] text-[var(--color-warning)]",
  error: "border-[var(--color-danger)] text-[var(--color-danger)]",
  info: "border-[var(--color-primary)] text-[var(--color-primary)]",
};

/**
 * Inline declarative undo affordance. Renders its own progress-bar countdown
 * and a single Undo + Dismiss row. Mirrors the look of the global toast lane
 * but is mounted in-place by the caller for surfaces where the global lane
 * is not appropriate (modals, drawers, side panels).
 */
export function UndoToast({
  text,
  onUndo,
  onExpire,
  onDismiss,
  ttlMs,
  undoLabel = "Undo",
  tone = "warn",
  className,
}: UndoToastProps) {
  const ttl = Math.max(ttlMs ?? DESTRUCTIVE_TTL_FLOOR_MS, DESTRUCTIVE_TTL_FLOOR_MS);
  const [remaining, setRemaining] = useState(ttl);
  const settledRef = useRef(false);
  const startRef = useRef(performance.now());

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (settledRef.current) return;
      const elapsed = performance.now() - startRef.current;
      const left = Math.max(0, ttl - elapsed);
      setRemaining(left);
      if (left <= 0) {
        settledRef.current = true;
        onExpire?.();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ttl, onExpire]);

  function handleUndo() {
    if (settledRef.current) return;
    settledRef.current = true;
    onUndo();
  }
  function handleDismiss() {
    if (settledRef.current) return;
    settledRef.current = true;
    onDismiss?.();
  }

  const pct = Math.round((remaining / ttl) * 100);
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        "relative flex items-center gap-3 overflow-hidden rounded-sm border bg-[var(--color-surface)] px-3 py-2 font-mono text-xs uppercase tracking-wider",
        TONE_BORDER[tone],
        className,
      )}
    >
      <span className="flex-1 truncate">{text}</span>
      <Pressable
        onClick={handleUndo}
        block={false}
        aria-label={undoLabel}
        className="!min-h-0 rounded-sm border border-current px-2 py-[2px] text-[11px] uppercase tracking-widest"
      >
        {undoLabel}
      </Pressable>
      <IconButton
        onClick={handleDismiss}
        aria-label="Dismiss undo toast"
        variant="ghost"
        size="sm"
      >
        <span aria-hidden>✕</span>
      </IconButton>
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-[2px] bg-current opacity-70 transition-[width] ease-linear"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
