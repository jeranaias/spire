// Task #150 — single source of truth for the "why was this held?" vocabulary
// the operator sees on the Processing tab's SanitizedRecord and the Review
// Queue's InspectorPane.
//
// Three things are surfaced per record on the wire from
// backend/routes/sentry.py:
//
//   - held_reasons[]      -- engine-level routing reason (ambiguous_pii,
//                            low_confidence_evidence, novel_pattern,
//                            classification_discrepancy)
//   - mismatch_severity   -- spillage_risk | marking_error (only when
//                            classification_discrepancy is also set)
//   - highlights[].rule   -- per-pattern rule that fired (pii_edipi,
//                            pii_ssn4, geo_mgrs, comms_freq, ...)
//
// Each value below maps the raw enum to a short Marine-voice chip label
// plus a longer hover tooltip so the operator (or a Marine making the hold
// call at the projector) sees the *mechanical* reason for the redaction,
// not just the bucket.

export const HELD_REASON_LABEL: Record<string, string> = {
  classification_discrepancy: "marking mismatch",
  ambiguous_pii: "ambiguous PII",
  low_confidence_evidence: "low-confidence evidence",
  novel_pattern: "novel pattern",
};

export const HELD_REASON_DESCRIPTION: Record<string, string> = {
  classification_discrepancy:
    "Source marking and detected marking diverge — review for correctness.",
  ambiguous_pii:
    "Possible PII without supporting context (no EDIPI/SSN/phone). Could be a false positive.",
  novel_pattern:
    "Combination of evidence (controlled item + grid) the engine has not seen before.",
  low_confidence_evidence:
    "Multiple flag categories but classifier confidence is below 0.90.",
};

export const MISMATCH_SEVERITY_LABEL: Record<string, string> = {
  spillage_risk: "spillage risk",
  marking_error: "marking error",
};

export const MISMATCH_SEVERITY_DESCRIPTION: Record<string, string> = {
  spillage_risk:
    "Source marked UNCLASSIFIED but engine recommends SECRET-or-higher. Potential spillage.",
  marking_error:
    "Source marking does not match recommended marking. Likely under-marking error.",
};

// Rule-level chip vocabulary. Mirrors the PATTERNS dict in
// backend/routes/sentry.py — one entry per regex name. The chip text is
// what the operator reads on the card; the tooltip explains the pattern
// in plain language so the audit trail is legible without grep'ing the
// regex source.
export const RULE_LABEL: Record<string, string> = {
  pii_edipi: "EDIPI pattern matched",
  pii_ssn4: "SSN-last-4 pattern",
  pii_poc: "POC name pattern",
  pii_ext: "phone-extension pattern",
  geo_mgrs: "MGRS grid coordinate",
  comms_freq: "comms frequency (MHz)",
  comms_kgv: "KGV crypto device",
  comms_kg: "KG crypto device",
  comms_kiv: "KIV crypto device",
  cls_tm: "classified TM reference",
  ctrl_sn: "controlled serial number",
};

export const RULE_DESCRIPTION: Record<string, string> = {
  pii_edipi: "10-digit DoD EDIPI literal preceded by 'EDIPI'.",
  pii_ssn4: "Last-four SSN literal in the same sentence as 'SSN'.",
  pii_poc: "POC field with a name token following.",
  pii_ext: "4-digit phone extension following 'ext'.",
  geo_mgrs: "Military Grid Reference System coordinate (zone-band-100km-easting-northing).",
  comms_freq: "Tactical comms frequency in MHz.",
  comms_kgv: "KGV-series crypto fill device serial.",
  comms_kg: "KG-series crypto fill device serial.",
  comms_kiv: "KIV-series crypto fill device serial.",
  cls_tm: "Bracketed classified technical-manual reference.",
  ctrl_sn: "USA/USMC-prefixed serial number on a controlled item.",
};

export function ruleLabel(name: string | undefined | null): string {
  if (!name) return "pattern match";
  return RULE_LABEL[name] ?? name;
}

export function ruleDescription(name: string | undefined | null): string | undefined {
  if (!name) return undefined;
  return RULE_DESCRIPTION[name];
}

export function heldReasonLabel(name: string): string {
  return HELD_REASON_LABEL[name] ?? name.replace(/_/g, " ");
}

export function heldReasonDescription(name: string): string | undefined {
  return HELD_REASON_DESCRIPTION[name];
}

export function mismatchSeverityLabel(severity: string | undefined | null): string {
  if (!severity) return "marking error";
  return MISMATCH_SEVERITY_LABEL[severity] ?? severity.replace(/_/g, " ");
}

export function mismatchSeverityDescription(severity: string | undefined | null): string | undefined {
  if (!severity) return undefined;
  return MISMATCH_SEVERITY_DESCRIPTION[severity];
}
