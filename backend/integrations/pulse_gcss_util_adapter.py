"""GCSS-MC Utilization (UTIL) extract ingest adapter for PULSE.

Where the ECP adapter answers "what equipment do we own?", the UTIL
extract answers "how hard has it been worked?". Each row is a
periodic reading: hours/miles totals + a readiness code per asset.

The PULSE risk-board model consumes utilization deltas to predict
component wear; without real readings every prediction is back-fitted
to synthetic dataset trajectories. This is the second highest-value
real-data ingest after the ECP roster.

Schema parity (the 6 columns the real UTIL extract emits):

    ASSET_ID            stable identifier matching the ECP roster
                        (post-sanitization, may be hashed)
    READING_DATE        DD-MON-YY (Oracle sliding window)
    TOTAL_HOURS         cumulative engine hours
    TOTAL_MILES         cumulative odometer miles
    READINESS_CODE      MC | PMC | NMCM | NMCS
    READING_SOURCE      manual | telematics | pmcs | inspection

Differences from ECP:
- Per-asset / per-day shape — many rows per asset over time. The
  apply target is `Asset.current_hours / current_miles /
  current_status` (latest reading wins), but the route can also
  store the time series for trend forecasting.
- Numeric fields. Hours and miles are floats; the parser tolerates
  scientific notation, missing decimals, and Oracle null sentinels.
- Readiness code validation: must be one of the four canonical codes
  or it's flagged as a data-quality warning.

The adapter is import-safe and stateless (mirrors the ECP/SR-header
sibling). The route handler that mounts it is gated behind the same
SPIRE_INGEST_ENABLED env var; this module ships dormant.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import IO, Any, Dict, Iterable, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Header schema
# ---------------------------------------------------------------------------

EXPECTED_HEADER_COLUMNS: Tuple[str, ...] = (
    "ASSET_ID",
    "READING_DATE",
    "TOTAL_HOURS",
    "TOTAL_MILES",
    "READINESS_CODE",
    "READING_SOURCE",
)

VALID_READINESS_CODES = frozenset({"MC", "PMC", "NMCM", "NMCS"})

VALID_READING_SOURCES = frozenset({"manual", "telematics", "pmcs", "inspection"})

_MONTH_TO_NUM = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


@dataclass
class ParsedUtilizationRow:
    """One parsed utilization reading."""

    asset_id: str = ""
    reading_date: Optional[date] = None
    total_hours: Optional[float] = None
    total_miles: Optional[int] = None
    readiness_code: str = ""
    reading_source: str = ""
    _warnings: List[str] = field(default_factory=list)


@dataclass
class UtilIngestReport:
    """Aggregate report on one UTIL file ingest pass."""

    rows_total: int = 0
    rows_kept: int = 0
    rows_with_warnings: int = 0
    rows_missing_asset_id: int = 0
    rows_missing_date: int = 0
    rows_with_invalid_readiness: int = 0
    rows_with_unknown_source: int = 0
    date_parse_failures: int = 0
    numeric_parse_failures: int = 0
    header_mismatch: bool = False
    header_missing_columns: List[str] = field(default_factory=list)
    header_extra_columns: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def _parse_oracle_date(raw: str) -> Optional[date]:
    """Same DD-MON-YY parser the ECP adapter uses. Sliding-window two-digit
    years: 20-69 → 2020s/30s/…/60s; 70-99 → 1970s/80s/90s."""
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


def _parse_float(raw: str) -> Optional[float]:
    s = (raw or "").strip()
    if not s or s.lower() in {"null", "(null)", "n/a", "na", "none"}:
        return None
    # Strip thousand separators that some Oracle exports include.
    s = s.replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def _parse_int(raw: str) -> Optional[int]:
    f = _parse_float(raw)
    if f is None:
        return None
    return int(f)


def _normalize_source(raw: str) -> Tuple[str, bool]:
    """Returns (lowercased_source, is_known)."""
    s = (raw or "").strip().lower()
    if not s:
        return "", False
    return s, s in VALID_READING_SOURCES


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


def parse_util(
    source: IO[str] | Iterable[str] | str | Path,
    *,
    strict_header: bool = False,
) -> Tuple[List[ParsedUtilizationRow], UtilIngestReport]:
    """Parse a GCSS-MC utilization extract.

    Same calling convention as `parse_ecp(...)` — accepts a path, a
    raw CSV body, a file-like, or any iterable of CSV lines.

    Returns
    -------
    rows, report
    """
    if isinstance(source, (str, Path)):
        path = Path(source)
        if path.exists():
            with path.open("r", encoding="utf-8", newline="") as fh:
                return _parse_rows(csv.reader(fh), strict_header=strict_header)
        return _parse_rows(csv.reader(io.StringIO(str(source))), strict_header=strict_header)
    if hasattr(source, "read"):
        text = source.read()
        if isinstance(text, bytes):
            text = text.decode("utf-8")
        return _parse_rows(csv.reader(io.StringIO(text)), strict_header=strict_header)
    return _parse_rows(csv.reader(iter(source)), strict_header=strict_header)


def _parse_rows(
    reader: Iterable[List[str]],
    *,
    strict_header: bool,
) -> Tuple[List[ParsedUtilizationRow], UtilIngestReport]:
    report = UtilIngestReport()
    rows: List[ParsedUtilizationRow] = []
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
                        f"UTIL header mismatch — missing={missing} extra={extra}"
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


def _parse_one(cells: Dict[str, str], report: UtilIngestReport) -> Optional[ParsedUtilizationRow]:
    row = ParsedUtilizationRow()
    row.asset_id = (cells.get("ASSET_ID", "") or "").strip()
    if not row.asset_id:
        report.rows_missing_asset_id += 1
        # No asset_id = no merge target. Drop entirely.
        return None

    row.reading_date = _parse_oracle_date(cells.get("READING_DATE", ""))
    if row.reading_date is None:
        if (cells.get("READING_DATE") or "").strip():
            report.date_parse_failures += 1
            row._warnings.append("reading_date_unparseable")
        else:
            report.rows_missing_date += 1
            row._warnings.append("missing_reading_date")
        # A reading without a date is still ingestable — apply path
        # treats it as "today's reading" as long as the operator
        # accepts the warning. Don't drop.

    hours = _parse_float(cells.get("TOTAL_HOURS", ""))
    if hours is None and (cells.get("TOTAL_HOURS") or "").strip():
        report.numeric_parse_failures += 1
        row._warnings.append("total_hours_unparseable")
    row.total_hours = hours

    miles = _parse_int(cells.get("TOTAL_MILES", ""))
    if miles is None and (cells.get("TOTAL_MILES") or "").strip():
        report.numeric_parse_failures += 1
        row._warnings.append("total_miles_unparseable")
    row.total_miles = miles

    readiness = (cells.get("READINESS_CODE", "") or "").strip().upper()
    if readiness and readiness not in VALID_READINESS_CODES:
        report.rows_with_invalid_readiness += 1
        row._warnings.append(f"invalid_readiness_code:{readiness}")
        readiness = ""  # drop the bogus value
    row.readiness_code = readiness

    src, src_known = _normalize_source(cells.get("READING_SOURCE", ""))
    if src and not src_known:
        report.rows_with_unknown_source += 1
        row._warnings.append(f"unknown_source:{src}")
    row.reading_source = src

    return row


# ---------------------------------------------------------------------------
# Apply primitive — latest-reading-wins for current_* fields.
# ---------------------------------------------------------------------------


def apply_latest_readings(
    rows: List[ParsedUtilizationRow],
    canonical_assets: Iterable[Any],
) -> Tuple[List[Any], Dict[str, int]]:
    """Walk the canonical assets and update current_hours / current_miles
    / current_status from the most-recent matching row per asset_id.

    Returns (updated_assets, applied_counts).

    Multiple rows per asset: pick the one with the latest
    `reading_date`. Ties resolve in row-list order (last-seen wins).
    Rows whose asset_id doesn't match any canonical asset are
    dropped from this apply path; the route surfaces them in the
    `unmatched` count for the operator.
    """
    # Index latest reading per asset_id
    latest: Dict[str, ParsedUtilizationRow] = {}
    for row in rows:
        prior = latest.get(row.asset_id)
        if prior is None:
            latest[row.asset_id] = row
            continue
        # Prefer the row with the more recent reading_date; if either
        # is missing a date, keep whichever has one.
        prior_d = prior.reading_date
        cur_d = row.reading_date
        if cur_d is not None and (prior_d is None or cur_d >= prior_d):
            latest[row.asset_id] = row

    applied = {"matched": 0, "unmatched_rows": 0, "skipped_assets": 0}
    asset_ids_seen: set = set()
    new_assets: List[Any] = []
    for asset in canonical_assets:
        new_assets.append(asset)
        asset_id = getattr(asset, "asset_id", "")
        asset_ids_seen.add(asset_id)
        latest_row = latest.get(asset_id)
        if latest_row is None:
            applied["skipped_assets"] += 1
            continue
        if latest_row.total_hours is not None and hasattr(asset, "current_hours"):
            asset.current_hours = latest_row.total_hours
        if latest_row.total_miles is not None and hasattr(asset, "current_miles"):
            asset.current_miles = latest_row.total_miles
        if latest_row.readiness_code and hasattr(asset, "current_status"):
            asset.current_status = latest_row.readiness_code
        applied["matched"] += 1

    applied["unmatched_rows"] = sum(
        1 for aid in latest.keys() if aid not in asset_ids_seen
    )
    return new_assets, applied
