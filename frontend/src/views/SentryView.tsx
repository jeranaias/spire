export function SentryView() {
  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="max-w-xl text-center">
        <h1 className="mb-2 text-2xl font-semibold">SENTRY</h1>
        <p className="mb-1 text-sm text-[var(--color-text-secondary)]">
          Sanitize and secure logistics data for cross-domain sharing.
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">
          View scaffold — upload, data-quality gate, processing animation, review queue, and export land here.
        </p>
      </div>
    </div>
  );
}
