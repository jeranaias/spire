"""EntityWriter protocol + AssetEcpWriter tests.

The writers package is the Phase 3 unlock for generic apply across
any registered adapter. These tests verify:

  1. The registry round-trips: register / get / has.
  2. AssetEcpWriter.preview returns a WriterDiff matching the
     existing merge engine's counts.
  3. AssetEcpWriter.apply is pure (no swap_dataset, no audit_log)
     and produces the same new-asset roster as the legacy path did.
  4. state_token is stable across calls and changes when the
     dataset slice it fingerprints actually moves.
"""
from __future__ import annotations

from datetime import date

import pytest

from backend.uis.adapters import get_adapter
from backend.uis.pipeline import run_pipeline
from backend.uis.writers import (
    EntityWriter,
    WRITERS,
    WriterDiff,
    get_writer,
    has_writer,
    register_writer,
)
from backend.uis.writers.asset_ecp import AssetEcpWriter


def _ecp_csv(*lines):
    header = "TAMCN,NSN,SERIAL_NUMBER,NOMENCLATURE,OWNER_UIC,ALLOWANCE_QTY,ON_HAND_QTY,LAST_INVENTORY_DATE"
    return ("\n".join((header, *lines)) + "\n").encode("utf-8")


def _empty_dataset():
    """Build a minimal CanonicalDataset with no assets — sufficient
    for state_token / preview-of-empty-roster tests."""
    from backend.state import CanonicalDataset
    return CanonicalDataset(
        units=[], assets=[], roster=[], srs=[], snapshots=[],
        reqs=[], cannib_events=[], incidents=[], tmrs=[],
        dq_defects=[], violations=[],
        generated_at="2026-04-01T00:00:00Z", seed=42,
    )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


def test_asset_ecp_writer_auto_registers_on_import():
    """Side-effect: importing the writers package registers
    AssetEcpWriter under its adapter_id. The /api/uis/upload generic
    apply dispatch relies on this — it looks up by adapter.id without
    knowing the writer class."""
    assert has_writer("gcss-mc/ecp")
    w = get_writer("gcss-mc/ecp")
    assert w.adapter_id == "gcss-mc/ecp"
    assert w.target_entity == "Asset"


def test_get_writer_unknown_raises_with_known_list():
    with pytest.raises(KeyError) as exc:
        get_writer("does-not-exist")
    msg = str(exc.value)
    assert "does-not-exist" in msg
    assert "gcss-mc/ecp" in msg


def test_register_writer_requires_adapter_id():
    """A writer with no adapter_id can't anchor a registry entry."""
    class Bad:
        adapter_id = ""
        target_entity = "Asset"
    with pytest.raises(ValueError):
        register_writer(Bad())


def test_writer_satisfies_protocol_at_runtime():
    """AssetEcpWriter must duck-type as EntityWriter (Protocol check)."""
    w = AssetEcpWriter()
    assert isinstance(w, EntityWriter)


# ---------------------------------------------------------------------------
# state_token
# ---------------------------------------------------------------------------


def test_state_token_stable_for_same_dataset():
    ds = _empty_dataset()
    w = AssetEcpWriter()
    assert w.state_token(ds) == w.state_token(ds)


def test_state_token_changes_when_roster_changes():
    """Adding an asset must move the token — that's the whole point
    of the optimistic-concurrency check on apply."""
    from dataset.fleet import Asset
    ds = _empty_dataset()
    w = AssetEcpWriter()
    t0 = w.state_token(ds)

    ds.assets = [
        Asset(
            asset_id="A-1", equipment_type="JLTV", tamcn="D1196",
            nsn="2320-01-540-2480", serial_number="serial_a",
            nomenclature="JLTV", model="", fsc="2320",
            unit_uic="owner_uic_test", unit_name="", unit_parent="",
            location="", optempo="medium", deployment_status="garrison",
            fielding_date=date(2026, 1, 1), initial_hours=0.0,
            initial_miles=0, classification_risk="LOW",
            allowance_qty=0, on_hand_qty=1,
            last_inventory_date=date(2026, 3, 12),
        ),
    ]
    t1 = w.state_token(ds)
    assert t0 != t1


