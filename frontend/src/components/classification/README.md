# classification/

Shared primitives for clearance gating, classification badges, and the
`<ClassifiedExport>` button that wraps every download in SPIRE.

## The rule

> **Don't pass the operator's filter chip. Pass the rows.**

The `<ClassifiedExport>` primitive accepts the bundle's classification two
different ways. Pick the one that matches what's actually being exported:

- **`rows={…}` — multi-row bundles assembled client-side.** Pass the array
  of records that will go into the download. The primitive runs
  `computeBundleClassification(rows)` to produce both the visible badge and
  the spillage gate from `max(row.classification)`, plus a one-line
  provenance string ("stamped SECRET because 4 of 24 rows are SECRET")
  surfaced in the hint.
- **`classification={…}` — single artifacts.** Use this for one PDF, one
  attestation, or for bundles where the classification is rolled up
  *server-side* before the FE ever sees the records (e.g. the SENTRY
  sanitized bundle: the FE only learns `result.classification`, not the
  per-record levels). The caller is asserting "this is the artifact's stamp;
  there are no FE-side rows to roll up".

Use exactly one. The TypeScript types enforce this — passing both is a
compile error.

## Why the rule exists (Task #37 → Task #89)

The original `<ClassifiedExport>` only had a `classification` prop. The
audit-export call site passed `classification || "UNCLASSIFIED"`, where
`classification` was the operator's *filter chip* — a UI selection, not a
property of the data. With a blank chip, a bundle full of SECRET rows got
stamped UNCLASSIFIED at the click. That was the one-click spillage hatch
fixed under Task #37 by computing `max(row.classification)` inline at the
audit call site.

Task #89 hoists that fix into the primitive itself so the same bug class
cannot recur the next time someone wires up a multi-row download. The
helper (`computeBundleClassification`) lives next to the primitive in
`bundleClassification.ts` so any future caller can use the same rule
without copy/paste — and so reviewers grepping for "operator chip stamp"
land on a single place that documents the right answer.

## What NOT to pass to `rows`

- The operator's classification *filter chip*. The chip describes what
  they wanted to see, not what's actually in the bundle.
- The currently visible *page* of a paginated table. Pagination must not
  be able to flip the gate; pass the export window (the rows that
  `onExport` will actually package).
- A made-up "expected" level. Either pass real rows, or use the
  single-artifact `classification` prop and own the assertion explicitly.

## What lives in this directory

| File | Purpose |
| --- | --- |
| `levels.ts` | Canonical `Classification` enum, ordering, color/label maps, and `normalizeClassification` (defensive string parser). |
| `bundleClassification.ts` | `computeBundleClassification(rows)` — the shared "max(row) + provenance" helper. |
| `ClassificationBadge.tsx` | The CAPCO-colored chip used inline on buttons and headers. |
| `ClassifiedExport.tsx` | The export-button primitive (this README's main subject). |
| `useClearance.ts` | Hook returning `(user, clearance, can)` — used by every gate. |
| `index.ts` | Public surface. Import from `@/components/classification`, not the individual files. |
