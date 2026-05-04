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


# ---------------------------------------------------------------------------
# ServiceRequestWriter
# ---------------------------------------------------------------------------


def _sr_csv(*lines):
    """SR-header export shape: 13 columns matching the GCSS-MC export."""
    header = (
        "SERVICE_REQUEST_TYPE,SR_NUMBER,DEFECT_CODE_PRIMARY,"
        "DEFECT_CODE_SECONDARY,PROBLEM_SUMMARY,OPEN_DATE,ECHELON_OF_MAINT,"
        "SERIAL_NUMBER,TAMCN,DEADLINED_DATE,PRIORITY,OWNER_UIC,JOB_STATUS_DATE"
    )
    return ("\n".join((header, *lines)) + "\n").encode("utf-8")


def test_sr_writer_registered():
    assert has_writer("gcss-mc/sr-header")
    w = get_writer("gcss-mc/sr-header")
    assert w.target_entity == "ServiceRequest"


def test_sr_writer_new_sr_appended_with_header_only_flag():
    """SR not in canonical → appended with data_quality_flag=
    "header_only" so downstream consumers know parts/due-in still
    haven't joined."""
    raw = _sr_csv(
        "Maintenance - CM,sr_number_aBcDeFgHiJkLmNoPqRsT,B12,,Engine fault,12-MAR-26,1,"
        "owner_serial_aBcDeFgHiJkLmNoPqRsT,owner_tamcn_aBcDeFgHiJkLmNoPqRsT,"
        ",02,owner_uic_zZyYxXwWvVuUtTsSrRqQ,12-MAR-26"
    )
    pipeline_result = run_pipeline(raw, get_adapter("gcss-mc/sr-header"))
    ds = _empty_dataset()
    w = get_writer("gcss-mc/sr-header")
    diff = w.preview(pipeline_result, ds)

    assert diff.counts["new"] == 1
    assert diff.counts["matched_changed"] == 0

    result = w.apply(diff, ds)
    assert len(result.new_dataset.srs) == 1
    new_sr = result.new_dataset.srs[0]
    assert new_sr.sr_number == "sr_number_aBcDeFgHiJkLmNoPqRsT"
    assert new_sr.data_quality_flag == "header_only"


def test_sr_writer_matched_sr_updates_changed_fields_only():
    """Matched SRs get a per-field changes list. Non-empty parsed
    values overwrite stale canonical values; empty parsed cells
    leave canonical alone."""
    from dataset.lifecycle import ServiceRequest as _SR
    existing = _SR(
        sr_number="sr_number_aBcDeFgHiJkLmNoPqRsT",
        asset_id="A-1",
        unit_uic="owner_uic_old",
        unit_name="3d MLR",
        equipment_type="JLTV",
        tamcn="D1196",
        nsn="2320-01-540-2480",
        serial_number="serial_a",
        open_date=date(2026, 3, 12),
        priority="03",
        defect_code_primary="B05",
    )
    ds = _empty_dataset()
    ds.srs = [existing]

    raw = _sr_csv(
        # Same SR — different priority and defect_code_primary
        "Maintenance - CM,sr_number_aBcDeFgHiJkLmNoPqRsT,B12,,Engine fault,12-MAR-26,1,"
        "owner_serial_aBcDeFgHiJkLmNoPqRsT,owner_tamcn_aBcDeFgHiJkLmNoPqRsT,"
        ",02,owner_uic_zZyYxXwWvVuUtTsSrRqQ,12-MAR-26"
    )
    pipeline_result = run_pipeline(raw, get_adapter("gcss-mc/sr-header"))
    w = get_writer("gcss-mc/sr-header")
    diff = w.preview(pipeline_result, ds)

    assert diff.counts["matched_changed"] == 1
    fields_changed = {c.field for c in diff.matched[0].changes}
    assert "defect_code_primary" in fields_changed
    assert "priority" in fields_changed

    result = w.apply(diff, ds)
    updated_sr = result.new_dataset.srs[0]
    assert updated_sr.defect_code_primary == "B12"
    assert updated_sr.priority == "02"
    # Preserved fields untouched (asset_id wasn't in the export)
    assert updated_sr.asset_id == "A-1"


def test_sr_writer_unchanged_when_all_fields_match():
    """Aligned SR with no diffs lands in unchanged, not matched."""
    from dataset.lifecycle import ServiceRequest as _SR
    existing = _SR(
        sr_number="sr_number_aBcDeFgHiJkLmNoPqRsT",
        asset_id="A-1",
        unit_uic="owner_uic_zZyYxXwWvVuUtTsSrRqQ",
        unit_name="3d MLR",
        equipment_type="JLTV",
        tamcn="owner_tamcn_aBcDeFgHiJkLmNoPqRsT",
        nsn="",
        serial_number="owner_serial_aBcDeFgHiJkLmNoPqRsT",
        open_date=date(2026, 3, 12),
        priority="02",
        defect_code_primary="B12",
        service_request_type="Maintenance - CM",
        echelon_numeric=1,
    )
    ds = _empty_dataset()
    ds.srs = [existing]

    raw = _sr_csv(
        "Maintenance - CM,sr_number_aBcDeFgHiJkLmNoPqRsT,B12,,Engine fault,12-MAR-26,1,"
        "owner_serial_aBcDeFgHiJkLmNoPqRsT,owner_tamcn_aBcDeFgHiJkLmNoPqRsT,"
        ",02,owner_uic_zZyYxXwWvVuUtTsSrRqQ,12-MAR-26"
    )
    pipeline_result = run_pipeline(raw, get_adapter("gcss-mc/sr-header"))
    w = get_writer("gcss-mc/sr-header")
    diff = w.preview(pipeline_result, ds)

    # Note: parsed open_date will match existing.open_date; deadlined
    # is empty in the file so won't fire a change either.
    assert diff.counts["matched_changed"] == 0
    assert diff.counts["unchanged"] == 1