# ---------------------------------------------------------------------------
# preview / apply
# ---------------------------------------------------------------------------


def test_preview_returns_writer_diff_with_native_payload():
    raw = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,"
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    pipeline_result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    ds = _empty_dataset()
    w = AssetEcpWriter()
    diff = w.preview(pipeline_result, ds)

    assert isinstance(diff, WriterDiff)
    assert diff.counts["new"] == 1     # empty roster, one parsed row → new
    assert diff.counts["matched_changed"] == 0
    assert diff.native is not None      # engine-native diff carried through
    assert "new" in diff.payload        # JSON-shaped payload populated


def test_apply_is_pure_and_returns_new_dataset():
    """apply must NOT mutate the input dataset and must NOT call
    swap_dataset. It just builds + returns a new dataset."""
    raw = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,"
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    pipeline_result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    ds = _empty_dataset()
    w = AssetEcpWriter()
    diff = w.preview(pipeline_result, ds)

    # Snapshot input state
    assert len(ds.assets) == 0

    result = w.apply(diff, ds)

    # Input untouched
    assert len(ds.assets) == 0
    # Output carries the new asset
    assert len(result.new_dataset.assets) == 1
    assert result.summary_counts["new"] == 1
    # Audit rows are payload-only (route adds actor + preview_token)
    for row in result.audit_rows:
        assert "kind" in row
        assert "subject_id" in row
        assert "payload" in row
        assert "actor" not in row  # route adds it


# ---------------------------------------------------------------------------
# AssetUtilWriter
# ---------------------------------------------------------------------------


def _util_csv(*lines):
    header = "ASSET_ID,READING_DATE,CURRENT_HOURS,CURRENT_MILES,CURRENT_STATUS"
    return ("\n".join((header, *lines)) + "\n").encode("utf-8")


def test_util_writer_registered_under_adapter_id():
    assert has_writer("gcss-mc/util")
    w = get_writer("gcss-mc/util")
    assert w.target_entity == "Asset"


def test_util_writer_preview_does_not_mutate_input_assets():
    """UTIL apply_latest_readings writes in place. The writer's
    preview must shield the live dataset from the dry-run merge.
    """
    from dataset.fleet import Asset
    asset = Asset(
        asset_id="A-1", equipment_type="JLTV", tamcn="D1196",
        nsn="2320-01-540-2480", serial_number="serial_a",
        nomenclature="JLTV", model="", fsc="2320",
        unit_uic="owner_uic_test", unit_name="", unit_parent="",
        location="", optempo="medium", deployment_status="garrison",
        fielding_date=date(2026, 1, 1), initial_hours=0.0,
        initial_miles=0, classification_risk="LOW",
        allowance_qty=0, on_hand_qty=1,
        last_inventory_date=date(2026, 3, 12),
    )
    asset.current_hours = 100.0
    asset.current_miles = 5000
    asset.current_status = "FMC"

    ds = _empty_dataset()
    ds.assets = [asset]

    raw = _util_csv("A-1,2026-04-01,250.5,12000,FMC")
    pipeline_result = run_pipeline(raw, get_adapter("gcss-mc/util"))
    w = get_writer("gcss-mc/util")
    diff = w.preview(pipeline_result, ds)

    # Pre-check: preview returned counts
    assert diff.counts.get("matched") == 1
    # Live asset is unchanged — preview ran on a copy
    assert asset.current_hours == 100.0
    assert asset.current_miles == 5000


