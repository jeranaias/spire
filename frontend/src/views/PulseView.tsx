export function PulseView() {
  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="max-w-xl text-center">
        <h1 className="mb-2 text-2xl font-semibold">PULSE</h1>
        <p className="mb-1 text-sm text-[var(--color-text-secondary)]">
          Predict equipment failures and optimize maintenance decisions.
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">
          View scaffold — fleet heatmap, risk board, cannibalization, forecast, and equipment deep-dive land here.
        </p>
      </div>
    </div>
  );
}