def test_sr_writer_apply_emits_new_and_matched_audit_rows():
    raw = _sr_csv(
        "Maintenance - CM,sr_number_aBcDeFgHiJkLmNoPqRsT,B12,,Engine fault,12-MAR-26,1,"
        "owner_serial_aBcDeFgHiJkLmNoPqRsT,owner_tamcn_aBcDeFgHiJkLmNoPqRsT,"
        ",02,owner_uic_zZyYxXwWvVuUtTsSrRqQ,12-MAR-26"
    )
    pipeline_result = run_pipeline(raw, get_adapter("gcss-mc/sr-header"))
    ds = _empty_dataset()
    w = get_writer("gcss-mc/sr-header")
    diff = w.preview(pipeline_result, ds)
    result = w.apply(diff, ds)
    kinds = {a["kind"] for a in result.audit_rows}
    assert "ingest.sr.apply.new" in kinds


def test_sr_state_token_changes_when_sr_added():
    from dataset.lifecycle import ServiceRequest as _SR
    ds = _empty_dataset()
    w = get_writer("gcss-mc/sr-header")
    t0 = w.state_token(ds)
    ds.srs = [_SR(
        sr_number="sr_999", asset_id="A-1", unit_uic="u", unit_name="",
        equipment_type="", tamcn="", nsn="", serial_number="",
        open_date=date(2026, 3, 12),
    )]
    assert t0 != w.state_token(ds)


# ---------------------------------------------------------------------------
# CRatingWriter — proves the protocol works for non-Asset entities
# ---------------------------------------------------------------------------


def _drrs_csv(*lines):
    header = "Reporting UIC,Effective Date,Cat,MET Scores,Commander Remarks"
    return ("\n".join((header, *lines)) + "\n").encode("utf-8")


def test_crating_writer_registered():
    assert has_writer("drrs-mc/c-rating")
    w = get_writer("drrs-mc/c-rating")
    assert w.target_entity == "CRating"


def test_crating_apply_appends_new_record():
    raw = _drrs_csv(
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,2026-04-26,Cat 2,{},Stable"
    )
    pipeline_result = run_pipeline(raw, get_adapter("drrs-mc/c-rating"))
    ds = _empty_dataset()
    w = get_writer("drrs-mc/c-rating")
    diff = w.preview(pipeline_result, ds)
    assert diff.counts["new"] == 1

    result = w.apply(diff, ds)
    assert len(result.new_dataset.c_ratings) == 1
    cr = result.new_dataset.c_ratings[0]
    assert cr.unit_uic == "owner_uic_zZyYxXwWvVuUtTsSrRqQ"
    assert cr.c_rating == "C2"


def test_crating_apply_updates_existing_record_on_same_key():
    """(unit_uic, as_of_date) is the primary key. A second export
    with the same key + a different rating updates the prior
    record rather than appending a duplicate."""
    from backend.uis.writers.c_rating import CRatingRecord
    ds = _empty_dataset()
    ds.c_ratings = [CRatingRecord(
        unit_uic="owner_uic_zZyYxXwWvVuUtTsSrRqQ",
        as_of_date=date(2026, 4, 26),
        c_rating="C3",
        met_scores="{}",
        operator_assessment="Old assessment",
    )]

    raw = _drrs_csv(
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,2026-04-26,Cat 2,{},New assessment"
    )
    pipeline_result = run_pipeline(raw, get_adapter("drrs-mc/c-rating"))
    w = get_writer("drrs-mc/c-rating")
    diff = w.preview(pipeline_result, ds)

    assert diff.counts["matched_changed"] == 1
    assert diff.counts["new"] == 0

    result = w.apply(diff, ds)
    # Still one record, but updated
    assert len(result.new_dataset.c_ratings) == 1
    cr = result.new_dataset.c_ratings[0]
    assert cr.c_rating == "C2"
    assert cr.operator_assessment == "New assessment"


def test_crating_state_token_changes_with_rating():
    from backend.uis.writers.c_rating import CRatingRecord
    ds = _empty_dataset()
    ds.c_ratings = [CRatingRecord(
        unit_uic="u",
        as_of_date=date(2026, 4, 26),
        c_rating="C2",
    )]
    w = get_writer("drrs-mc/c-rating")
    t0 = w.state_token(ds)
    ds.c_ratings[0].c_rating = "C3"
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
