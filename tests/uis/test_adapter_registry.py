"""UIS adapter registry — registration validation."""
from __future__ import annotations

import pytest

from backend.uis.adapters.spec import AdapterSpec, ColumnSpec
from backend.uis.adapters.registry import register_adapter


def test_registration_rejects_unknown_target_entity():
    spec = AdapterSpec(
        id="test/bogus",
        target_entity="NotAnEntity",
        canonical_columns=[ColumnSpec("foo")],
    )
    with pytest.raises(ValueError, match="unknown canonical entity"):
        register_adapter(spec)


def test_registration_rejects_primary_key_referencing_unknown_column():
    spec = AdapterSpec(
        id="test/bad-pk",
        target_entity="Asset",
        canonical_columns=[ColumnSpec("tamcn")],
        primary_key=["serial_number"],  # not in canonical_columns
    )
    with pytest.raises(ValueError, match="primary/fallback key"):
        register_adapter(spec)


def test_registration_rejects_sensitive_without_hash_prefix():
    spec = AdapterSpec(
        id="test/no-hash-prefix",
        target_entity="Asset",
        canonical_columns=[
            ColumnSpec("serial_number", sensitive=True),  # missing hash_prefix
        ],
    )
    with pytest.raises(ValueError, match="hash_prefix"):
        register_adapter(spec)


def test_registry_lists_all_default_adapters():
    """The package's __init__ auto-registers ECP / UTIL / SR-header."""
    from backend.uis.adapters import ADAPTERS, get_adapter
    assert "gcss-mc/ecp" in ADAPTERS
    assert "gcss-mc/util" in ADAPTERS
    assert "gcss-mc/sr-header" in ADAPTERS
    # Sanity-check column counts match the design
    assert len(get_adapter("gcss-mc/ecp").canonical_columns) == 8
    assert len(get_adapter("gcss-mc/util").canonical_columns) == 6
    assert len(get_adapter("gcss-mc/sr-header").canonical_columns) == 13


def test_get_adapter_unknown_raises():
    from backend.uis.adapters import get_adapter
    with pytest.raises(KeyError):
        get_adapter("nope")


def test_adapter_spec_helpers():
    from backend.uis.adapters import get_adapter
    ecp = get_adapter("gcss-mc/ecp")
    assert "tamcn" in ecp.field_names()
    assert "serial_number" in ecp.sensitive_columns()
    assert ecp.column("tamcn").name == "tamcn"
    with pytest.raises(KeyError):
        ecp.column("does_not_exist")
