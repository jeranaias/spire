"""Mapping — projection of source columns onto canonical fields.

Two layers:

  * `auto_map` (Phase 1) — name-similarity heuristic. Cheap. Used as
    the baseline proposal when no MappingProfile exists yet.
  * `llm_map` (Phase 2) — tier-router-driven mapping when the
    heuristic confidence is too low. Uses RigRun primary, falls back
    to local Gemma 4 e2b, falls back to deterministic name-similarity.

A `MappingProfile` (file `profile.py`) captures the operator's
confirmed mapping. Profiles persist per (unit × source × version);
re-uploading the same shape auto-applies. Profiles version forward —
when a source schema changes the operator creates a new profile
rather than mutating the old one.
"""
from __future__ import annotations

from .auto_map import propose_mapping
from .profile import MappingProfile
from .store import (
    create_profile,
    delete_profile,
    ensure_schema,
    find_profile,
    get_profile,
    list_profiles,
    set_connection_factory,
    update_profile,
)

__all__ = [
    "MappingProfile",
    "create_profile",
    "delete_profile",
    "ensure_schema",
    "find_profile",
    "get_profile",
    "list_profiles",
    "propose_mapping",
    "set_connection_factory",
    "update_profile",
]
