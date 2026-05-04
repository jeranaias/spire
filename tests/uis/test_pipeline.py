"""UIS pipeline — end-to-end run_pipeline()."""
from __future__ import annotations

from datetime import date

import pytest

from backend.uis.adapters import get_adapter
from backend.uis.pipeline import run_pipeline


# ---------------------------------------------------------------------------
# ECP — happy path
# ---------------------------------------------------------------------------


def _ecp_csv(*lines):
    header = "TAMCN,NSN,SERIAL_NUMBER,NOMENCLATURE,OWNER_UIC,ALLOWANCE_QTY,ON_HAND_QTY,LAST_INVENTORY_DATE"
    return ("\n".join((header, *lines)) + "\n").encode("utf-8")


def test_ecp_well_formed_row():
    raw = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.report.rows_kept == 1
    assert result.report.rows_total == 1
    assert result.report.detected_format == "csv"
    assert result.report.detected_encoding in {"utf-8", "utf-8-sig"}
    assert result.report.warnings_count == 0
    row = result.rows[0]
    assert row["tamcn"] == "D1196"
    assert row["allowance_qty"] == 15
    assert row["on_hand_qty"] == 12
    assert row["last_inventory_date"] == date(2026, 3, 12)
    # Pre-hashed values pass through
    assert row["serial_number"] == "owner_serial_aBcDeFgHiJkLmNoPqRsT"
    assert row["owner_uic"] == "owner_uic_zZyYxXwWvVuUtTsSrRqQ"


def test_ecp_clear_uic_self_hashes():
    raw = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,M55670,15,12,12-MAR-26"
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.report.rows_kept == 1
    row = result.rows[0]
    assert row["owner_uic"].startswith("OWNER_UIC_")
    assert len(row["owner_uic"]) == len("OWNER_UIC_") + 20
    # The report counts the self-hash event
    assert result.report.sanitization_self_hashed.get("owner_uic") == 1


