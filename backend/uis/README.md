# SPIRE Universal Ingest Service (UIS)

A **schema-flexible, format-agnostic file-ingest pipeline** that turns
arbitrary tabular data (CSV / TSV / JSONL / XLSX) into rows that
conform to a canonical Internal Data Model.

This package was built inside SPIRE for ingesting GCSS-MC, DRRS-MC,
MILES, and similar USMC logistics-system exports — but it has
**zero hard dependencies on the SPIRE backend**. The whole package
extracts cleanly and ships as a standalone library.

## What it gives you

- **Format detection** (`uis.formats`) — sniff CSV / TSV / JSONL /
  XLSX from magic bytes + delimiter sampling. Tolerates Oracle
  comment headers and European-Excel `;` delimiters.
- **Encoding hardening** (`uis.normalize`) — UTF-8 / UTF-8-sig /
  UTF-16 LE/BE (BOM-detected and BOM-less) / cp1252 fallback /
  latin-1 last-resort with a low-confidence flag so callers can
  warn the operator instead of silently corrupting Latin-1
  decode of a UTF-16 file.
- **Header canonicalization** (`uis.normalize.headers`) — collapse
  `"SR_NUMBER"` / `"sr_number"` / `"Sr Number"` /
  `"ServiceRequestNumber"` to one comparison key.
- **Two-stage column mapping** (`uis.mapping`) —
  alias-exact-match (Stage 1) → Jaccard token similarity
  (Stage 2). Optional LLM-assisted Stage 3 fills the unmapped
  tail; LLM caller is injectable for embedded use.
- **Type coercion** (`uis.transforms`) — Oracle DD-MON-YY dates
  with sliding-window two-digit years, ISO 8601, Excel serial
  dates, int/float/bool tolerant of thousand separators +
  scientific notation + null sentinels, sensitive-field hashing
  with provenance label, enum aliasing.
- **Pipeline orchestrator** (`uis.pipeline`) — one function takes
  bytes + an `AdapterSpec` and returns canonical rows + a
  structured `ParseReport`. Per-row sanitization labels and
  warning codes are surfaced in parallel arrays so callers can
  reconstruct legacy per-row dataclass shapes.
- **MappingProfile persistence** (`uis.mapping.store`) — SQLite-
  backed CRUD for confirmed mappings. Lookup by
  `(source_id, unit)` with most-specific-wins. Connection
  factory is injectable.
- **Declarative AdapterSpecs** (`uis.adapters`) — adding a new
  source is ~30 lines of declarative spec, not a parser. Auto-
  registration via package import.

## Quickstart

```python
from backend.uis.adapters.spec import AdapterSpec, ColumnSpec
from backend.uis.adapters.registry import register_adapter
from backend.uis.pipeline import run_pipeline

# 1. Declare the adapter (~30 lines)
MY_ADAPTER = register_adapter(AdapterSpec(
    id="my-system/inventory",
    target_entity="Asset",
    canonical_columns=[
        ColumnSpec("sku",     required=True),
        ColumnSpec("on_hand", type="int", default=0),
        ColumnSpec("last_count_date", type="date_oracle"),
    ],
    primary_key=["sku"],
))

# 2. Run the pipeline
with open("inventory.csv", "rb") as f:
    raw = f.read()

result = run_pipeline(raw, MY_ADAPTER)

print(f"Format: {result.report.detected_format}")
print(f"Encoding: {result.report.detected_encoding}")
print(f"Rows kept: {result.report.rows_kept}")
print(f"Auto-mapper confidence: {result.report.auto_mapper_confidence:.2f}")
for row in result.rows[:5]:
    print(row)
```

That's the entire integration if you don't need profiles or LLM
mapping. With those:

