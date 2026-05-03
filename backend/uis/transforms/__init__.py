"""Cell-level transforms.

Each transform takes a raw string + a context dict and returns the
coerced value (or None if the value is missing/unparseable). The
pipeline picks the transform from the column's `type` attribute on
the AdapterSpec.

Transforms are pure functions and import-safe. They have no
network or DB dependencies.
"""
from __future__ import annotations

from .dates import parse_date, parse_date_oracle, parse_date_excel, parse_datetime
from .coerce import parse_bool, parse_float, parse_int
from .hashing import hash_field, classify_hashed_field
from .enums import map_enum

__all__ = [
    "classify_hashed_field",
    "hash_field",
    "map_enum",
    "parse_bool",
    "parse_date",
    "parse_date_excel",
    "parse_date_oracle",
    "parse_datetime",
    "parse_float",
    "parse_int",
]
