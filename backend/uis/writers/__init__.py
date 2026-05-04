"""Writer protocol + registry.

Phase 3 unlock: any registered adapter can write to the canonical
dataset through one generic apply path. Each adapter pairs with an
``EntityWriter`` that knows how to:

  1. Fingerprint the relevant slice of canonical state for optimistic
     concurrency (``state_token``).
  2. Compute the dry-run diff against canonical (``preview``).
  3. Mutate-and-return a new ``CanonicalDataset`` (``apply``).

Routes own the HTTP shell (auth, audit, file IO, token comparison).
Writers own the entity-specific merge logic. The split is what lets
``/api/uis/upload?apply=1`` dispatch any adapter without bespoke
route code per source.
"""
from __future__ import annotations

from .base import (
    WRITERS,
    EntityWriter,
    WriterApplyResult,
    WriterDiff,
    get_writer,
    has_writer,
    register_writer,
)

# Auto-import writer modules so their `register_writer(...)` calls
# fire at package-load time. Adding a new writer = drop the file in
# this package + import it here.
from . import asset_ecp  # noqa: F401  — side-effect: register
from . import asset_util  # noqa: F401  — side-effect: register

__all__ = [
    "EntityWriter",
    "WriterDiff",
    "WriterApplyResult",
    "WRITERS",
    "register_writer",
    "get_writer",
    "has_writer",
]
