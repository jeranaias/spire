"""Discoverable registry of all adapters in the package.

New adapters auto-register by calling `register_adapter(SPEC)` from
their module. The pipeline + the /api/uis/adapters route walk this
registry; nothing else does.
"""
from __future__ import annotations

from typing import Dict, List

from .spec import AdapterSpec
from ..canonical.registry import IDM_ENTITIES


# id → spec
ADAPTERS: Dict[str, AdapterSpec] = {}


def register_adapter(spec: AdapterSpec) -> AdapterSpec:
    """Register an adapter spec.

    Validates the spec at registration time:
      * `target_entity` must be a known canonical entity
      * `primary_key` + `fallback_key` columns must exist in
        `canonical_columns`
      * sensitive columns must declare a `hash_prefix`
    """
    if spec.target_entity not in IDM_ENTITIES:
        raise ValueError(
            f"Adapter {spec.id!r} targets unknown canonical entity "
            f"{spec.target_entity!r}. Known: {sorted(IDM_ENTITIES.keys())}"
        )
    field_names = set(spec.field_names())
    for k in spec.primary_key + spec.fallback_key:
        if k not in field_names:
            raise ValueError(
                f"Adapter {spec.id!r} primary/fallback key {k!r} not in "
                f"canonical_columns ({sorted(field_names)})"
            )
    for c in spec.canonical_columns:
        if c.sensitive and not c.hash_prefix:
            raise ValueError(
                f"Adapter {spec.id!r} column {c.name!r} is sensitive but "
                f"has no hash_prefix"
            )
    ADAPTERS[spec.id] = spec
    return spec


def get_adapter(adapter_id: str) -> AdapterSpec:
    if adapter_id not in ADAPTERS:
        raise KeyError(
            f"Unknown adapter {adapter_id!r}. Known: {sorted(ADAPTERS.keys())}"
        )
    return ADAPTERS[adapter_id]


def list_adapters() -> List[AdapterSpec]:
    return list(ADAPTERS.values())
