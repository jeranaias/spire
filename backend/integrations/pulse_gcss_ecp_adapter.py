"""GCSS-MC Equipment Custodian Report (ECP) ingest adapter for PULSE.

The ECP is the system-of-record for what equipment a unit owns: the
canonical roster of TAMCNs, NSNs, serials, on-hand counts, and the UIC
that "owns" each line. PULSE's risk board, MC%, and forecast surfaces
all derive from this list — so the ECP is the first real-data input
SPIRE needs to wire up before live PULSE pilot use.

Schema parity (the 8 columns the real ECP export emits, post-sanitization):

    TAMCN                 e.g. "D1196"
    NSN                   e.g. "2320-01-540-2480"
    SERIAL_NUMBER         e.g. "JLTV-001234"   (may be sanitized)
    NOMENCLATURE          e.g. "JOINT LIGHT TACTICAL VEHICLE"
    OWNER_UIC             e.g. "OWNER_UIC_<base64url-20>" when sanitized
    ALLOWANCE_QTY         integer T/O&E allowance
    ON_HAND_QTY           integer current count
    LAST_INVENTORY_DATE   DD-MON-YY

Mirrors `backend.integrations.sentry_gcss_adapter` for the SR-header
case: same hashing rules on sensitive identifier fields, same Oracle
DD-MON-YY date handling, same per-row warning collection so a single
malformed row never aborts the batch.

Output shape (`ParsedAssetRow`) maps 1:1 to the columns
`dataset.fleet.Asset` exposes — `asset_id`, `equipment_type`, `tamcn`,
`nsn`, `serial_number`, `nomenclature`, `unit_uic`. The unfilled
behavioral fields (hours, miles, optempo, deployment_status, fielding
date) come from later joins (utilization extracts) or default
heuristics; this adapter is responsible only for the roster columns.

The adapter is import-safe and stateless — the route handler that
mounts it is gated behind the SPIRE_INGEST_ENABLED env var, which is
unset by default so this module ships dormant until a pilot operator
turns ingest on.
"""
from __future__ import annotations

import csv
import hashlib
import io
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import IO, Any, Dict, Iterable, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Header schema — the 8 columns the real GCSS-MC ECP export emits.
# ---------------------------------------------------------------------------

EXPECTED_HEADER_COLUMNS: Tuple[str, ...] = (
    "TAMCN",
    "NSN",
    "SERIAL_NUMBER",
    "NOMENCLATURE",
    "OWNER_UIC",
    "ALLOWANCE_QTY",
    "ON_HAND_QTY",
    "LAST_INVENTORY_DATE",
)

_MONTH_TO_NUM = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

# Two pre-hashed UIC formats accepted (mirrors the SR-header adapter):
#   * SPIRE-emitted export    -> "OWNER_UIC_<sha256-hex-20>"
#   * Real GCSS-MC sanitized  -> "owner_uic_<base64url-20>"
_PRE_HASHED_RE = re.compile(r"^[A-Za-z_]+_[A-Za-z0-9_\-]{20,}$")


@dataclass
class ParsedAssetRow:
    """One parsed ECP row in SPIRE-native shape.

    Maps directly onto `dataset.fleet.Asset` for the roster columns.
    Behavioral fields (hours, miles, optempo, deployment_status,
    fielding_date) are not in the ECP — they come from utilization
    extracts (`UTIL` table) or defaults applied at merge time.
    """

    tamcn: str = ""
    nsn: str = ""
    serial_number: str = ""
    serial_number_source: str = "unknown"  # "missing" / "pre_hashed" / "self_hashed" / "clear"
    nomenclature: str = ""
    owner_uic: str = ""
    owner_uic_source: str = "unknown"
    allowance_qty: int = 0
    on_hand_qty: int = 0
    last_inventory_date: Optional[date] = None
    # Equipment-type label SPIRE uses internally (JLTV / MTVR_CARGO / …).
    # Resolved from TAMCN via lookup at merge time, not in this adapter
    # (keeps the parser stateless). Empty string here means "to be
    # resolved downstream".
    equipment_type: str = ""
    _warnings: List[str] = field(default_factory=list)


