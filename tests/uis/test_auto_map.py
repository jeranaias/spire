"""UIS mapping — auto_map heuristic."""
from __future__ import annotations

import pytest

from backend.uis.adapters.spec import AdapterSpec, ColumnSpec
from backend.uis.mapping.auto_map import propose_mapping


@pytest.fixture
def ecp_spec():
    return AdapterSpec(
        id="test/ecp",
        target_entity="Asset",
        canonical_columns=[
            ColumnSpec("tamcn", required=True),
            ColumnSpec("nsn"),
            ColumnSpec("serial_number", sensitive=True, hash_prefix="SERIAL_NUMBER"),
            ColumnSpec("nomenclature"),
            ColumnSpec("owner_uic", sensitive=True, hash_prefix="OWNER_UIC"),
            ColumnSpec("allowance_qty", type="int"),
            ColumnSpec("on_hand_qty", type="int"),
            ColumnSpec("last_inventory_date", type="date_oracle"),
        ],
        primary_key=["serial_number"],
    )


def test_exact_match_lands_full_confidence(ecp_spec):
    headers = ["TAMCN", "NSN", "SERIAL_NUMBER", "NOMENCLATURE", "OWNER_UIC",
               "ALLOWANCE_QTY", "ON_HAND_QTY", "LAST_INVENTORY_DATE"]
    proposal = propose_mapping(headers, ecp_spec)
    assert proposal.average_confidence() == 1.0
    assert len(proposal.column_map) == 8
    assert not proposal.unmapped_canonical


def test_camel_case_maps_correctly(ecp_spec):
    headers = ["TAMCN", "NSN", "SerialNumber", "Nomenclature", "OwnerUIC",
               "AllowanceQty", "OnHandQty", "LastInventoryDate"]
    proposal = propose_mapping(headers, ecp_spec)
    assert proposal.column_map["SerialNumber"] == "serial_number"
    assert proposal.column_map["LastInventoryDate"] == "last_inventory_date"


def test_messy_real_world_headers(ecp_spec):
    """Mix of casual variants real exports actually use."""
    headers = [
        "TAMCN_Code",
        "National Stock Number",
        "SerialNum",
        "Equipment Description",  # should NOT match nomenclature heuristically
        "Owning UIC",
        "Allowance",
        "On-Hand Count",
        "Last Inventoried Date",
        "Inspector Notes",        # extra column
    ]
    proposal = propose_mapping(headers, ecp_spec)
    # Strong heuristic catches: NSN, serial, last inventory date
    assert "National Stock Number" in proposal.column_map
    assert proposal.column_map["National Stock Number"] == "nsn"
    assert "SerialNum" in proposal.column_map
    assert proposal.column_map["SerialNum"] == "serial_number"
    assert "Last Inventoried Date" in proposal.column_map
    assert proposal.column_map["Last Inventoried Date"] == "last_inventory_date"
    # Extra column lands in unmapped_source
    assert "Inspector Notes" in proposal.unmapped_source


def test_completely_disjoint_headers(ecp_spec):
    """No match → all canonical columns unmapped."""
    proposal = propose_mapping(["foo", "bar", "baz"], ecp_spec)
    assert proposal.column_map == {}
    assert len(proposal.unmapped_canonical) == 8
    assert len(proposal.unmapped_source) == 3


def test_threshold_excludes_weak_match(ecp_spec):
    """A strict threshold drops borderline matches."""
    headers = ["TAMCN", "Allowance", "On-Hand"]
    weak = propose_mapping(headers, ecp_spec, threshold=0.95)
    # TAMCN matches at 1.0; Allowance / On-Hand don't reach 0.95
    assert "TAMCN" in weak.column_map
    assert "allowance_qty" in weak.unmapped_canonical
    assert "on_hand_qty" in weak.unmapped_canonical


def test_greedy_assignment_doesnt_double_claim(ecp_spec):
    """Two source columns can't both claim the same canonical column."""
    headers = ["serial", "serial_number"]  # ambiguous
    proposal = propose_mapping(headers, ecp_spec)
    # Only one of them maps to serial_number
    serial_targets = [k for k, v in proposal.column_map.items() if v == "serial_number"]
    assert len(serial_targets) == 1
