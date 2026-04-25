import { useSpireStore, type Toast, type ToastTone } from "../state/store";

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

  return (
    <div
      className="pointer-events-none fixed bottom-16 right-4 z-[9000] flex max-w-sm flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
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
        className="flex-1 font-mono text-[11px] text-[var(--color-text)]"
        style={{ letterSpacing: "0.04em" }}
      >
        {toast.text}
      </span>
      {toast.undo && (
        <button
          onClick={() => {
            toast.undo!.onUndo();
            onDismiss();
          }}
          className="font-mono text-[10px] uppercase text-[var(--color-primary)] hover:underline"
          style={{ letterSpacing: "0.14em" }}
        >
          {toast.undo.label}
        </button>
      )}
      <button
        onClick={onDismiss}
        className="font-mono text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
