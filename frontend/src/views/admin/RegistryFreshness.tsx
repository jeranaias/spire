/**
 * Task #136 — Most of `RegistryFreshness` was promoted to the
 * shared `components/Freshness.tsx` so PULSE / SENTRY / Audit can
 * use the same building blocks. The registry-specific
 * `RegistryLoadErrorTile` stays here because it surfaces the
 * `dataset/data/model_registry.json` parse failure path that only
 * the supply-chain views know how to reach.
 *
 * The other two exports (`DdilFreshnessBanner`, `FreshnessHeader`)
 * are re-exported through this module so the W1 #83 callers
 * (ModelRegistryView, ModelDetailView) don't have to chase the
 * import path.
 */
export { DdilFreshnessBanner, FreshnessHeader } from "../../components/Freshness";

/**
 * Distinct error tile for `load_error` payloads. The backend
 * returns a non-null `load_error` when
 * `dataset/data/model_registry.json` failed to parse — surfacing
 * the exception explicitly stops a parse failure from looking
 * identical to a legitimately empty registry.
 */
export function RegistryLoadErrorTile({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-[var(--color-danger-muted)] bg-[color-mix(in_oklab,var(--color-danger-muted)_18%,var(--color-surface))] p-4"
    >
      <div className="font-mono text-xs uppercase text-[var(--color-danger)] tracking-widest">
        Registry parse failure
      </div>
      <div className="mt-1 spire-body text-sm">
        SPIRE could not parse <code className="font-mono">dataset/data/model_registry.json</code>.
        The supply-chain view is suppressed until the file is repaired — this is NOT
        an empty registry.
      </div>
      <div className="mt-2 break-words rounded-sm border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
        {message}
      </div>
    </div>
  );
}
