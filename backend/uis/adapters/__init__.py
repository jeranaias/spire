"""Declarative adapter specs.

One file per source system. Each module exports an `ADAPTER` symbol
of type `AdapterSpec`. The pipeline uses the spec to derive the full
ingest behavior — format detection, header normalization, type
coercion, hashing, validation, dry-run diff, apply.

Adding a new source = one ~30-line file in this directory plus
registration in `registry.py`.
"""
from __future__ import annotations

from .spec import AdapterSpec, ColumnSpec, RowConstraint
from .registry import ADAPTERS, get_adapter, register_adapter

__all__ = [
    "ADAPTERS",
    "AdapterSpec",
    "ColumnSpec",
    "RowConstraint",
    "get_adapter",
    "register_adapter",
]
