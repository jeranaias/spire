/**
 * UiDocsView — variant gallery for the E1 hardened primitives.
 *
 * Reachable at #/__ui-docs. Not in the role-based nav — this is a
 * design/QA surface for verifying every variant of every primitive
 * renders correctly. Used during the E1 sweep to validate touch
 * targets, focus rings, and disabled / pending states.
 */
import { useState } from "react";
import {
  Button,
  IconButton,
  DangerButton,
  ErrorState,
  EmptyState,
  LoadingState,
  pushUndoToast,
  UndoToast,
  useIdempotentAction,
} from "../components/ui";

export function UiDocsView() {
  const [pending, setPending] = useState(false);
  const [tapCount, setTapCount] = useState(0);
  const idemAck = useIdempotentAction(
    "ui-docs:ack",
    async () => {
      setTapCount((n) => n + 1);
      await new Promise((r) => setTimeout(r, 600));
    },
    { lockoutMs: 250 },
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <header className="mb-6">
        <h1 className="font-mono text-base font-semibold uppercase text-[var(--color-text)] tracking-widest">
          UI Primitives · E1 Hardening Gallery
        </h1>
        <p className="mt-1 spire-body-muted">
          Every variant of every primitive that ships in <code>frontend/src/components/ui/</code>.
          Use this surface to validate touch targets (44×44 floor), focus rings, pending state,
          and the press-twice / undo-toast contracts.
        </p>
      </header>

      <Section title="Button · variants × sizes">
        <div className="grid grid-cols-4 gap-3">
          {(["primary", "secondary", "ghost", "warning"] as const).map((v) => (
            <div key={v} className="flex flex-col items-start gap-2">
              <div className="font-mono text-xs uppercase text-[var(--color-text-muted)] tracking-widest">
                {v}
              </div>
              <Button variant={v} size="sm">Small</Button>
              <Button variant={v} size="md">Medium</Button>
              <Button variant={v} size="lg">Large</Button>
              <Button variant={v} disabled>Disabled</Button>
              <Button variant={v} pending>Pending</Button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="IconButton · square 44×44 minimum">
        <div className="flex items-center gap-3">
          <IconButton aria-label="Dismiss">✕</IconButton>
          <IconButton aria-label="Refresh" variant="secondary">↺</IconButton>
          <IconButton aria-label="Download" variant="primary">↓</IconButton>
          <IconButton aria-label="Override" variant="warning">⚠</IconButton>
          <IconButton aria-label="Loading" pending>⏳</IconButton>
          <IconButton aria-label="Disabled" disabled>✕</IconButton>
        </div>
      </Section>

      <Section title="DangerButton · press-twice (default) and modal">
        <div className="flex items-center gap-3">
          <DangerButton onConfirm={() => pushUndoToast({
            text: "Item deleted",
            onUndo: () => alert("undone"),
          })}>
            Delete
          </DangerButton>
          <DangerButton confirm="modal" modalPrompt="Drop FPCON to BRAVO?" onConfirm={() => alert("dropped")}>
            Drop FPCON
          </DangerButton>
          <DangerButton confirm={false} onConfirm={() => alert("immediate")}>
            Immediate (no confirm)
          </DangerButton>
        </div>
        <div className="mt-2 spire-body-muted text-xs">
          First tap arms (red fill, "Confirm?"). Second tap fires. After 4s the button disarms.
        </div>
      </Section>

      <Section title="useIdempotentAction · triple-tap stress test">
        <div className="flex items-center gap-3">
          <Button onClick={() => idemAck.run()} pending={idemAck.pending}>
            Tap fast (count = {tapCount})
          </Button>
          <span className="font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            Lockout window 250ms · in-flight blocks subsequent taps
          </span>
        </div>
      </Section>

      <Section title="UndoToast · destructive recovery (5s floor)">
        <div className="flex flex-col gap-3">
          <Button onClick={() => pushUndoToast({
            text: "Demo: alert resolved · 5s undo window",
            onUndo: () => pushUndoToast({ text: "Restored", onUndo: () => {}, ttlMs: 2500 }),
          })}>
            Trigger global undo toast
          </Button>
          <div className="text-xs uppercase tracking-widest text-[var(--color-text-muted)]">
            Inline component variant — same ≥5s floor, mounts in-place
          </div>
          <UndoToast
            text="Demo: 3 records approved"
            onUndo={() => pushUndoToast({ text: "Demo undo fired", onUndo: () => {}, ttlMs: 2500 })}
            ttlMs={6000}
            tone="warn"
          />
        </div>
      </Section>

      <Section title="LoadingState · sizes">
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
            <LoadingState size="inline" label="Inline" />
          </div>
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] h-32">
            <LoadingState size="panel" label="Panel" />
          </div>
          <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] h-32">
            <LoadingState size="panel" waking />
          </div>
        </div>
      </Section>

      <Section title="EmptyState · CTA included">
        <div className="grid grid-cols-2 gap-3">
          <EmptyState
            title="No alerts in this view"
            description="Acknowledged alerts collapse to the bottom group. Switch the severity filter to see more."
            glyph="∅"
            action={<Button variant="secondary" size="sm">Reset filters</Button>}
          />
          <EmptyState
            title="No batches uploaded"
            description="Drop a batch on the upload tab to begin classification."
            glyph="↑"
            action={<Button size="sm">Go to upload</Button>}
          />
        </div>
      </Section>

      <Section title="ErrorState · panel and inline">
        <ErrorState
          title="Telemetry Offline"
          description="Backend may be cycling. Retry, or switch role to retrigger the fetch."
          detail="ECONNREFUSED 127.0.0.1:5000"
          onRetry={() => {
            setPending(true);
            window.setTimeout(() => setPending(false), 1200);
          }}
          retrying={pending}
        />
        <div className="mt-3">
          <ErrorState
            variant="inline"
            title="Save failed"
            description="Network blip — try again."
            onRetry={() => alert("retry")}
          />
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="mb-3 font-mono text-xs uppercase text-[var(--color-primary)] tracking-widest">
        {title}
      </h2>
      {children}
    </section>
  );
}