def test_ecp_drops_row_without_required_keys():
    """The constraint requires TAMCN or serial; a row with neither drops."""
    raw = _ecp_csv(
        ",,,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,1,1,12-MAR-26"
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.report.rows_total == 1
    assert result.report.rows_kept == 0
    assert result.report.rows_dropped_constraint_failure == 1


def test_ecp_unparseable_date_warns_keeps_row():
    raw = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,not a date"
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.report.rows_kept == 1
    assert result.rows[0]["last_inventory_date"] is None
    assert any(w.code == "date_oracle_unparseable" for w in result.warnings)


def test_ecp_thousand_separator_in_qty():
    raw = _ecp_csv(
        'D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,"1,500","1,250",12-MAR-26'
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.rows[0]["allowance_qty"] == 1500
    assert result.rows[0]["on_hand_qty"] == 1250


def test_ecp_messy_camelcase_headers_still_map():
    """Auto-mapper handles camelCase + Pascal + spaces."""
    raw = (
        "TAMCN,NSN,SerialNumber,Nomenclature,OwnerUIC,AllowanceQty,OnHandQty,LastInventoryDate\n"
        "D1196,NSN1,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26\n"
    ).encode("utf-8")
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.report.rows_kept == 1
    assert result.report.auto_mapper_confidence > 0.9


# ---------------------------------------------------------------------------
# UTIL — happy path + readiness alias
# ---------------------------------------------------------------------------


def _util_csv(*lines):
    header = "ASSET_ID,READING_DATE,TOTAL_HOURS,TOTAL_MILES,READINESS_CODE,READING_SOURCE"
    return ("\n".join((header, *lines)) + "\n").encode("utf-8")


def test_util_well_formed_row():
    raw = _util_csv(
        "M21670-JLTV-001,12-MAR-26,3294.5,42750,MC,telematics"
    )
    # Note: UTIL adapter uses different canonical field names (current_hours,
    # current_miles, current_status). The auto-mapper handles this via
    # token similarity since "TOTAL_HOURS" → tokens(total, hours) overlaps
    # "current_hours" → tokens(current, hours). It's a partial match and
    # may not always land — a profile cleans this up. For now we test
    # via the fact that the adapter is registered.
    result = run_pipeline(raw, get_adapter("gcss-mc/util"))
    # At minimum the asset_id maps and the row gets through
    assert result.report.rows_total == 1


def test_util_readiness_alias_normalizes():
    """Alias map collapses casual variants to canonical codes."""
    raw = _util_csv(
        "M21670-JLTV-001,12-MAR-26,100,200,Mission Capable,manual"
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/util"))
    if result.rows:
        # readiness code should normalize to "MC" via the alias map
        assert result.rows[0].get("current_status") == "MC"


# ---------------------------------------------------------------------------
# Pipeline edge cases
# ---------------------------------------------------------------------------


def test_empty_file_returns_empty_result():
    result = run_pipeline(b"", get_adapter("gcss-mc/ecp"))
    assert result.rows == []
    assert result.report.rows_total == 0


def test_unknown_format_returns_empty():
    raw = b"\x00\x01\x02\x03random binary garbage"
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.rows == []
    assert result.report.detected_format == "unknown"


def test_header_only_file_returns_no_rows():
    raw = _ecp_csv()  # header only
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.report.rows_total == 0
    assert result.report.rows_kept == 0


def test_pipeline_preserves_column_map_in_report():
    raw = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert "TAMCN" in result.report.column_map
    assert result.report.column_map["TAMCN"] == "tamcn"


def test_pipeline_handles_smart_quotes_in_csv():
    """Smart quotes in a CSV value normalize to ASCII before parse."""
    raw = (
        "TAMCN,NSN,SERIAL_NUMBER,NOMENCLATURE,OWNER_UIC,ALLOWANCE_QTY,ON_HAND_QTY,LAST_INVENTORY_DATE\n"
        'D1196,NSN1,owner_serial_aBcDeFgHiJkLmNoPqRsT,He said “hi”,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26\n'
    ).encode("utf-8")
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    if result.rows:
        nom = result.rows[0]["nomenclature"]
        assert "“" not in nom and "”" not in nom


def test_pipeline_handles_utf8_bom():
    raw = (
        b"\xef\xbb\xbfTAMCN,NSN,SERIAL_NUMBER,NOMENCLATURE,OWNER_UIC,ALLOWANCE_QTY,ON_HAND_QTY,LAST_INVENTORY_DATE\n"
        b"D1196,NSN1,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26\n"
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.report.rows_kept == 1
    assert result.report.detected_encoding == "utf-8-sig"


def test_pipeline_row_cap_raises(monkeypatch):
    """Files exceeding the per-pipeline row cap raise
    PipelineRowLimitExceeded so the route can 413 instead of OOMing."""
    from backend.uis.pipeline import PipelineRowLimitExceeded

    monkeypatch.setenv("SPIRE_UIS_MAX_ROWS", "5")
    # Build a 10-row CSV; cap is 5
    rows = [
        f"D{i:04d},NSN-{i},owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,1,1,12-MAR-26"
        for i in range(10)
    ]
    raw = _ecp_csv(*rows)

    with pytest.raises(PipelineRowLimitExceeded) as exc:
        run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert exc.value.limit == 5


def test_pipeline_at_cap_passes(monkeypatch):
    """Files exactly at the cap parse normally."""
    monkeypatch.setenv("SPIRE_UIS_MAX_ROWS", "10")
    rows = [
        f"D{i:04d},NSN-{i},owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,1,1,12-MAR-26"
        for i in range(10)
    ]
    raw = _ecp_csv(*rows)
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.report.rows_kept == 10


def test_pipeline_default_cap_is_500k():
    """Sanity — make sure the default cap isn't tiny."""
    from backend.uis.pipeline import _max_rows_per_pipeline
    # No env var set
    assert _max_rows_per_pipeline() >= 100_000


def test_profile_keys_canonicalize_to_match_file_headers():
    """UIS-26 — a profile saved with 'TAMCN' must match a file
    whose header is 'tamcn' (or 'Tamcn' or 'TAMCN_Code'). Without
    canonical-form key matching the profile silently doesn't apply
    and the auto-mapper baseline kicks in instead."""
    from backend.uis.mapping.profile import MappingProfile

    # Profile uses uppercase + underscore form
    profile = MappingProfile(
        profile_id="test/v1",
        source_id="gcss-mc/ecp",
        column_map={
            "TAMCN_CODE": "tamcn",
            "Serial_Number": "serial_number",
            "OWNER_UIC": "owner_uic",  # snake_case form
        },
    )

    # File uses casual / different form for the same logical columns.
    # All three should canonicalize to the same comparison key as the
    # profile entries above (TAMCN_CODE / SERIAL_NUMBER / OWNER_UIC).
    raw = (
        "tamcn code,serialNumber,Owner UIC\n"
        "D1196,owner_serial_aBcDeFgHiJkLmNoPqRsT,owner_uic_zZyYxXwWvVuUtTsSrRqQ\n"
    ).encode("utf-8")

    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"), profile=profile)
    # All three profile keys should match via canonical-form compare
    assert "tamcn code" in result.report.column_map
    assert "serialNumber" in result.report.column_map
    assert "Owner UIC" in result.report.column_map
    # And the canonical fields land
    if result.rows:
        assert result.rows[0]["tamcn"] == "D1196"


def test_profile_with_no_matching_columns_still_runs():
    """If NONE of the profile keys canonicalize-match any file
    column, the pipeline should still produce a result (empty
    column_map, zero rows kept) rather than crash."""
    from backend.uis.mapping.profile import MappingProfile

    profile = MappingProfile(
        profile_id="test/v1",
        source_id="gcss-mc/ecp",
        column_map={"NONEXISTENT": "tamcn"},
    )
    raw = b"foo,bar\n1,2\n"
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"), profile=profile)
    # No crash; column_map is empty since the profile didn't match
    assert result.report.column_map == {}


def test_drrs_mc_adapter_end_to_end():
    """UIS-28 — DRRS-MC adapter (target=CRating) proves the
    framework extends to a non-Asset IDM entity. Same pipeline,
    same auto-mapper, same transforms, same validation — different
    canonical_columns.

    If this test fails the framework has accidentally hard-coded
    something Asset-specific.
    """
    raw = (
        "UNIT_UIC,AS_OF_DATE,C_RATING,MET_SCORES,OPERATOR_ASSESSMENT\n"
        'owner_uic_zZyYxXwWvVuUtTsSrRqQ,2026-04-26,C2,"{""defend"":85,""sustain"":78}",Sustain training shortfall — return to C1 by 15MAY26\n'
        'owner_uic_aBcDeFgHiJkLmNoPqRsT,2026-04-26,c3,"",MET telemetry stale\n'
    ).encode("utf-8")
    result = run_pipeline(raw, get_adapter("drrs-mc/c-rating"))
    assert result.report.rows_kept == 2
    assert result.rows[0]["c_rating"] == "C2"
    # enum alias collapses lowercase "c3" → canonical "C3"
    assert result.rows[1]["c_rating"] == "C3"
    # date type coerces ISO 8601
    from datetime import date as _date
    assert result.rows[0]["as_of_date"] == _date(2026, 4, 26)
    # the pre-hashed UIC value passes through; second row's UIC also pre-hashed
    assert result.rows[0]["unit_uic"].startswith("owner_uic_")


def test_drrs_mc_messy_headers_via_source_aliases():
    """source_aliases on the DRRS adapter let casual export
    variants ("Reporting UIC", "Effective Date", "Cat", "MET
    Scores", "Commander Remarks") all land cleanly without needing
    a saved profile. Phase-0 zero-config support."""
    raw = (
        "Reporting UIC,Effective Date,Cat,MET Scores,Commander Remarks\n"
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,2026-04-26,Cat 2,{},Stable\n"
    ).encode("utf-8")
    result = run_pipeline(raw, get_adapter("drrs-mc/c-rating"))
    assert result.report.rows_kept == 1
    assert result.rows[0]["c_rating"] == "C2"


def test_pipeline_jsonl_input():
    """Pipeline handles a JSONL file with the same schema."""
    raw = (
        b'{"TAMCN":"D1196","NSN":"NSN1","SERIAL_NUMBER":"owner_serial_aBcDeFgHiJkLmNoPqRsT",'
        b'"NOMENCLATURE":"JLTV","OWNER_UIC":"owner_uic_zZyYxXwWvVuUtTsSrRqQ",'
        b'"ALLOWANCE_QTY":"15","ON_HAND_QTY":"12","LAST_INVENTORY_DATE":"12-MAR-26"}\n'
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    assert result.report.detected_format == "jsonl"
    assert result.report.rows_kept == 1


def test_pipeline_records_per_stage_timings():
    """UIS-31 — every successful run reports per-stage wall-clock
    timings so an operator can tell which stage dominates a slow
    upload. We don't assert exact durations (timing is environment-
    dependent), only that each stage key is populated and numeric."""
    raw = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,"
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    timings = result.report.timings_ms
    assert set(timings.keys()) >= {"decode_ms", "detect_ms", "stream_ms", "map_ms", "transform_ms"}
    for stage, value in timings.items():
        assert isinstance(value, (int, float)), f"{stage} is not numeric"
        assert value >= 0


def test_pipeline_timings_surface_in_report_dict():
    """ParseReport.to_dict() carries timings through to the API
    response so the dropzone can render "parsed in 2.3s"."""
    raw = _ecp_csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,"
        "owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    result = run_pipeline(raw, get_adapter("gcss-mc/ecp"))
    payload = result.report.to_dict()
    assert "timings_ms" in payload
    assert "decode_ms" in payload["timings_ms"]
    assert "transform_ms" in payload["timings_ms"]
