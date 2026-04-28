/**
 * Public surface of the classification primitives.
 *
 * Import from "@/components/classification" rather than reaching into the
 * individual files; the indirection keeps the gate API consolidated and lets
 * the implementation file layout evolve without rippling through call sites.
 */
export {
  CLASS_RANK,
  CLASS_ORDER,
  CLASS_LABEL,
  CLASS_COLOR,
  classificationLabel,
  classificationRank,
  classificationColors,
  clearanceRank,
  meetsClearance,
  normalizeClassification,
  isMonotonicClassification,
} from "./levels";
export type { Classification } from "./levels";
export { useClearance } from "./useClearance";
export type { ClearanceCtx } from "./useClearance";
export { ClassificationBadge } from "./ClassificationBadge";
export { ClassifiedExport } from "./ClassifiedExport";
