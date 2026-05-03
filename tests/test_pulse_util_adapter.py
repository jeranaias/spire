"""Tests for the GCSS-MC utilization extract adapter (RD7)."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import List

import pytest

from backend.integrations.pulse_gcss_util_adapter import (
    EXPECTED_HEADER_COLUMNS,
    ParsedUtilizationRow,
    apply_latest_readings,
    parse_util,
)


HEADER = ",".join(EXPECTED_HEADER_COLUMNS)


def _csv(*lines: str) -> str:
    return "\n".join((HEADER, *lines)) + "\n"


@dataclass
class FakeAsset:
    asset_id: str
    current_hours: float = 0.0
    current_miles: int = 0
    current_status: str = "MC"


def test_header_mismatch_lenient_returns_flag():
    body = "ASSET_ID,FOO\nM-001,bar\n"
    rows, report = parse_util(body)
    assert report.header_mismatch is True
    # Missing 5 of 6 expected columns
    assert "READING_DATE" in report.header_missing_columns
    assert "TOTAL_HOURS" in report.header_missing_columns


def test_header_mismatch_strict_raises():
    body = "ASSET_ID,FOO\nM-001,bar\n"
    with pytest.raises(ValueError):
        parse_util(body, strict_header=True)


def test_parse_well_formed_row():
    body = _csv(
        "M21670-JLTV-001,12-MAR-26,3294.5,42750,MC,telematics"
    )
    rows, report = parse_util(body)
    assert len(rows) == 1
    assert report.rows_kept == 1
    assert report.rows_with_warnings == 0
    r = rows[0]
    assert r.asset_id == "M21670-JLTV-001"
    assert r.reading_date == date(2026, 3, 12)
    assert r.total_hours == 3294.5
    assert r.total_miles == 42750
    assert r.readiness_code == "MC"
    assert r.reading_source == "telematics"


def test_drops_row_without_asset_id():
    body = _csv(
        ",12-MAR-26,3294.5,42750,MC,manual"
    )
    rows, report = parse_util(body)
    assert rows == []
    assert report.rows_missing_asset_id == 1


def test_invalid_readiness_code_warns_and_clears_value():
    body = _csv(
        "M-A,12-MAR-26,100,200,WTF,manual"
    )
    rows, report = parse_util(body)
    assert len(rows) == 1
    assert report.rows_with_invalid_readiness == 1
    assert rows[0].readiness_code == ""
    assert any(w.startswith("invalid_readiness_code") for w in rows[0]._warnings)


def test_unknown_source_warns_but_keeps_value():
    body = _csv(
        "M-A,12-MAR-26,100,200,MC,satellite_uplink"
    )
    rows, report = parse_util(body)
    assert len(rows) == 1
    assert report.rows_with_unknown_source == 1
    assert rows[0].reading_source == "satellite_uplink"


def test_unparseable_numeric_warns_but_keeps_row():
    body = _csv(
        "M-A,12-MAR-26,abc,xyz,MC,manual"
    )
    rows, report = parse_util(body)
    assert len(rows) == 1
    assert report.numeric_parse_failures == 2
    assert rows[0].total_hours is None
    assert rows[0].total_miles is None


def test_oracle_thousand_separator_in_miles():
    body = _csv(
        'M-A,12-MAR-26,1500,"42,750",MC,manual'
    )
    rows, _ = parse_util(body)
    assert rows[0].total_miles == 42750


def test_apply_latest_readings_picks_latest_per_asset():
    """Multiple rows for same asset: latest reading_date wins."""
    rows = [
        ParsedUtilizationRow(
            asset_id="M-A",
            reading_date=date(2026, 1, 1),
            total_hours=100.0,
            total_miles=1000,
            readiness_code="PMC",
        ),
        ParsedUtilizationRow(
            asset_id="M-A",
            reading_date=date(2026, 4, 1),
            total_hours=250.0,
            total_miles=3500,
            readiness_code="MC",
        ),
        ParsedUtilizationRow(
            asset_id="M-A",
            reading_date=date(2026, 2, 15),
            total_hours=180.0,
            total_miles=2200,
            readiness_code="NMCM",
        ),
    ]
    asset = FakeAsset(asset_id="M-A")
    updated, applied = apply_latest_readings(rows, [asset])
    assert applied["matched"] == 1
    a = updated[0]
    assert a.current_hours == 250.0  # latest of three
    assert a.current_miles == 3500
    assert a.current_status == "MC"


def test_apply_latest_readings_skips_assets_with_no_rows():
    rows = [
        ParsedUtilizationRow(
            asset_id="M-A",
            reading_date=date(2026, 4, 1),
            total_hours=250.0,
            total_miles=3500,
            readiness_code="MC",
        ),
    ]
    asset_with_data = FakeAsset(asset_id="M-A")
    asset_no_data = FakeAsset(asset_id="M-B", current_hours=99.0)
    updated, applied = apply_latest_readings(rows, [asset_with_data, asset_no_data])
    assert applied["matched"] == 1
    assert applied["skipped_assets"] == 1
    # The unmatched asset is preserved with its prior state
    assert updated[1].current_hours == 99.0


def test_apply_latest_readings_counts_unmatched_rows():
    """Rows whose asset_id has no canonical match show up in the count."""
    rows = [
        ParsedUtilizationRow(
            asset_id="M-GHOST",
            reading_date=date(2026, 4, 1),
            total_hours=10.0,
        ),
    ]
    asset = FakeAsset(asset_id="M-A")
    _, applied = apply_latest_readings(rows, [asset])
    assert applied["unmatched_rows"] == 1
    assert applied["matched"] == 0


def test_apply_latest_readings_skips_none_fields():
    """A row with only readiness_code populated only updates status."""
    rows = [
        ParsedUtilizationRow(
            asset_id="M-A",
            reading_date=date(2026, 4, 1),
            readiness_code="NMCS",
        ),
    ]
    asset = FakeAsset(asset_id="M-A", current_hours=42.0, current_miles=999)
    updated, _ = apply_latest_readings(rows, [asset])
    a = updated[0]
    # hours/miles untouched (row had None)
    assert a.current_hours == 42.0
    assert a.current_miles == 999
    # status updated
    assert a.current_status == "NMCS"
