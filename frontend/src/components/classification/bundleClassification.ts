/**
 * Bundle classification — auto-stamp the highest classification present in
 * a multi-row export and produce a one-line provenance note explaining the
 * stamp ("stamped SECRET because 4 of 24 rows are SECRET").
 *
 * The rule: the bundle stamp must reflect the *contents* of the bundle, not
 * the operator's filter chip or any other UI-level intent. Passing the
 * operator's chip is what created the Task #37 spillage hatch — a blank
 * Classification chip caused mixed bundles to mis-stamp UNCLASSIFIED. This
 * helper exists to make the right answer the easy answer at every export
 * call site, and to keep the rule in one place rather than scattered as
 * inline copy/paste.
 *
 * Rows with no `classification` field collapse to UNCLASSIFIED (matches
 * `normalizeClassification`'s permissive fallback). This is intentional:
 * a missing classification means the upstream did not declare one, and a
 * silent UNCLAS default is safer than throwing in the middle of a download
 * click. Callers that want a stricter contract should validate row shapes
 * before passing them in.
 */
import {
  CLASS_RANK,
  classificationLabel,
  normalizeClassification,
  type Classification,
} from "./levels";

/**
 * Minimal row shape the helper reads. Designed to be structurally satisfied
 * by `AuditEntry`, `SentryRecord`, and any future row type that carries a
 * `classification` string — callers do not need to map their rows down to
 * a smaller shape first.
 */
export interface BundleRow {
  classification?: string | null;
}

export interface BundleClassification {
  /** Max classification across all rows (UNCLASSIFIED for an empty bundle). */
  level: Classification;
  /** Per-level row counts, useful for debug surfaces. */
  counts: Partial<Record<Classification, number>>;
  /** Human-readable provenance string for the export hint + audit payload. */
  provenance: string;
}

export function computeBundleClassification(
  rows: readonly BundleRow[],
): BundleClassification {
  const counts: Partial<Record<Classification, number>> = {};
  let maxRank = 0;
  let maxLevel: Classification = "UNCLASSIFIED";
  for (const r of rows) {
    const lvl = normalizeClassification(r?.classification);
    counts[lvl] = (counts[lvl] ?? 0) + 1;
    const rk = CLASS_RANK[lvl];
    if (rk > maxRank) {
      maxRank = rk;
      maxLevel = lvl;
    }
  }
  const total = rows.length;
  const atLevel = counts[maxLevel] ?? 0;
  const label = classificationLabel(maxLevel);
  const provenance =
    total === 0
      ? `stamped ${label} (empty bundle — defaulted to UNCLASSIFIED)`
      : `stamped ${label} because ${atLevel} of ${total} row${total === 1 ? "" : "s"} ${atLevel === 1 ? "is" : "are"} ${label}`;
  return { level: maxLevel, counts, provenance };
}
