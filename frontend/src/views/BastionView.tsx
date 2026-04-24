export function BastionView() {
  return (
    <div className="flex h-full items-center justify-center p-12">
      <div className="max-w-xl text-center">
        <h1 className="mb-2 text-2xl font-semibold">BASTION</h1>
        <p className="mb-1 text-sm text-[var(--color-text-secondary)]">
          Visualize force readiness and coordinate operational response.
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">
          View scaffold — COP map, alert stream, response panel, and ThermalHawk sim land here.
        </p>
      </div>
    </div>
  );
}