```python
from backend.uis.mapping import (
    MappingProfile, create_profile, find_profile, set_connection_factory,
    ensure_schema,
)

# Inject your own SQLite connection factory (skip if running
# inside SPIRE — backend.persistence wires this for you)
import sqlite3
from contextlib import contextmanager

@contextmanager
def my_conn():
    c = sqlite3.connect("./uis.sqlite")
    c.row_factory = sqlite3.Row
    try:
        yield c; c.commit()
    finally:
        c.close()

set_connection_factory(my_conn)
ensure_schema()

# Save a confirmed mapping after the operator confirms it
profile = MappingProfile(
    profile_id="3d-mlr/my-system/v2026-04",
    source_id="my-system/inventory",
    unit="3d MLR",
    column_map={"SKU_Code": "sku", "On Hand": "on_hand"},
    confirmed_at="2026-05-03T10:00:00+00:00",
)
create_profile(profile)

# Auto-apply on next ingest of the same shape
hit = find_profile(source_id="my-system/inventory", unit="3d MLR")
assert hit and hit.profile_id == "3d-mlr/my-system/v2026-04"
result = run_pipeline(raw, MY_ADAPTER, profile=hit)
```

## LLM-assisted mapping

```python
from backend.uis.mapping.llm_map import propose_mapping_with_llm

# llm_caller is an injectable async callable. Default in SPIRE
# routes through the existing tier-router. For embedded use, pass
# your own async function returning OpenAI-shaped completions.
async def my_caller(*, messages, **kwargs):
    return await openai.chat.completions.create(model="...", messages=messages, ...)

proposal = await propose_mapping_with_llm(
    source_columns=["TAMCN_Code", "Description", "On-Hand Count"],
    adapter=MY_ADAPTER,
    sample_rows=[{"TAMCN_Code": "D1196", "Description": "JLTV", "On-Hand Count": "12"}],
    llm_caller=my_caller,
)
print(proposal.column_map)
print(proposal.reasoning_per_field)
```

The LLM mapper redacts sensitive cell values (heuristically named
columns + auto-mapped sensitive targets) before sending samples
upstream, so a pre-sanitization upload doesn't leak clear PII.

## Package structure

```
backend/uis/
├── canonical/      Internal Data Model (entities + precedence)
├── adapters/       Declarative AdapterSpec + registered adapters
├── formats/        CSV / TSV / JSONL / XLSX detect + stream
├── normalize/      Encoding fallback + header canonicalization
├── mapping/        Auto + LLM mapping, MappingProfile CRUD
├── transforms/     Date / coerce / hash / enum cell-level
├── pipeline.py     Orchestrator: bytes → canonical rows
└── route_helpers.py  Bridge to legacy ParsedAssetRow shapes (SPIRE-internal)
```

Anything in `route_helpers.py` is SPIRE-internal glue. Everything
else is library-grade and import-safe. The package's only
optional dependency is `openpyxl` (XLSX) and `charset_normalizer`
(better-than-heuristic encoding fallback) — both gracefully
degrade when absent.

## Tests

```
pytest tests/uis/
```

200+ tests cover the pipeline, transforms, formats, normalize,
auto-mapper, LLM mapper, profile store, route handlers. Each
adapter ships with sample fixtures or smoke tests proving
canonical-row output.

## Adding a new source

1. Create `backend/uis/adapters/{my_source}.py`:
   ```python
   from .registry import register_adapter
   from .spec import AdapterSpec, ColumnSpec

   ADAPTER = register_adapter(AdapterSpec(
       id="my-source/dataset",
       target_entity="Asset",  # or any IDM entity
       canonical_columns=[
           ColumnSpec("foo", required=True, source_aliases=["FOO_CODE"]),
           ColumnSpec("bar", type="int"),
       ],
       primary_key=["foo"],
   ))
   ```

2. Add the import to `backend/uis/adapters/__init__.py` so it
   auto-registers at package import.

3. Done. The pipeline + auto-mapper + LLM mapper + profile store
   all work for the new source without further code.

## License + extraction

Inside SPIRE, this package follows the SPIRE license. For
open-source extraction, the package has no proprietary dependencies
— it's pure-Python with optional `openpyxl` / `charset_normalizer`
extras. The only file with an explicit SPIRE coupling is
`backend/uis/route_helpers.py` (legacy adapter-row bridge); skip
that file when extracting.
