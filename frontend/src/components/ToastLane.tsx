import { useSpireStore, type Toast, type ToastTone } from "../state/store";
import { IconButton, Pressable } from "./ui";

const TONE_ACCENT: Record<ToastTone, string> = {
  ok: "var(--color-success)",
  info: "var(--color-primary)",
  warn: "var(--color-warning)",
  error: "var(--color-danger)",
};

export function ToastLane() {
  const toasts = useSpireStore((s) => s.toasts);
  const dismiss = useSpireStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  // Two stacked live regions so screen readers announce errors with
  // assertive priority while ok/info/warn announce politely. Sharing one
  // region with mixed priorities truncates the announcement queue —
  // separating them is the WAI-ARIA-recommended pattern.
  const errors = toasts.filter((t) => t.tone === "error");
  const others = toasts.filter((t) => t.tone !== "error");

  // Walkthrough #19 — toast lane moved from bottom-right (where it covered
  // REPORT ISSUE + Generate Release Package action clusters) to top-right.
  // top-12 sits below the global TopBar so the lane never overlaps action
  // buttons in the bottom-right of any view.
  return (
    <div className="pointer-events-none fixed top-12 right-4 z-[9000] flex max-w-sm flex-col gap-2">
      <div role="alert" aria-live="assertive" aria-atomic="false" className="flex flex-col gap-2">
        {errors.map((t) => (
          <ToastRow key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
      <div role="status" aria-live="polite" aria-atomic="false" className="flex flex-col gap-2">
        {others.map((t) => (
          <ToastRow key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </div>
  );
}

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const accent = TONE_ACCENT[toast.tone];
  return (
    <div
      className="pointer-events-auto flex items-center gap-3 overflow-hidden rounded-sm border bg-[color-mix(in_oklab,var(--color-surface)_94%,transparent)] px-3 py-2 shadow-lg backdrop-blur"
      style={{
        borderColor: `color-mix(in oklab, ${accent} 40%, var(--color-border))`,
        animation: "toast-in 180ms ease-out",
      }}
    >
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
      />
      <span
        className="flex-1 font-mono text-sm text-[var(--color-text)] tracking-wide"
      >
        {toast.text}
      </span>
      {toast.undo && (
        <Pressable
          onClick={() => {
            toast.undo!.onUndo();
            onDismiss();
          }}
          block={false}
          className="!min-h-0 font-mono text-xs uppercase text-[var(--color-primary)] hover:underline tracking-wider"
        >
          {toast.undo.label}
        </Pressable>
      )}
      {toast.link && (
        <a
          href={toast.link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs uppercase text-[var(--color-primary)] hover:underline tracking-wider"
        >
          {toast.link.label} ↗
        </a>
      )}
      <IconButton onClick={onDismiss} aria-label="Dismiss toast">
        ✕
      </IconButton>
    </div>
  );
}
