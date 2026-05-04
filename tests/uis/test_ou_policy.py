"""Hierarchical RBAC / OU-policy tests (UIS-P6.5)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.uis.ou_policy import (
    OuNode,
    OuTree,
    can_read,
    can_write,
    filter_by_visibility,
    load_tree,
    reload_tree,
    set_tree,
    units_visible_to,
)


@pytest.fixture
def usmc_tree(monkeypatch):
    """Build a representative MARFOR → MEF → MLG → CLR → CLB tree."""
    nodes = {
        "MARFORPAC": OuNode(
            unit_uic="MARFORPAC", unit_name="MARFORPAC",
            echelon="MARFOR", parent=None,
            children=("3D_MEF",),
        ),
        "3D_MEF": OuNode(
            unit_uic="3D_MEF", unit_name="3d Marine Expeditionary Force",
            echelon="MEF", parent="MARFORPAC",
            children=("3D_MLG", "3D_MARDIV"),
        ),
        "3D_MLG": OuNode(
            unit_uic="3D_MLG", unit_name="3d Marine Logistics Group",
            echelon="MLG", parent="3D_MEF",
            children=("CLR_3", "CLR_37"),
        ),
        "3D_MARDIV": OuNode(
            unit_uic="3D_MARDIV", unit_name="3d Marine Division",
            echelon="MARDIV", parent="3D_MEF",
            children=(),
        ),
        "CLR_3": OuNode(
            unit_uic="CLR_3", unit_name="Combat Logistics Regiment 3",
            echelon="CLR", parent="3D_MLG",
            children=("CLB_3", "CLB_4"),
        ),
        "CLR_37": OuNode(
            unit_uic="CLR_37", unit_name="Combat Logistics Regiment 37",
            echelon="CLR", parent="3D_MLG",
            children=("CLB_31",),
        ),
        "CLB_3": OuNode(
            unit_uic="CLB_3", echelon="CLB", parent="CLR_3",
            unit_name="CLB-3",
        ),
        "CLB_4": OuNode(
            unit_uic="CLB_4", echelon="CLB", parent="CLR_3",
            unit_name="CLB-4",
        ),
        "CLB_31": OuNode(
            unit_uic="CLB_31", echelon="CLB", parent="CLR_37",
            unit_name="CLB-31",
        ),
    }
    tree = OuTree(by_uic=nodes)
    set_tree(tree)
    yield tree
    set_tree(OuTree())


# ---------------------------------------------------------------------------
# Tree closure correctness
# ---------------------------------------------------------------------------


def test_descendants_includes_self_and_children(usmc_tree):
    desc = usmc_tree.descendants("CLR_3")
    assert desc == frozenset({"CLR_3", "CLB_3", "CLB_4"})


def test_descendants_walks_full_subtree(usmc_tree):
    desc = usmc_tree.descendants("3D_MEF")
    assert "3D_MLG" in desc
    assert "CLR_3" in desc
    assert "CLB_3" in desc
    # MEF's other branch
    assert "3D_MARDIV" in desc


def test_ancestors_includes_self_and_parents(usmc_tree):
    anc = usmc_tree.ancestors("CLB_3")
    assert anc == frozenset({"CLB_3", "CLR_3", "3D_MLG", "3D_MEF", "MARFORPAC"})


def test_is_descendant_negative_for_sibling_subtree(usmc_tree):
    # CLB_3 is in CLR_3, not in CLR_37
    assert not usmc_tree.is_descendant("CLB_3", "CLR_37")
    assert usmc_tree.is_descendant("CLB_3", "CLR_3")


# ---------------------------------------------------------------------------
# Visibility
# ---------------------------------------------------------------------------


def test_clb_operator_sees_only_their_clb(usmc_tree):
    user = {"unit_uic": "CLB_3", "role": "g4_operations"}
    visible = units_visible_to(user)
    assert visible == frozenset({"CLB_3"})


def test_clr_operator_sees_self_and_subordinate_clbs(usmc_tree):
    user = {"unit_uic": "CLR_3", "role": "g4_operations"}
    visible = units_visible_to(user)
    assert visible == frozenset({"CLR_3", "CLB_3", "CLB_4"})


def test_mlg_operator_sees_full_subtree(usmc_tree):
    user = {"unit_uic": "3D_MLG", "role": "g4_operations"}
    visible = units_visible_to(user)
    expected = frozenset({"3D_MLG", "CLR_3", "CLR_37", "CLB_3", "CLB_4", "CLB_31"})
    assert visible == expected


def test_clb_operator_does_NOT_see_sibling_clb(usmc_tree):
    user = {"unit_uic": "CLB_3", "role": "g4_operations"}
    assert can_read(user, "CLB_4") is False


def test_unknown_unit_returns_empty_visibility(usmc_tree):
    user = {"unit_uic": "UNKNOWN", "role": "g4_operations"}
    assert units_visible_to(user) == frozenset()


def test_no_unit_returns_empty_visibility(usmc_tree):
    assert units_visible_to({}) == frozenset()
    assert units_visible_to({"role": "g4_operations"}) == frozenset()


def test_upward_view_role_grants_ancestor_visibility(usmc_tree, monkeypatch):
    """When SPIRE_OU_UPWARD_VIEW_ROLES includes the operator's
    role, they see ancestors too (situational awareness)."""
    monkeypatch.setenv("SPIRE_OU_UPWARD_VIEW_ROLES", "g4_operations")
    user = {"unit_uic": "CLB_3", "role": "g4_operations"}
    visible = units_visible_to(user)
    # Now sees self + ancestors (CLR_3 → 3D_MLG → 3D_MEF → MARFORPAC)
    assert "MARFORPAC" in visible
    assert "CLR_3" in visible
    # But still NOT siblings (CLB_4 is sibling, not ancestor)
    assert "CLB_4" not in visible


# ---------------------------------------------------------------------------
# can_read / can_write
# ---------------------------------------------------------------------------


def test_can_read_within_subtree(usmc_tree):
    user = {"unit_uic": "CLR_3", "role": "g4_operations"}
    assert can_read(user, "CLB_3") is True
    assert can_read(user, "CLR_3") is True


def test_can_read_outside_subtree(usmc_tree):
    user = {"unit_uic": "CLR_3", "role": "g4_operations"}
    assert can_read(user, "CLB_31") is False  # different CLR


def test_can_write_requires_descendant_AND_role(usmc_tree, monkeypatch):
    monkeypatch.setenv("SPIRE_OU_WRITE_ROLES", "data_custodian,security_manager")
    custodian = {"unit_uic": "CLR_3", "role": "data_custodian"}
    g4 = {"unit_uic": "CLR_3", "role": "g4_operations"}
    assert can_write(custodian, "CLB_3") is True
    assert can_write(g4, "CLB_3") is False  # role not in WRITE_ROLES


def test_can_write_blocked_for_upward_resource(usmc_tree, monkeypatch):
    """Even with upward-view granted, write does NOT extend up
    the tree (a CLR custodian can't write into MEF-aggregate records)."""
    monkeypatch.setenv("SPIRE_OU_UPWARD_VIEW_ROLES", "data_custodian")
    monkeypatch.setenv("SPIRE_OU_WRITE_ROLES", "data_custodian")
    user = {"unit_uic": "CLR_3", "role": "data_custodian"}
    # Can READ upward
    assert can_read(user, "3D_MLG") is True
    # Can NOT write upward
    assert can_write(user, "3D_MLG") is False


# ---------------------------------------------------------------------------
# filter_by_visibility helper
# ---------------------------------------------------------------------------


def test_filter_by_visibility_strips_out_of_scope_records(usmc_tree):
    user = {"unit_uic": "CLR_3", "role": "g4_operations"}
    records = [
        {"sr_number": "SR-1", "unit_uic": "CLB_3"},
        {"sr_number": "SR-2", "unit_uic": "CLB_31"},  # different CLR
        {"sr_number": "SR-3", "unit_uic": "CLB_4"},
        {"sr_number": "SR-4", "unit_uic": "CLR_3"},
    ]
    visible = filter_by_visibility(records, user)
    sr_numbers = [r["sr_number"] for r in visible]
    assert sorted(sr_numbers) == ["SR-1", "SR-3", "SR-4"]


def test_filter_by_visibility_works_on_dataclass_records(usmc_tree):
    from dataclasses import dataclass

    @dataclass
    class FakeAsset:
        asset_id: str
        unit_uic: str

    records = [
        FakeAsset("A1", "CLB_3"),
        FakeAsset("A2", "CLB_31"),
    ]
    user = {"unit_uic": "CLR_3", "role": "g4_operations"}
    visible = filter_by_visibility(records, user)
    assert len(visible) == 1
    assert visible[0].asset_id == "A1"


# ---------------------------------------------------------------------------
# Loading from JSON config
# ---------------------------------------------------------------------------


def test_load_tree_from_json_config(monkeypatch, tmp_path):
    config = [
        {"unit_uic": "ROOT", "unit_name": "Root", "echelon": "MARFOR",
         "parent": None, "children": ["CHILD_A"]},
        {"unit_uic": "CHILD_A", "unit_name": "Child A", "echelon": "MEF",
         "parent": "ROOT", "children": []},
    ]
    cfg_file = tmp_path / "ou.json"
    cfg_file.write_text(json.dumps(config), encoding="utf-8")
    monkeypatch.setenv("SPIRE_OU_TREE_PATH", str(cfg_file))
    tree = reload_tree()
    assert "ROOT" in tree.by_uic
    assert tree.is_descendant("CHILD_A", "ROOT") is True


def test_missing_config_yields_empty_tree(monkeypatch, tmp_path):
    monkeypatch.delenv("SPIRE_OU_TREE_PATH", raising=False)
    tree = reload_tree()
    assert tree.by_uic == {}
    # Closed-by-default: any user has no visible units
    assert units_visible_to({"unit_uic": "ANY"}) == frozenset()