@dataclass
class IngestReport:
    """Aggregate report on one ECP file ingest pass."""

    rows_total: int = 0
    rows_kept: int = 0
    rows_with_warnings: int = 0
    rows_with_self_hashed_uic: int = 0
    rows_with_self_hashed_serial: int = 0
    rows_missing_tamcn: int = 0
    rows_missing_serial: int = 0
    date_parse_failures: int = 0
    header_mismatch: bool = False
    header_missing_columns: List[str] = field(default_factory=list)
    header_extra_columns: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def _parse_oracle_date(raw: str) -> Optional[date]:
    """Parse an Oracle DD-MON-YY date string into a Python date.

    Two-digit years 20–69 → 2020–2069; 70–99 → 1970–1999 (Oracle's
    sliding-window default). Returns None on any parse failure; the
    caller bumps `date_parse_failures` and attaches a warning to the
    row.
    """
    s = (raw or "").strip()
    if not s:
        return None
    m = re.match(r"^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})$", s)
    if not m:
        return None
    day_s, mon_s, year_s = m.groups()
    mon = _MONTH_TO_NUM.get(mon_s.upper())
    if mon is None:
        return None
    try:
        day = int(day_s)
    except ValueError:
        return None
    try:
        yr = int(year_s)
    except ValueError:
        return None
    if len(year_s) == 2:
        yr = 2000 + yr if yr < 70 else 1900 + yr
    try:
        return date(yr, mon, day)
    except ValueError:
        return None


def _classify_hashed_field(prefix: str, raw: str) -> Tuple[str, str]:
    """Mirror of sentry_gcss_adapter._classify_hashed_field.

    Returns (value_to_keep, source_label) where source_label is one of
    "missing" / "pre_hashed" / "self_hashed".  A live operational
    ingest path should reject self_hashed rows at the upload boundary
    (the file SHOULD arrive sanitized); SPIRE hashes as defense-in-
    depth so the dataset never holds a clear value even if the file is
    misconfigured.
    """
    s = (raw or "").strip()
    if not s:
        return "", "missing"
    if s.lower() in {"null", "(null)", "n/a", "na", "none"}:
        return "", "missing"
    if _PRE_HASHED_RE.match(s):
        return s, "pre_hashed"
    h = hashlib.sha256(s.encode("utf-8")).hexdigest()[:20]
    return f"{prefix}_{h}", "self_hashed"


def classify_owner_uic(raw: str) -> Tuple[str, str]:
    return _classify_hashed_field("OWNER_UIC", raw)


def classify_serial_number(raw: str) -> Tuple[str, str]:
    return _classify_hashed_field("SERIAL_NUMBER", raw)


def _parse_int(raw: str) -> Optional[int]:
    s = (raw or "").strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except ValueError:
            return None


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


def parse_ecp(
    source: IO[str] | Iterable[str] | str | Path,
    *,
    strict_header: bool = False,
) -> Tuple[List[ParsedAssetRow], IngestReport]:
    """Parse a GCSS-MC Equipment Custodian Report into SPIRE-native rows.

    Parameters
    ----------
    source : file-like / iterable / str / Path
        Either a path to a CSV, the CSV body as a string, or any
        iterable of CSV lines / file-like object.
    strict_header : bool
        When True, raise on header mismatch instead of returning a
        report with `header_mismatch=True`. The pilot route uses
        strict=False so a partially-formed file still surfaces a
        UI-readable error; tests use strict=True to assert schema
        expectations.

    Returns
    -------
    rows, report
        rows: list[ParsedAssetRow] — every row that parsed at all
        (rows missing both TAMCN and serial are dropped because there
        is nothing to merge against).
        report: IngestReport — aggregate counts the upload UI renders.
    """
    if isinstance(source, (str, Path)):
        # Distinguish a filesystem path from a raw CSV body. A CSV body
        # contains newlines and can exceed the OS path-length limit —
        # probing it with Path.exists() raises ENAMETOOLONG on Linux (Windows
        # just returns False, which is why this only bit in CI). Only stat
        # inputs that could plausibly be a path.
        as_str = str(source)
        maybe_path = "\n" not in as_str and len(as_str) < 1024
        if maybe_path:
            try:
                path = Path(source)
                if path.exists():
                    with path.open("r", encoding="utf-8", newline="") as fh:
                        return _parse_rows(csv.reader(fh), strict_header=strict_header)
            except OSError:
                pass
        # treat the str as raw CSV body
        return _parse_rows(csv.reader(io.StringIO(as_str)), strict_header=strict_header)
    if hasattr(source, "read"):
        # file-like
        text = source.read()
        if isinstance(text, bytes):
            text = text.decode("utf-8")
        return _parse_rows(csv.reader(io.StringIO(text)), strict_header=strict_header)
    # generic iterable of lines
    return _parse_rows(csv.reader(iter(source)), strict_header=strict_header)


