"""AdapterSpec + ColumnSpec — the declarative shape every source uses.

Adding a new source system is now ~30 lines of declaration. The
pipeline walks the spec to derive:

  * which canonical entity to write
  * what columns to expect (after mapping)
  * how to coerce each cell (date / int / float / str)
  * which fields are sensitive (hash at the boundary)
  * which fields uniquely identify a row (primary_key)
  * what fallback identification to try (fallback_key)
  * what cross-row constraints apply

This module is import-safe and has no behavioral side effects. It's
metadata. The pipeline lives in `backend/uis/pipeline.py`.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, List, Literal, Optional, Tuple


# Canonical types the transform library knows how to produce. The
# pipeline maps a `ColumnSpec.type` to a Transform callable in
# `backend.uis.transforms`.
CanonicalType = Literal[
    "str",          # passthrough (with whitespace strip)
    "int",          # _parse_int (tolerates floats + thousand separators)
    "float",        # _parse_float (tolerates scientific notation, locale commas)
    "bool",         # _parse_bool (true/yes/1/y vs false/no/0/n)
    "date",         # ISO 8601 (YYYY-MM-DD)
    "date_oracle",  # DD-MON-YY (sliding-window two-digit years)
    "date_excel",   # Excel serial date (numeric days since 1900-01-01)
    "datetime",     # ISO 8601 with time
    "enum",         # see ColumnSpec.enum_aliases
]


@dataclass
class ColumnSpec:
    """One canonical column on the target entity.

    The `name` attribute MUST match a field name on the canonical
    entity (e.g. `Asset.serial_number`). The pipeline will refuse to
    register an adapter that names a non-existent field.
    """

    name: str                                       # canonical field name
    type: CanonicalType = "str"
    required: bool = False
    default: Any = None
    sensitive: bool = False                         # hash at boundary
    hash_prefix: Optional[str] = None               # used when sensitive=True
    hash_alg: Literal["sha256"] = "sha256"
    enum_aliases: Optional[dict] = None             # raw → canonical for type="enum"
    description: str = ""
    # Allow per-spec custom transform when the library doesn't fit.
    # Receives the raw string + a context dict; returns the coerced value.
    custom_transform: Optional[Callable[[str, dict], Any]] = None


@dataclass
class RowConstraint:
    """Cross-field constraint enforced after row-level transforms.

    Common kinds:
      - "at_least_one_of"  → fields=[...]; reject row if all empty
      - "exactly_one_of"   → fields=[...]
      - "regex"            → field=str + pattern=str
      - "range"            → field=str + min=Number + max=Number
      - "custom"           → predicate=Callable[[row], bool]
    """

    kind: str
    fields: List[str] = field(default_factory=list)
    pattern: Optional[str] = None
    min: Optional[float] = None
    max: Optional[float] = None
    predicate: Optional[Callable[[dict], bool]] = None
    message: str = ""


@dataclass
class AdapterSpec:
    """Declarative spec for one source system.

    The minimum spec is `id`, `target_entity`, and `canonical_columns`;
    everything else has sensible defaults.

    Examples
    --------

        ECP = AdapterSpec(
            id="gcss-mc/ecp",
            target_entity="Asset",
            canonical_columns=[
                ColumnSpec("tamcn", required=True),
                ColumnSpec("serial_number", sensitive=True, hash_prefix="SERIAL_NUMBER"),
                ColumnSpec("allowance_qty", type="int"),
                ColumnSpec("last_inventory_date", type="date_oracle"),
            ],
            primary_key=["serial_number"],
            fallback_key=["tamcn", "owner_uic"],
        )
    """

    id: str                                         # "gcss-mc/ecp"
    target_entity: str                              # "Asset"
    canonical_columns: List[ColumnSpec]
    name: str = ""                                  # human-readable
    version: str = "1.0"
    primary_key: List[str] = field(default_factory=list)
    fallback_key: List[str] = field(default_factory=list)
    constraints: List[RowConstraint] = field(default_factory=list)
    sample_path: Optional[str] = None               # for tests + UI preview
    auth_roles: Tuple[str, ...] = ("data_custodian", "security_manager")
    description: str = ""

    def field_names(self) -> List[str]:
        return [c.name for c in self.canonical_columns]

    def column(self, name: str) -> ColumnSpec:
        for c in self.canonical_columns:
            if c.name == name:
                return c
        raise KeyError(f"Adapter {self.id!r} has no column {name!r}")

    def required_columns(self) -> List[str]:
        return [c.name for c in self.canonical_columns if c.required]

    def sensitive_columns(self) -> List[str]:
        return [c.name for c in self.canonical_columns if c.sensitive]
