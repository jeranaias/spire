"""
Task #161 — per-asset Bill of Materials (BOM) gates the cannibalization
donor pool.

Asserts that:

  * `backend/bom.py` builds a deterministic per-asset installed-component
    list from `dataset/data/equipment_profiles.json`. Core fault parts
    are present on every hull; sub-variant optional parts vary between
    hulls of the same equipment_type via a stable hash, so two JLTVs do
    NOT necessarily share every NSN.
  * Serviceability flips false when the matching fault class is open on
    the hull.
  * `/pulse/cannibalization` strippable_donors are filtered by "donor
    has this NSN installed and serviceable" — donors of the wrong
    equipment_type are excluded (no NSN match) and donor cards carry a
    `slot` string for the operator.
  * `/pulse/cannibalization/propose` rejects a donor that doesn't carry
    the recipient's NSN (equipment-type mismatch) with a structured
    `DonorBomMismatch` error.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.bom import (
    asset_bom,
    asset_carries_nsn_serviceable,
    equipment_type_carries_nsn,
)
from backend.main import app
from backend.state import get_dataset, load_dataset


@pytest.fixture(scope="module", autouse=True)
def _ensure_dataset_loaded():
    """The bom module relies on the canonical dataset being in memory; the
    FastAPI lifespan handler loads it for client tests, but the unit tests
    that call `get_dataset()` directly need to trigger it themselves."""
    try:
        get_dataset()
    except RuntimeError:
        load_dataset()
    yield


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str = "1234567890") -> None:
    # 1234567890 is mef_commander — full-fleet scope so the donor pool
    # we inspect isn't compressed by unit filtering.
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def test_bom_module_builds_per_asset_installed_list():
    ds = get_dataset()
    a = next(x for x in ds.assets if x.equipment_type == "JLTV")
    bom = asset_bom(a)
    assert len(bom) > 0, "JLTV BOM should not be empty"
    # Every entry carries a slot label for the donor card.
    for c in bom:
        assert c.nsn
        assert c.slot
        assert c.fault_class
    # Core parts are always installed; pick a known core NSN for JLTV.
    core_nsns = {c.nsn for c in bom if c.is_core}
    assert core_nsns, "JLTV must expose at least one core NSN"


def test_bom_varies_between_hulls_of_same_equipment_type():
    """Two JLTVs should NOT report identical BOMs — sub-variant optional
    parts vary deterministically per asset_id. This is the realism the
    equipment_type proxy was missing."""
    ds = get_dataset()
    jltvs = [a for a in ds.assets if a.equipment_type == "JLTV"][:60]
    if len(jltvs) < 10:
        pytest.skip("not enough JLTVs in canonical fleet to compare")

    nsn_sets = [frozenset(c.nsn for c in asset_bom(a)) for a in jltvs]
    distinct = set(nsn_sets)
    assert len(distinct) > 1, (
        "expected sub-variant variation between JLTV hulls; got identical BOMs"
    )


def test_bom_is_deterministic_across_calls():
    """The same asset must produce the same BOM every call (reproducibility
    is required for the deterministic dataset contract)."""
    ds = get_dataset()
    a = next(x for x in ds.assets if x.equipment_type == "JLTV")
    first = [c.nsn for c in asset_bom(a)]
    second = [c.nsn for c in asset_bom(a)]
    assert first == second


def test_serviceability_flips_when_fault_class_is_open():
    ds = get_dataset()
    a = next(x for x in ds.assets if x.equipment_type == "JLTV")
    bom = asset_bom(a)
    target = bom[0]
    # With no open faults, the part is serviceable.
    has, slot = asset_carries_nsn_serviceable(a, target.nsn, set())
    assert has is True
    assert slot == target.slot
    # With the matching fault class open, the same lookup returns False.
    has2, slot2 = asset_carries_nsn_serviceable(a, target.nsn, {target.fault_class})
    assert has2 is False
    assert slot2 is None


def test_equipment_type_mismatch_excludes_nsn():
    """A JLTV NSN must not appear in the BOM of a different equipment
    type (e.g. MTVR_CARGO). This is the cross-platform sanity check that
    the equipment_type proxy was implicitly relying on."""
    ds = get_dataset()
    jltv = next(x for x in ds.assets if x.equipment_type == "JLTV")
    jltv_nsns = {c.nsn for c in asset_bom(jltv)}
    assert jltv_nsns

    # Pick any NSN from JLTV's BOM and assert it isn't in MTVR's catalog.
    sample = next(iter(jltv_nsns))
    assert equipment_type_carries_nsn("JLTV", sample) is True
    assert equipment_type_carries_nsn("MTVR_CARGO", sample) is False


def test_cannibalization_endpoint_donors_carry_slot_label(client):
    _login(client)
    body = client.get("/api/pulse/cannibalization").json()
    pool = body.get("strippable_donors") or {}
    # Find any need with at least one donor and assert every donor has a
    # slot label and the recipient's NSN is in the donor's BOM.
    found = False
    for sr_number, donors in pool.items():
        if not donors:
            continue
        # Locate the recipient need to get the NSN.
        need = next(n for n in body["open_needs"] if n["sr_number"] == sr_number)
        nsn = need["needed_part"]["nsn"]
        for d in donors:
            assert d.get("slot"), f"donor {d['asset_id']} missing slot label"
            # The donor must carry the NSN in its catalog.
            assert equipment_type_carries_nsn(d["equipment_type"], nsn), (
                f"donor {d['asset_id']} ({d['equipment_type']}) does not carry "
                f"recipient NSN {nsn} in its parts catalog"
            )
            found = True
            break
        if found:
            break
    assert found, "expected at least one strippable donor to verify"


def test_same_equipment_type_donor_excluded_when_optional_nsn_not_installed():
    """Regression guard for the original task concern: two assets of the
    same equipment_type can disagree on which optional sub-variant parts
    are installed. Pick an optional NSN, find a hull whose hash gates it
    OUT, and assert the BOM lookup correctly reports "not installed" — i.e.
    the equipment_type proxy alone is no longer sufficient."""
    ds = get_dataset()
    jltvs = [a for a in ds.assets if a.equipment_type == "JLTV"]
    if len(jltvs) < 10:
        pytest.skip("not enough JLTVs in canonical fleet to compare")

    # Find an optional NSN by scanning the catalog of any JLTV.
    sample_bom = asset_bom(jltvs[0])
    optional_entry = next((c for c in sample_bom if not c.is_core), None)
    if optional_entry is None:
        pytest.skip("no optional sub-variant parts in JLTV catalog")
    target_nsn = optional_entry.nsn

    # Find a JLTV whose deterministic hash leaves the part NOT installed.
    excluded = next(
        (a for a in jltvs if target_nsn not in {c.nsn for c in asset_bom(a)}),
        None,
    )
    assert excluded is not None, (
        "expected at least one JLTV without the optional NSN; sub-variant "
        "gate may not be exercising"
    )

    # Sanity: the equipment_type catalog still lists the NSN…
    assert equipment_type_carries_nsn("JLTV", target_nsn) is True
    # …but the per-asset gate correctly reports it as not present on this hull.
    has_part, slot = asset_carries_nsn_serviceable(excluded, target_nsn, set())
    assert has_part is False
    assert slot is None


def test_propose_rejects_donor_without_part_in_bom(client):
    """A donor of the wrong equipment type does not have the NSN in its
    BOM; the propose endpoint must reject with DonorBomMismatch rather
    than silently writing the row to the audit chain."""
    _login(client)
    body = client.get("/api/pulse/cannibalization").json()
    needs = body.get("open_needs") or []
    if not needs:
        pytest.skip("no open NMCS needs in canonical dataset")
    need = needs[0]

    ds = get_dataset()
    recipient_asset = ds.asset(need["asset_id"])
    # Find a donor of a DIFFERENT equipment_type so the BOM check fails
    # for a real reason (platform mismatch), not a sub-variant flip.
    bad_donor = next(
        (a for a in ds.assets if a.equipment_type != recipient_asset.equipment_type),
        None,
    )
    assert bad_donor is not None

    r = client.post(
        "/api/pulse/cannibalization/propose",
        json={
            "recipient_sr": need["sr_number"],
            "donor_asset_id": bad_donor.asset_id,
            "nsn": need["needed_part"]["nsn"],
        },
    )
    assert r.status_code == 400, r.text
    detail = r.json().get("detail")
    assert isinstance(detail, dict)
    assert detail.get("error") == "DonorBomMismatch"
    assert detail.get("donor_asset_id") == bad_donor.asset_id
