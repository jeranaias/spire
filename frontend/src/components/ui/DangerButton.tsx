/**
 * <DangerButton> — destructive actions (Delete, Reject, Resolve, Release).
 *
 * Two confirmation modes:
 *   `confirm: "press-twice"` — first tap arms the button, second tap fires.
 *     Visual state: bordered red → solid red with "Confirm?" label. After
 *     `armWindowMs` (default 4000), reverts to idle. This is the
 *     fat-finger mitigation per the E1 spec — "tap the wrong button
 *     three times in a row" yields one armed state and one fire, never
 *     three fires.
 *   `confirm: "modal"` — opens a native confirm() dialog. Use only for
 *     truly destructive actions where keystroke-confirm beats two-tap
 *     (e.g. Release Air-Gap, Drop FPCON).
 *   `confirm: false` — fires immediately. Reserve for cases where the
 *     surrounding UI has already done the confirmation (a modal's
 *     primary destructive action, a checked-checkbox guard, etc).
 *
 * Always pair with a `<UndoToast>` on the resulting mutation so even an
 * armed-twice mistake stays recoverable. The cumulative effect:
 *   tap 1 → arm     (visible state change, no mutation)
 *   tap 2 → fire    (mutation lands)
 *   tap 3 → blocked (within useIdempotentAction lockout)
 *   tap 4 → blocked (still inside lockout / pending)
 *   undo  → 5+ second window before the toast self-dismisses
 *
 * Hardened touch-target floor (44×44) inherited from <Button>.
 */
import { forwardRef, useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import clsx from "clsx";
import { Button, type ButtonProps } from "./Button";

export type DangerConfirmMode = false | "press-twice" | "modal";

export interface DangerButtonProps
  extends Omit<ButtonProps, "variant" | "onClick"> {
  /** Confirmation strategy. Defaults to "press-twice". */
  confirm?: DangerConfirmMode;
  /** Modal-mode prompt. Defaults to "Confirm destructive action?". */
  modalPrompt?: string;
  /** Window in ms during which the second press fires the action. */
  armWindowMs?: number;
  /** Label shown while armed. Default "Confirm?". */
  armedLabel?: ReactNode;
  /** Fired only on the *confirmed* press. Receives the original event. */
  onConfirm: (e: MouseEvent<HTMLButtonElement>) => void;
  /** Optional callback when the user arms the button (for parent UX). */
  onArm?: () => void;
  /** Children rendered while idle. */
  children?: ReactNode;
}

const DANGER_IDLE =
  "border border-[var(--color-danger)] bg-transparent text-[var(--color-danger)] " +
  "hover:bg-[color-mix(in_oklab,var(--color-danger-muted)_22%,transparent)]";

const DANGER_ARMED =
  "border border-[var(--color-danger)] bg-[var(--color-danger)] text-white " +
  "hover:bg-[var(--color-danger)] animate-pulse";

export const DangerButton = forwardRef<HTMLButtonElement, DangerButtonProps>(function DangerButton(
  {
    confirm = "press-twice",
    modalPrompt = "Confirm destructive action?",
    armWindowMs = 4000,
    armedLabel = "Confirm?",
    onConfirm,
    onArm,
    children,
    className,
    ...rest
  },
  ref,
) {
  const [armed, setArmed] = useState(false);
  const armedAtRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
  }, []);

  function disarm() {
    setArmed(false);
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    if (confirm === false) {
      onConfirm(e);
      return;
    }
    if (confirm === "modal") {
      // window.confirm is intentionally synchronous — keystroke-confirm
      // beats two-tap on a truly destructive action and matches existing
      // SPIRE precedent (TopBar air-gap toggle uses an in-app modal).
      if (window.confirm(modalPrompt)) onConfirm(e);
      return;
    }
    // press-twice
    if (armed && performance.now() - armedAtRef.current <= armWindowMs) {
      disarm();
      onConfirm(e);
      return;
    }
    setArmed(true);
    armedAtRef.current = performance.now();
    onArm?.();
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(disarm, armWindowMs);
  }

  // Render through <Button> so size/pending/icon props all flow consistently.
  return (
    <Button
      ref={ref}
      // Cast variant to any -- we override the variant styling via className
      // since the danger palette isn't part of Button's enum on purpose
      // (DangerButton owns the destructive treatment).
      variant={"secondary" as ButtonProps["variant"]}
      onClick={handleClick}
      className={clsx(armed ? DANGER_ARMED : DANGER_IDLE, className)}
      aria-pressed={armed || undefined}
      {...rest}
    >
      {armed && confirm === "press-twice" ? armedLabel : children}
    </Button>
  );
});
