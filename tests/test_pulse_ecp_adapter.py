"""Smoke tests for the GCSS-MC ECP ingest adapter."""
from __future__ import annotations

from datetime import date
from io import StringIO

import pytest

from backend.integrations.pulse_gcss_ecp_adapter import (
    EXPECTED_HEADER_COLUMNS,
    IngestReport,
    ParsedAssetRow,
    classify_owner_uic,
    classify_serial_number,
    parse_ecp,
)


VALID_HEADER = ",".join(EXPECTED_HEADER_COLUMNS)


def _csv(*lines: str) -> str:
    return "\n".join((VALID_HEADER, *lines)) + "\n"


def test_classify_owner_uic_pre_hashed_passes_through():
    """A pre-hashed UIC keeps its value and is labelled `pre_hashed`."""
    pre = "owner_uic_aBcDeFgHiJkLmNoPqRsT"
    value, src = classify_owner_uic(pre)
    assert value == pre
    assert src == "pre_hashed"


def test_classify_serial_number_self_hashes_clear_value():
    """A clear SN gets hashed defensively and labelled `self_hashed`."""
    value, src = classify_serial_number("JLTV-001234")
    assert src == "self_hashed"
    assert value.startswith("SERIAL_NUMBER_")
    assert len(value) == len("SERIAL_NUMBER_") + 20


def test_classify_serial_number_missing_returns_empty():
    for sentinel in ("", "  ", "null", "(null)", "n/a", "NA", "None"):
        value, src = classify_serial_number(sentinel)
        assert value == ""
        assert src == "missing"


def test_parse_ecp_kept_row_minimal():
    """One well-formed row parses with no warnings."""
    body = _csv(
        # TAMCN, NSN, SERIAL, NOM, OWNER_UIC, ALLOW, OH, LAST_INV
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JOINT LIGHT TACTICAL VEHICLE,owner_uic_zZyYxXwWvVuUtTsSrRqQ,15,12,12-MAR-26"
    )
    rows, report = parse_ecp(body)
    assert len(rows) == 1
    assert report.rows_kept == 1
    assert report.rows_with_warnings == 0
    r = rows[0]
    assert r.tamcn == "D1196"
    assert r.nsn == "2320-01-540-2480"
    assert r.nomenclature == "JOINT LIGHT TACTICAL VEHICLE"
    assert r.allowance_qty == 15
    assert r.on_hand_qty == 12
    assert r.last_inventory_date == date(2026, 3, 12)
    assert r.serial_number_source == "pre_hashed"
    assert r.owner_uic_source == "pre_hashed"


def test_parse_ecp_self_hashes_clear_uic_and_warns():
    """Clear UIC values trigger self_hashing + a per-row warning."""
    body = _csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JOINT LIGHT TACTICAL VEHICLE,M40128,15,12,12-MAR-26"
    )
    rows, report = parse_ecp(body)
    assert len(rows) == 1
    r = rows[0]
    assert r.owner_uic_source == "self_hashed"
    assert r.owner_uic.startswith("OWNER_UIC_")
    assert "owner_uic_self_hashed" in r._warnings
    assert report.rows_with_self_hashed_uic == 1
    assert report.rows_with_warnings == 1


def test_parse_ecp_rejects_row_with_neither_tamcn_nor_serial():
    """Rows missing both TAMCN and serial are dropped."""
    body = _csv(
        ",,,JOINT LIGHT TACTICAL VEHICLE,owner_uic_zZyYxXwWvVuUtTsSrRqQ,1,1,12-MAR-26"
    )
    rows, report = parse_ecp(body)
    assert rows == []
    assert report.rows_kept == 0
    assert report.rows_total == 1
    assert report.rows_missing_tamcn == 1
    assert report.rows_missing_serial == 1


def test_parse_ecp_strict_header_raises_on_mismatch():
    """strict_header=True raises ValueError when columns are wrong."""
    body = "TAMCN,NSN,SERIAL_NUMBER\nD1196,foo,bar\n"
    with pytest.raises(ValueError):
        parse_ecp(body, strict_header=True)


def test_parse_ecp_lenient_header_returns_report_flag():
    """Default (lenient) ingest surfaces header_mismatch in the report."""
    body = "TAMCN,NSN,SERIAL_NUMBER\nD1196,foo,bar\n"
    rows, report = parse_ecp(body)
    assert report.header_mismatch is True
    # Missing 5 of 8 required cols
    assert "NOMENCLATURE" in report.header_missing_columns
    assert "OWNER_UIC" in report.header_missing_columns


def test_parse_ecp_handles_oracle_date_two_digit_years():
    """26 → 2026, 70 → 1970 (Oracle sliding window)."""
    body = _csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,1,1,15-NOV-26",
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsU,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,1,1,03-JAN-72",
    )
    rows, _ = parse_ecp(body)
    assert len(rows) == 2
    assert rows[0].last_inventory_date == date(2026, 11, 15)
    assert rows[1].last_inventory_date == date(1972, 1, 3)


def test_parse_ecp_unparseable_date_warns_but_keeps_row():
    body = _csv(
        "D1196,2320-01-540-2480,owner_serial_aBcDeFgHiJkLmNoPqRsT,JLTV,owner_uic_zZyYxXwWvVuUtTsSrRqQ,1,1,nonsense"
    )
    rows, report = parse_ecp(body)
    assert len(rows) == 1
    assert rows[0].last_inventory_date is None
    assert "last_inventory_date_unparseable" in rows[0]._warnings
    assert report.date_parse_failures == 1
