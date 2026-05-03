// CLASSIFICATION: UNCLASSIFIED // FOUO //

# SPIRE Universal Ingest Service (UIS) — Design

## The strategic frame

A LtGen asks "will this work immediately with GCSS-MC and the rest
of our AIS data after ATO?" The honest current-state answer is *no*
because every source today is a bespoke 200-line parser pinned to a
specific column shape; even within GCSS-MC every command's export
drifts. To say *yes* with confidence we need a **Universal Ingest
Service** — one pipeline that handles the messy reality of any
tabular feed, declarative per-source adapters that are cheap to add,
and a canonical internal data model every consumer reads from.

This document is the design contract for that service.

---

## Non-negotiables

The seven principles every line of UIS code must respect:

1. **Channel-agnostic intake.** File drop, SFTP watcher, HTTPS poll,
   email attachment intake, even copy-paste all converge into one
   internal pipeline.
2. **Format-agnostic normalization.** CSV, XLSX, TSV, JSONL, XML,
   PDF-table all reduce to a `RowStream` (iterable of dicts).
   Encoding detection, BOM strip, smart-quote normalization, line-end
   fixing happen once, in one place.
3. **Schema-flexible mapping.** Every export's columns project onto
   the canonical SPIRE Internal Data Model via a `MappingProfile`.
   First exposure: LLM proposes a mapping, operator confirms /
   edits, profile persists per (unit × source × version). Second
   exposure onward: profile auto-applies; operator just confirms.
4. **Provenance-preserving.** Every cell in the canonical dataset
   records `(source_file, source_row, source_col, raw_value, ts)`.
   An auditor can trace any number on any screen back to the source
   byte.
5. **Sanitization at the boundary.** Sensitive identifiers (UICs,
   serials, EDIPIs) get hashed at the normalize stage —
   configurable per-pipeline, audited per-event, never stored clear.
6. **Idempotent + reversible.** Same file twice = same canonical
   state. Apply takes a snapshot of the pre-state pickle so rollback
   is one operator click.
7. **Declarative adapters.** Adding a new source is ~30 lines of
   declarative spec, not a new module. The pipeline does the work.

---

## Package layout

```
backend/uis/
├── canonical/                 ← SPIRE Internal Data Model (IDM)
│   ├── schema.py              ← Pydantic-style models per entity
│   ├── registry.py            ← entity registry + precedence rules
│   └── validation.py          ← canonical-level validators
├── channels/
│   ├── base.py                ← Channel interface
│   ├── file_drop.py           ← Phase 1
│   ├── sftp_watcher.py        ← Phase 3
│   ├── https_poller.py        ← Phase 3
│   └── email_intake.py        ← Phase 3
├── formats/
│   ├── base.py                ← Format interface (raw bytes → RowStream)
│   ├── csv.py
│   ├── xlsx.py
│   ├── tsv.py
│   ├── jsonl.py
│   └── pdf_table.py           ← optional, via tabula or camelot
├── normalize/
│   ├── encoding.py            ← chardet + BOM strip + smart-quote handling
│   ├── headers.py             ← canonicalize header names
│   └── lines.py               ← line-end + whitespace normalization
├── mapping/
│   ├── profile.py             ← MappingProfile dataclass
│   ├── store.py               ← CRUD on profiles (SQLite)
│   ├── auto_map.py            ← name-similarity baseline (Phase 1)
│   ├── llm_map.py             ← LLM-assisted via tier-router (Phase 2)
│   └── apply.py               ← project source rows → canonical
├── transforms/
│   ├── dates.py               ← DD-MON-YY, YYYY-MM-DD, Excel serial, ISO
│   ├── hashing.py             ← SHA-256 with optional salt
│   ├── coerce.py              ← str → int/float/bool with fallbacks
│   └── enums.py               ← canonical-value alias maps
├── validation.py              ← row-level + cross-row constraints
├── provenance.py              ← per-cell traceback record
├── pipeline.py                ← orchestrator
└── adapters/
    ├── spec.py                ← AdapterSpec + ColumnSpec dataclasses
    ├── registry.py            ← all adapters discoverable by id
    ├── gcss_mc_ecp.py         ← declarative spec (~30 lines)
    ├── gcss_mc_util.py
    ├── gcss_mc_sr_header.py
    ├── drrs_mc.py             ← Phase 2
    ├── miles.py
    ├── tps_d.py
    └── ...
```

---

## The pipeline

