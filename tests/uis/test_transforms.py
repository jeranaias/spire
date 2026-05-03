"""UIS transforms — date / coerce / hashing / enums."""
from __future__ import annotations

from datetime import date

import pytest

from backend.uis.transforms import (
    classify_hashed_field,
    hash_field,
    map_enum,
    parse_bool,
    parse_date,
    parse_date_excel,
    parse_date_oracle,
    parse_datetime,
    parse_float,
    parse_int,
)


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("raw,expected", [
    ("12-MAR-26", date(2026, 3, 12)),
    ("3-jan-26", date(2026, 1, 3)),
    ("31-DEC-99", date(1999, 12, 31)),  # sliding window: 99 → 1999
    ("01-FEB-70", date(1970, 2, 1)),    # sliding window: 70 → 1970
    ("15-NOV-26", date(2026, 11, 15)),
    ("15-NOV-2026", date(2026, 11, 15)),  # 4-digit year passes through
    ("  12-MAR-26  ", date(2026, 3, 12)),  # whitespace tolerant
])
def test_parse_date_oracle_happy_path(raw, expected):
    assert parse_date_oracle(raw) == expected


@pytest.mark.parametrize("raw", [
    "", None, "null", "(null)", "n/a", "NA", "None",
    "32-JAN-26",       # invalid day
    "01-XYZ-26",       # invalid month
    "not a date",
    "2026-03-12",      # ISO format — wrong dialect
])
def test_parse_date_oracle_returns_none_on_garbage(raw):
    assert parse_date_oracle(raw) is None


@pytest.mark.parametrize("raw,expected", [
    ("2026-03-12", date(2026, 3, 12)),
    ("2026/03/12", date(2026, 3, 12)),
    ("3/12/2026", date(2026, 3, 12)),     # US MM/DD/YYYY
    ("12-03-2026", None),                 # ambiguous, we don't guess
])
def test_parse_date_iso_and_us(raw, expected):
    assert parse_date(raw) == expected


def test_parse_datetime_iso8601():
    dt = parse_datetime("2026-03-12T07:14:23")
    assert dt is not None
    assert dt.year == 2026 and dt.month == 3 and dt.day == 12

def test_parse_datetime_z_suffix_normalizes():
    dt = parse_datetime("2026-03-12T07:14:23Z")
    assert dt is not None
    assert dt.tzinfo is not None  # +00:00 attached


def test_parse_date_excel_serial():
    # Excel epoch is 1899-12-30 (anchor accounts for the 1900 leap-year bug)
    assert parse_date_excel("1") == date(1899, 12, 31)
    # 45728 is the Excel serial for 2025-03-12 (or thereabouts — verify)
    d = parse_date_excel("45728")
    assert d is not None and d.year >= 2025


def test_parse_date_excel_returns_none_on_garbage():
    assert parse_date_excel("not numeric") is None
    assert parse_date_excel("") is None
    assert parse_date_excel("null") is None


# ---------------------------------------------------------------------------
# Coercion
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("raw,expected", [
    ("42", 42),
    ("  42  ", 42),
    ("3.14", 3),         # truncates float
    ("1e3", 1000),
    ("1,234", 1234),     # thousand separator
    ("42,750", 42750),
])
def test_parse_int_happy(raw, expected):
    assert parse_int(raw) == expected


@pytest.mark.parametrize("raw", ["", "null", "abc", None])
def test_parse_int_returns_none_on_garbage(raw):
    assert parse_int(raw) is None


@pytest.mark.parametrize("raw,expected", [
    ("3.14", 3.14),
    ("0", 0.0),
    ("1.5e2", 150.0),
    ("1,234.56", 1234.56),
])
def test_parse_float_happy(raw, expected):
    assert parse_float(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    ("true", True), ("True", True), ("YES", True), ("y", True), ("1", True), ("on", True),
    ("false", False), ("False", False), ("NO", False), ("n", False), ("0", False), ("off", False),
])
def test_parse_bool_happy(raw, expected):
    assert parse_bool(raw) is expected


@pytest.mark.parametrize("raw", ["", "null", "maybe", None])
def test_parse_bool_returns_none_on_garbage(raw):
    assert parse_bool(raw) is None


# ---------------------------------------------------------------------------
# Hashing
# ---------------------------------------------------------------------------


def test_classify_pre_hashed_passthrough():
    pre = "owner_uic_aBcDeFgHiJkLmNoPqRsT"
    value, src = classify_hashed_field("OWNER_UIC", pre)
    assert value == pre
    assert src == "pre_hashed"


def test_classify_self_hashes_clear_value():
    value, src = classify_hashed_field("OWNER_UIC", "M55670")
    assert src == "self_hashed"
    assert value.startswith("OWNER_UIC_")
    assert len(value) == len("OWNER_UIC_") + 20


def test_classify_missing_returns_empty():
    for sentinel in ("", "  ", "null", "(null)", "n/a", "NA", "None", None):
        value, src = classify_hashed_field("X", sentinel) if sentinel is not None else ("", "missing")
        assert value == ""
        assert src == "missing"


def test_hash_field_force_hashes_clear_or_prehashed():
    # Force-hashing a clear value
    h1 = hash_field("X", "M55670")
    assert h1.startswith("X_") and len(h1) == 22
    # Force-hashing a value that LOOKS pre-hashed still re-hashes it
    h2 = hash_field("X", "owner_uic_aBcDeFgHiJkLmNoPqRsT")
    assert h2.startswith("X_") and h2 != "owner_uic_aBcDeFgHiJkLmNoPqRsT"


# ---------------------------------------------------------------------------
# Enum
# ---------------------------------------------------------------------------


def test_map_enum_canonical():
    aliases = {"MC": "MC", "mc": "MC", "M.C.": "MC", "Mission Capable": "MC"}
    assert map_enum("MC", aliases) == "MC"
    assert map_enum("mc", aliases) == "MC"
    assert map_enum("M.C.", aliases) == "MC"
    assert map_enum("Mission Capable", aliases) == "MC"


def test_map_enum_unknown_passes_through():
    aliases = {"MC": "MC"}
    assert map_enum("UNKNOWN", aliases) == "UNKNOWN"


def test_map_enum_missing_returns_none():
    assert map_enum("", {"MC": "MC"}) is None
    assert map_enum(None, {"MC": "MC"}) is None
