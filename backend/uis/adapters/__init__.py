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

# Import each adapter module so its `register_adapter(...)` call
# fires at package-import time. Listing them here is the discovery
# mechanism — no plugin scan, no entry-point auto-load. Adding a
# new source = drop a file in this directory + add the import line.
from . import gcss_mc_ecp        # noqa: F401
from . import gcss_mc_util       # noqa: F401
from . import gcss_mc_sr_header  # noqa: F401
from . import drrs_mc            # noqa: F401

__all__ = [
    "ADAPTERS",
    "AdapterSpec",
    "ColumnSpec",
    "RowConstraint",
    "get_adapter",
    "register_adapter",
]