```
[ANY SOURCE]
    ↓
[CHANNEL]                    ← file_drop, sftp, https, email, stdin
    ↓
[FORMAT DETECT]              ← csv | xlsx | tsv | jsonl | xml
    ↓
[NORMALIZE]                  ← encoding, BOM, smart quotes, line endings
    ↓
[HEADER CANONICALIZE]        ← "SR_NUMBER"/"sr_num"/"Sr Number" → SR_NUMBER
    ↓
[MAPPING LOOKUP]             ← MappingProfile by (source_id, version, unit)
    ↓ (no profile?)
    [AUTO-MAP HEURISTIC]     ← Levenshtein + token-set similarity
    ↓ (low confidence?)
    [LLM MAPPER]             ← tier-router proposes mapping + reasoning
    ↓
[OPERATOR REVIEW]            ← drag-drop UI: confirm/edit
    ↓
[PROFILE PERSIST]            ← saved per (unit × source × version)
    ↓
[PROJECT TO CANONICAL]       ← mapping.apply()
    ↓
[TRANSFORM]                  ← dates, hashes, type coercion, enums
    ↓
[VALIDATE]                   ← required, regex, range, cross-row
    ↓
[DRY-RUN DIFF]               ← matched / new / unchanged / stale / conflicts
    ↓ (operator confirms with preview_token)
[PRE-APPLY SNAPSHOT]         ← prior dataset pickled to .cache/uis-snapshots/
    ↓
[ATOMIC APPLY]               ← swap_dataset()
    ↓
[AUDIT CHAIN]                ← summary + per-row entries
    ↓
[CANONICAL DATASET]
```

Each stage has the stable interface so any one is swappable in
isolation. A bug in date parsing doesn't ripple into the channel
layer; a new format adds one file in `formats/` and the rest of
the pipeline is unchanged.

---

## The Internal Data Model (canonical entities)

The IDM is the *contract* every adapter produces against. There is
exactly one canonical shape per entity. All consumers (PULSE risk
board, BASTION COP, SENTRY classifier, Decision Bridge tiles) read
from the canonical dataset, never from raw source files.

| Entity | Purpose | Source-of-truth precedence |
|---|---|---|
| `Unit` | UIC, name, parent, T/O&E | DEERS > GCSS-MC > MILES > manual |
| `Asset` | TAMCN, NSN, serial, allowance, on-hand, location | GCSS-MC ECP > UTIL (for usage) > manual |
| `ServiceRequest` | SR record, defect, priority, status | GCSS-MC SR-header > parts > due-in |
| `Personnel` | EDIPI, name, billet, unit | DEERS > MILES > manual |
| `Requisition` | NSN, qty, status, RDD | GCSS-MC SR-parts > manual |
| `TMR` | Movement request | TPS-D / TC-AIMS-II > manual |
| `IncidentEvent` | PACS gate event, SCADA anomaly, METOC alert | per-source (PACS / SCADA / METOC) |
| `CRating` | Unit C-rating, MET score | DRRS-MC (only) |
| `MaintRecord` | Aviation maintenance event | ADAMS / OOMA / TAMS |

When two adapters propose conflicting values for the same field,
precedence rules in `canonical/registry.py` decide the winner. The
losing value is preserved in the provenance log.

---

## AdapterSpec — the declarative shape

```python
GCSS_MC_ECP = AdapterSpec(
    id="gcss-mc/ecp",
    name="GCSS-MC Equipment Custodian Report",
    version="1.0",
    target_entity="Asset",
    canonical_columns=[
        ColumnSpec("tamcn",            type="str",          required=True),
        ColumnSpec("nsn",              type="str"),
        ColumnSpec("serial_number",    type="str",          sensitive=True, hash_prefix="SERIAL_NUMBER"),
        ColumnSpec("nomenclature",     type="str"),
        ColumnSpec("owner_uic",        type="str",          sensitive=True, hash_prefix="OWNER_UIC"),
        ColumnSpec("allowance_qty",    type="int",          default=0),
        ColumnSpec("on_hand_qty",      type="int",          default=0),
        ColumnSpec("last_inventory_date", type="date_oracle"),
    ],
    primary_key=["serial_number"],
    fallback_key=["tamcn", "owner_uic"],
    constraints=[
        RowConstraint("at_least_one_of", fields=["tamcn", "serial_number"]),
    ],
    sample_path="dataset/fixtures/gcss_mc_ecp_sample.csv",
)
```

That's the entire adapter. Header normalization, format detect,
date parsing, hashing, type coercion, validation, mapping
inference, dry-run diff, and apply all come from the pipeline.

---

## Channel/Format/Transform interfaces

Each layer has a stable contract:

```python
class Channel(Protocol):
    """Where files come from."""
    def poll(self) -> Iterable[IngestEnvelope]: ...

class Format(Protocol):
    """How raw bytes become a RowStream."""
    def detect(self, head: bytes) -> bool: ...
    def stream(self, raw: bytes) -> RowStream: ...

class Transform(Protocol):
    """How a single cell value gets coerced."""
    def __call__(self, raw: str, ctx: TransformContext) -> Any: ...
```

This means:
- A new SOURCE (DRRS-MC, MILES) = one declarative AdapterSpec.
- A new CHANNEL (S3 bucket, AWS Eventbridge) = one Channel implementation.
- A new FORMAT (XML, fixed-width) = one Format implementation.
- A new TRANSFORM (parse weird date format, decode obscure status code) = one Transform.

