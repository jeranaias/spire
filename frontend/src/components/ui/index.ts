/**
 * E1 UX hardening primitives — single entry point.
 *
 * After this lane lands, raw <button> is forbidden in views. Import from
 * this barrel and compose via props.
 *
 *   import { Button, IconButton, DangerButton, ErrorState, EmptyState,
 *            LoadingState, useIdempotentAction, pushUndoToast } from "../components/ui";
 */
export { Button } from "./Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./Button";
export { Pressable } from "./Pressable";
export type { PressableProps } from "./Pressable";
export { IconButton } from "./IconButton";
export type {
  IconButtonProps,
  IconButtonSize,
  IconButtonVariant,
} from "./IconButton";
export { DangerButton } from "./DangerButton";
export type { DangerButtonProps, DangerConfirmMode } from "./DangerButton";
export { LoadingState } from "./LoadingState";
export type { LoadingStateProps, LoadingStateSize } from "./LoadingState";
export { EmptyState } from "./EmptyState";
export type { EmptyStateProps } from "./EmptyState";
export { ErrorState } from "./ErrorState";
export type { ErrorStateProps } from "./ErrorState";
export { pushUndoToast, useUndoToast, UndoToast } from "./UndoToast";
export type { PushUndoToastOptions, UndoToastProps } from "./UndoToast";
export {
  useIdempotentAction,
  fireIdempotent,
} from "./useIdempotentAction";
export type {
  UseIdempotentActionOptions,
  UseIdempotentActionResult,
} from "./useIdempotentAction";