def test_util_writer_apply_commits_readings():
    from dataset.fleet import Asset
    asset = Asset(
        asset_id="A-1", equipment_type="JLTV", tamcn="D1196",
        nsn="2320-01-540-2480", serial_number="serial_a",
        nomenclature="JLTV", model="", fsc="2320",
        unit_uic="owner_uic_test", unit_name="", unit_parent="",
        location="", optempo="medium", deployment_status="garrison",
        fielding_date=date(2026, 1, 1), initial_hours=0.0,
        initial_miles=0, classification_risk="LOW",
        allowance_qty=0, on_hand_qty=1,
        last_inventory_date=date(2026, 3, 12),
    )
    asset.current_hours = 100.0
    asset.current_miles = 5000
    asset.current_status = "FMC"

    ds = _empty_dataset()
    ds.assets = [asset]

    raw = _util_csv("A-1,2026-04-01,250.5,12000,NMC")
    pipeline_result = run_pipeline(raw, get_adapter("gcss-mc/util"))
    w = get_writer("gcss-mc/util")
    diff = w.preview(pipeline_result, ds)
    result = w.apply(diff, ds)
    assert result.summary_counts["matched"] == 1
    new_asset = result.new_dataset.assets[0]
    assert new_asset.current_hours == 250.5
    assert new_asset.current_miles == 12000
    assert new_asset.current_status == "NMC"


def test_util_state_token_includes_utilization_columns():
    from dataset.fleet import Asset
    asset = Asset(
        asset_id="A-1", equipment_type="JLTV", tamcn="D1196",
        nsn="2320-01-540-2480", serial_number="s",
        nomenclature="JLTV", model="", fsc="2320",
        unit_uic="u", unit_name="", unit_parent="",
        location="", optempo="medium", deployment_status="garrison",
        fielding_date=date(2026, 1, 1), initial_hours=0.0,
        initial_miles=0, classification_risk="LOW",
        allowance_qty=0, on_hand_qty=1,
        last_inventory_date=date(2026, 3, 12),
    )
    asset.current_hours = 100.0
    ds = _empty_dataset()
    ds.assets = [asset]
    w = get_writer("gcss-mc/util")
    t0 = w.state_token(ds)
    asset.current_hours = 200.0
    t1 = w.state_token(ds)
    assert t0 != t1


def test_apply_propagates_field_changes_into_audit_rows():
    """Matched-row audit payloads carry the per-field before/after
    so the audit chain has a tamper-evident record of what changed.
    """
    from dataset.fleet import Asset
    raw = _ecp_csv(
        # Different nomenclature than what's in the canonical roster
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,"
        "JOINT LIGHT TACTICAL VEHICLE,owner_uic_zZyYxXwWvVuUtTsSrRqQ,"
        "15,12,12-MAR-26"
    )
    pipeline_result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))

    ds = _empty_dataset()
    ds.assets = [
        Asset(
            asset_id="A-1", equipment_type="JLTV", tamcn="D1196",
            nsn="2320-01-540-2480",
            serial_number="owner_serial_aBcDeFgHiJkLmNoPqRsT",
            nomenclature="JLTV",  # short form
            model="", fsc="2320",
            unit_uic="owner_uic_zZyYxXwWvVuUtTsSrRqQ",
            unit_name="", unit_parent="",
            location="", optempo="medium", deployment_status="garrison",
            fielding_date=date(2026, 1, 1), initial_hours=0.0,
            initial_miles=0, classification_risk="LOW",
            allowance_qty=0, on_hand_qty=0,
            last_inventory_date=None,
        ),
    ]
    w = AssetEcpWriter()
    diff = w.preview(pipeline_result, ds)
    result = w.apply(diff, ds)

    assert result.summary_counts["matched_changed"] == 1
    # The matched audit row shows the nomenclature change
    matched_audit = next(
        a for a in result.audit_rows if a["kind"] == "ingest.ecp.apply.row"
    )
    fields_changed = [c["field"] for c in matched_audit["payload"]["changes"]]
    assert "nomenclature" in fields_changed
