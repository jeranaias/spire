/**
 * Classification + clearance primitives — the load-bearing contract every
 * download/export gate reads.
 *
 * The rank is monotone (UNCLAS=0 → TS//SCI=5). A user "meets" a required
 * classification when their clearance rank is >= the artifact's rank.
 *
 * Strings are normalized aggressively: "TS//SCI", "TS_SCI", "TOP SECRET//SCI"
 * all collapse to the same rank. Defensive against operator-typed and
 * cert-imported variants.
 */
import type { User } from "../../state/store";

export type Classification =
  | "UNCLASSIFIED"
  | "CUI"
  | "CONFIDENTIAL"
  | "SECRET"
  | "TOP_SECRET"
  | "TS_SCI";

// Demo build: cap visible options at CUI. The full classification rank
// model (SECRET / TOP_SECRET / TS_SCI) stays in the type union because
// downstream Joint exports / SENTRY release pipelines reference those
// keys, but no UI surface should offer them as a selectable option in
// a public demo. Move to all-six only when the deployment is on a
// classified network.
export const CLASS_ORDER: Classification[] = [
  "UNCLASSIFIED",
  "CUI",
];

export const CLASS_RANK: Record<Classification, number> = {
  UNCLASSIFIED: 0,
  CUI: 1,
  CONFIDENTIAL: 2,
  SECRET: 3,
  TOP_SECRET: 4,
  TS_SCI: 5,
};

// CAPCO color — same palette as the global ClassificationBannerStrip. Solid color
// blocks, no decorative gradient. Matches DoDM 5200.01 / ICS 700-1 swatches.
// Demo build: cap colors at CUI purple. See CLASS_LABEL above for the
// rationale — anything above CUI in the rank model collapses to CUI
// rendering so no red/orange/yellow CAPCO swatch ever appears on
// screen.
export const CLASS_COLOR: Record<Classification, { bg: string; fg: string }> = {
  UNCLASSIFIED: { bg: "#007A33", fg: "#FFFFFF" },
  CUI:          { bg: "#502B85", fg: "#FFFFFF" },
  CONFIDENTIAL: { bg: "#502B85", fg: "#FFFFFF" },
  SECRET:       { bg: "#502B85", fg: "#FFFFFF" },
  TOP_SECRET:   { bg: "#502B85", fg: "#FFFFFF" },
  TS_SCI:       { bg: "#502B85", fg: "#FFFFFF" },
};

// Demo build: ANY classification at or above CONFIDENTIAL renders as
// "CUI" so no SECRET / TOP SECRET text ever leaks to the screen, even
// if a stale fixture or upstream call hands us one of the higher keys.
// The full label set returns when the deployment is on a classified
// network — flip these back via a build-time toggle then.
export const CLASS_LABEL: Record<Classification, string> = {
  UNCLASSIFIED: "UNCLASSIFIED",
  CUI:          "CUI",
  CONFIDENTIAL: "CUI",
  SECRET:       "CUI",
  TOP_SECRET:   "CUI",
  TS_SCI:       "CUI",
};

// Normalize an arbitrary string to one of the canonical Classification keys.
// Falls back to UNCLASSIFIED for unknowns rather than throwing — the gate
// stays permissive for well-formed UNCLAS records and the operator never
// sees a hard error from a typo upstream.
export function normalizeClassification(raw: string | null | undefined): Classification {
  if (!raw) return "UNCLASSIFIED";
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, "_").replace(/\/+/g, "_");
  if (s.includes("SCI") && (s.includes("TS") || s.includes("TOP_SECRET"))) return "TS_SCI";
  if (s.includes("TOP_SECRET") || s === "TS") return "TOP_SECRET";
  if (s.includes("SECRET") && !s.includes("TOP")) return "SECRET";
  if (s.includes("CONFIDENTIAL")) return "CONFIDENTIAL";
  if (s === "CUI" || s.includes("CONTROLLED") || s === "FOUO" || s === "C__I") return "CUI";
  if (s.includes("UNCLAS")) return "UNCLASSIFIED";
  return "UNCLASSIFIED";
}

export function classificationRank(raw: string | null | undefined): number {
  return CLASS_RANK[normalizeClassification(raw)];
}

export function clearanceRank(raw: string | null | undefined): number {
  return CLASS_RANK[normalizeClassification(raw)];
}

export function classificationLabel(c: Classification | string): string {
  return CLASS_LABEL[normalizeClassification(c)];
}

export function classificationColors(c: Classification | string): { bg: string; fg: string } {
  return CLASS_COLOR[normalizeClassification(c)];
}

export function meetsClearance(user: User | null, required: Classification | string): boolean {
  if (!user) return false;
  return clearanceRank(user.clearance) >= classificationRank(required);
}

// "Monotonic write" predicate. True if `next` is at the same level or higher
// than `prev`. Used by the downgrade-write block — surface only, the actual
// downgrade-with-justification flow is out of scope for this lane.
export function isMonotonicClassification(
  prev: Classification | string | null | undefined,
  next: Classification | string,
): boolean {
  const p = classificationRank(prev);
  const n = classificationRank(next);
  return n >= p;
}