def _parse_rows(
    reader: Iterable[List[str]],
    *,
    strict_header: bool,
) -> Tuple[List[ParsedAssetRow], IngestReport]:
    report = IngestReport()
    rows: List[ParsedAssetRow] = []
    header: Optional[List[str]] = None
    for raw_row in reader:
        if not raw_row:
            continue
        if header is None:
            header = [c.strip() for c in raw_row]
            missing = [c for c in EXPECTED_HEADER_COLUMNS if c not in header]
            extra = [c for c in header if c not in EXPECTED_HEADER_COLUMNS]
            if missing or extra:
                report.header_mismatch = True
                report.header_missing_columns = missing
                report.header_extra_columns = extra
                if strict_header:
                    raise ValueError(
                        f"ECP header mismatch — missing={missing} extra={extra}"
                    )
            continue
        report.rows_total += 1
        cells = {h: (raw_row[i] if i < len(raw_row) else "") for i, h in enumerate(header)}
        parsed = _parse_one(cells, report)
        if parsed is None:
            continue
        rows.append(parsed)
        report.rows_kept += 1
        if parsed._warnings:
            report.rows_with_warnings += 1
    return rows, report


def _parse_one(cells: Dict[str, str], report: IngestReport) -> Optional[ParsedAssetRow]:
    row = ParsedAssetRow()
    row.tamcn = (cells.get("TAMCN", "") or "").strip()
    row.nsn = (cells.get("NSN", "") or "").strip()
    row.nomenclature = (cells.get("NOMENCLATURE", "") or "").strip()

    # Sensitive fields go through the hash-classifier
    serial_value, serial_src = classify_serial_number(cells.get("SERIAL_NUMBER", ""))
    row.serial_number = serial_value
    row.serial_number_source = serial_src
    if serial_src == "self_hashed":
        report.rows_with_self_hashed_serial += 1
        row._warnings.append("serial_number_self_hashed")

    uic_value, uic_src = classify_owner_uic(cells.get("OWNER_UIC", ""))
    row.owner_uic = uic_value
    row.owner_uic_source = uic_src
    if uic_src == "self_hashed":
        report.rows_with_self_hashed_uic += 1
        row._warnings.append("owner_uic_self_hashed")

    allowance = _parse_int(cells.get("ALLOWANCE_QTY", ""))
    on_hand = _parse_int(cells.get("ON_HAND_QTY", ""))
    if allowance is not None:
        row.allowance_qty = allowance
    if on_hand is not None:
        row.on_hand_qty = on_hand

    inv_date = _parse_oracle_date(cells.get("LAST_INVENTORY_DATE", ""))
    if inv_date is None and cells.get("LAST_INVENTORY_DATE", "").strip():
        report.date_parse_failures += 1
        row._warnings.append("last_inventory_date_unparseable")
    row.last_inventory_date = inv_date

    # Drop rows that have neither a TAMCN nor a serial — without one of
    # them there is nothing to merge against the canonical roster, so
    # the row is effectively unidentifiable.
    if not row.tamcn and not row.serial_number:
        report.rows_missing_tamcn += 1
        report.rows_missing_serial += 1
        return None
    if not row.tamcn:
        report.rows_missing_tamcn += 1
        row._warnings.append("missing_tamcn")
    if not row.serial_number:
        report.rows_missing_serial += 1
        row._warnings.append("missing_serial")
    return row
