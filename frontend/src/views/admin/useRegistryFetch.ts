/**
 * Task #136 — `useRegistryFetch` was promoted to a generic
 * `useFreshFetch` hook so the same loadedAt + refresh + DDIL-aware
 * lifecycle could be shared across the Model Registry / Detail,
 * PULSE Risk Board, SENTRY Review Queue, and Audit · SOC views.
 *
 * This file is now a re-export shim — the original W1 #83 callers
 * (ModelRegistryView, ModelDetailView) keep their import paths
 * unchanged but resolve through to the canonical implementation in
 * `hooks/useFreshFetch.ts`.
 */
export {
  useFreshFetch,
  useRegistryFetch,
  formatLoadedAt,
  formatFreshAge,
  formatAge,
  type FreshFetchState,
} from "../../hooks/useFreshFetch";