---

## Mapping profiles

A `MappingProfile` is what makes the system *learnable*: every time
an operator confirms a mapping, the system remembers. Next time
that unit drops a file with the same source-id, the mapping
auto-applies.

```python
@dataclass
class MappingProfile:
    profile_id: str                     # "3d-mlr/gcss-mc-ecp/v2026.04"
    source_id: str                      # "gcss-mc/ecp"
    unit: Optional[str]                 # "3d MLR" or None for fleet-wide
    source_version: Optional[str]       # operator-tagged
    column_map: Dict[str, str]          # source_col → canonical_col
    cell_transforms: Dict[str, str]     # canonical_col → transform_id
    operator_notes: str
    created_by: str                     # DODID
    created_at: str
    confirmed_at: Optional[str]
    confidence: float                   # 0..1 (1 = operator-confirmed)
```

Profiles are stored in SQLite (alongside the audit chain) and
versioned: when GCSS-MC adds a column, the operator creates a new
profile rather than mutating the old one. Old data ingested under
the old profile remains traceable.

---

## Provenance

Every canonical cell carries a back-pointer:

```python
@dataclass
class CellProvenance:
    canonical_entity: str        # "Asset"
    canonical_field: str         # "serial_number"
    canonical_id: str            # "M21670-MTVR_CARGO-006"
    source_file_id: str          # SHA-256 truncated of the upload
    source_row_idx: int
    source_col_name: str
    raw_value: str               # before any transform
    transform_chain: List[str]   # ["normalize", "hash:SHA-256:OWNER_UIC"]
    sanitized: bool
    ingested_at: str
    profile_id: str
```

Stored in a `provenance` table; queryable from the Audit SOC view.
This is the answer to *"where did this number come from?"* — the
auditor can click any cell and walk back to the byte.

---

## Phase plan

| Phase | Days | Deliverables |
|---|---|---|
| **1 — Foundation** | 5 | Design doc · package skeleton · canonical IDM · AdapterSpec/ColumnSpec · format detect + row-stream · header normalizer · transform library · ECP/UTIL/SR-header migrated to declarative specs |
| **2 — Intelligence** | 5 | LLM-assisted schema mapper through tier-router · MappingProfile CRUD endpoints · auto_map heuristic baseline · drag-drop column mapper UI · profile editor |
| **3 — Channels** | 5 | SFTP watcher · HTTPS poller (with auth + schedule) · email-attachment intake · stdin/CLI for terminal-paste · channel-config UI |
| **4 — Trust** | 5 | Per-cell provenance write + query · pre-apply snapshot + rollback · ingest-health dashboard (last-run / success rate / failure samples) · per-pilot configuration UI · provenance browser in Audit SOC |

20 working days end-to-end. Phase 1 alone makes the existing 3
adapters declarative and unblocks any new tabular adapter at ~30
lines.

---

## Test strategy

Per phase:
- **Phase 1**: parser unit tests for every format (CSV/XLSX/TSV/JSONL with messy fixtures); transform unit tests covering Oracle dates, Excel serial dates, ISO 8601, smart quotes, embedded BOMs, mixed encodings; AdapterSpec round-trip tests.
- **Phase 2**: LLM mapper test harness with synthetic "messy" GCSS-MC exports (renamed cols, reordered cols, dropped optional cols); profile persistence + recall.
- **Phase 3**: integration test per channel (live SFTP server in CI; mock HTTPS endpoint; mailpit for email).
- **Phase 4**: provenance round-trip; rollback recovers exact prior state; health dashboard surfaces injected failures.

Target: 100+ tests across the package. Today's 44 ingest tests
become Phase 1's regression suite; the migrated adapters reuse
them through the new pipeline.

---

## Backwards-compatibility plan

The existing `/api/ingest/gcss-mc/{ecp,util,sr-header}` routes and
`stage-ingest` keep working through Phase 1. The UIS pipeline runs
behind them — same external contract, new internals. Phase 2 adds
the new generic `/api/uis/upload` route. Once UI migrates to the
generic upload flow, the old routes become aliases.

---

## What this unlocks for the LtGen

After Phase 1: "drop any reasonable CSV/XLSX in the canonical
shape" — works.

After Phase 2: "drop any reasonable CSV/XLSX whose columns are
*similar* to canonical, the system proposes the mapping, you
confirm" — works.

After Phase 3: "wire up an SFTP push from the GCSS terminal, files
land overnight" — works.

After Phase 4: "the auditor traces a number on screen back to the
exact byte in the original file" — works. "We rolled back yesterday's
ingest because the file was bad" — works.

That's the path from "yes after ATO + 30–60 days of pilot
reconciliation" to "yes, plug it in and it just works."
