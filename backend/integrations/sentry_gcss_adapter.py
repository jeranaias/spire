"""GCSS-MC ingest adapter for SENTRY.

Reads a real-shape GCSS-MC SR header export (12 columns, DD-MON-YY dates,
operator-typed defect codes with trailing periods, hashed UIC strings) and
returns a list of normalized SR-shaped dicts SENTRY's existing pipeline can
walk through. The shape mirrors `dataset.lifecycle.ServiceRequest` for the
columns SPIRE consumes.

Key normalization rules:
  - DEFECT_CODE: strip trailing periods, split on `.` → primary/secondary.
  - DATE_RECEIVED_IN_SHOP / DEADLINED_DATE / JOB_STATUS_DATE: parse Oracle
    DD-MON-YY (e.g. "12-MAR-26" → date(2026, 3, 12)). Two-digit years
    20-69 → 2020-2069; 70-99 → 1970-1999 (Oracle's default sliding-window
    approximation).
  - OWNER_UNIT_ADDRESS_CODE: passed through. Already sanitized in the real
    export as `<field>_<sha256-trunc-20>` so we just mark the source as
    `pre_hashed` and never attempt a reverse-lookup.
  - MASTER_PRIORITY_CODE: full `NN B-Label` strings are kept verbatim.
  - SERVICE_REQUEST_TYPE: only `Maintenance - CM` rows are kept by
    default; the real export filters PMCS upstream.

The adapter never raises on a single bad row. Each parse failure attaches
itself to the per-row `_warnings` list and the row is still returned with
best-effort fields populated, so SENTRY can route partial-quality rows to
its review queue rather than dropping them silently.
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
# Header schema — the 12 columns the real GCSS-MC SR header export emits.
# ---------------------------------------------------------------------------

EXPECTED_HEADER_COLUMNS: Tuple[str, ...] = (
    "SERVICE_REQUEST_TYPE",
    "SR_NUMBER",
    "DEFECT_CODE",
    "PROBLEM_SUMMARY",
    "DATE_RECEIVED_IN_SHOP",
    "ECHELON_OF_MAINT",
    "SERIAL_NUMBER",
    "TAMCN",
    "DEADLINED_DATE",
    "MASTER_PRIORITY_CODE",
    "OWNER_UNIT_ADDRESS_CODE",
    "JOB_STATUS_DATE",
)

_MONTH_TO_NUM = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

# Two pre-hashed UIC formats are accepted:
#   * SPIRE-emitted export    -> "OWNER_UNIT_<sha256-hex-20>"
#                                (uppercase prefix, [a-f0-9]{20} suffix)
#   * Real GCSS-MC sanitized  -> "owner_unit_address_code_<base64url-20>"
#                                (lowercase prefix, [A-Za-z0-9_-]{20} suffix)
# Match either: any letters/underscores prefix (case-insensitive) joined to
# a 20+ char base64url-style suffix by an underscore.
_PRE_HASHED_RE = re.compile(r"^[A-Za-z_]+_[A-Za-z0-9_\-]{20,}$")


@dataclass
class ParsedSrHeader:
    """One parsed SR-header row, in SPIRE-native shape."""

    sr_number: str = ""
    service_request_type: str = ""
    defect_code_primary: str = ""
    defect_code_secondary: str = ""
    defect_code_raw: str = ""
    problem_summary: str = ""
    open_date: Optional[date] = None
    echelon_numeric: Optional[int] = None
    serial_number: str = ""
    tamcn: str = ""
    deadlined_date: Optional[date] = None
    priority: str = ""
    unit_uic_hashed: str = ""
    unit_uic_source: str = "unknown"
    job_status_date: Optional[date] = None
    # Per-field sanitization classification: each maps to "missing",
    # "pre_hashed", or "self_hashed". The upload route's hash gate
    # rejects rows where any of the four sensitive fields is
    # "self_hashed" (i.e. SPIRE had to hash a clear value because the
    # source did not).
    sensitive_field_sources: Dict[str, str] = field(default_factory=dict)
    _warnings: List[str] = field(default_factory=list)


def _classify_hashed_field(prefix: str, raw: str) -> Tuple[str, str]:
    """Generic per-field sanitization classifier for sensitive identifiers.

    Returns ``(value_to_keep, source_label)`` where ``source_label`` is
    ``"missing"``, ``"pre_hashed"`` (already in canonical hashed form), or
    ``"self_hashed"`` (was clear, SPIRE hashed it as defense-in-depth).
    Oracle null sentinels (``"null"``, ``"(null)"``, etc.) are treated
    as ``"missing"``.
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


def classify_sr_number(raw: str) -> Tuple[str, str]:
    return _classify_hashed_field("SR_NUMBER", raw)


def classify_serial_number(raw: str) -> Tuple[str, str]:
    return _classify_hashed_field("SERIAL_NUMBER", raw)


def classify_tamcn(raw: str) -> Tuple[str, str]:
    return _classify_hashed_field("TAMCN", raw)


@dataclass
class IngestReport:
    """Aggregate ingest report — what SENTRY's UI/CLI summarizes."""

    rows_total: int = 0
    rows_kept: int = 0
    rows_filtered_pmcs: int = 0
    rows_with_warnings: int = 0
    defect_code_trailing_period_normalized: int = 0
    date_parse_failures: int = 0
    # Per-sensitive-field counts of rows where SPIRE had to hash the raw
    # value because the source did not (i.e. the file was not properly
    # sanitized). Keys: sr_number, serial_number, tamcn, owner_unit_address_code.
    unsanitized_field_counts: Dict[str, int] = field(default_factory=dict)
    rows: List[ParsedSrHeader] = field(default_factory=list)
    schema_warnings: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Field-level normalizers
# ---------------------------------------------------------------------------

def normalize_defect_code(raw: str) -> Tuple[str, str, bool]:
    """`FCON.CBB` → `("FCON", "CBB", False)`.
    `FCON.`     → `("FCON", "",   True)`  (trailing-period dirty signal).
    `FCON`      → `("FCON", "",   False)`.
    Returns `(primary, secondary, was_trailing_period)`.
    """
    if not raw:
        return "", "", False
    s = raw.strip()
    had_trailing = s.endswith(".") and "." in s[:-1] is False
    # Strip *all* trailing periods so the canonical primary is clean.
    cleaned = s
    while cleaned.endswith("."):
        cleaned = cleaned[:-1]
        had_trailing = True
    parts = cleaned.split(".", 1)
    primary = parts[0].strip().upper()
    secondary = parts[1].strip().upper() if len(parts) > 1 else ""
    return primary, secondary, had_trailing


def parse_oracle_date(raw: str) -> Optional[date]:
    """Parse Oracle DD-MON-YY (`"12-MAR-26"`) into `date(2026, 3, 12)`.

    Returns `None` for empty / unparsable inputs."""
    if not raw:
        return None
    s = raw.strip().upper()
    m = re.match(r"^(\d{1,2})-([A-Z]{3})-(\d{2}|\d{4})$", s)
    if not m:
        return None
    day = int(m.group(1))
    mon_name = m.group(2)
    yr_raw = m.group(3)
    month = _MONTH_TO_NUM.get(mon_name)
    if not month:
        return None
    if len(yr_raw) == 2:
        yr_int = int(yr_raw)
        # Oracle's default sliding window: 50+ → 19xx; 0-49 → 20xx.
        # GCSS-MC live export uses the same convention.
        year = 2000 + yr_int if yr_int < 70 else 1900 + yr_int
    else:
        year = int(yr_raw)
    try:
        return date(year, month, day)
    except ValueError:
        return None


def normalize_priority(raw: str) -> str:
    """Pass through `NN B-Label` strings; trim whitespace."""
    return (raw or "").strip()


def normalize_echelon(raw: str) -> Optional[int]:
    s = (raw or "").strip()
    if not s:
        return None
    try:
        v = int(s)
    except ValueError:
        return None
    return v if 1 <= v <= 4 else None


def classify_uic_source(raw: str) -> Tuple[str, str]:
    """Returns `(value_to_keep, source_label)`. The real export ships
    pre-hashed UIC strings — we keep them verbatim and label the source."""
    s = (raw or "").strip()
    if not s:
        return "", "missing"
    # Oracle-style null sentinels appear in the real export (literal "null",
    # "NULL", "(null)", "N/A"). Treat as missing, not as a clear UIC.
    if s.lower() in {"null", "(null)", "n/a", "na", "none"}:
        return "", "missing"
    if _PRE_HASHED_RE.match(s):
        return s, "pre_hashed"
    # Looks like a clear UIC (e.g. M00046). Hash it ourselves so SENTRY
    # never persists a clear UIC — defense-in-depth for accidental
    # un-sanitized inputs.
    h = hashlib.sha256(s.encode("utf-8")).hexdigest()[:20]
    return f"OWNER_UNIT_{h}", "self_hashed"


# ---------------------------------------------------------------------------
# Row-level parser
# ---------------------------------------------------------------------------

def parse_header_row(raw_row: Dict[str, str]) -> ParsedSrHeader:
    """Parse a single CSV row dict into a `ParsedSrHeader`."""
    out = ParsedSrHeader()
    sr_value, sr_source = classify_sr_number(raw_row.get("SR_NUMBER", ""))
    out.sr_number = sr_value
    out.sensitive_field_sources["sr_number"] = sr_source

    serial_value, serial_source = classify_serial_number(raw_row.get("SERIAL_NUMBER", ""))
    out.serial_number = serial_value
    out.sensitive_field_sources["serial_number"] = serial_source

    tamcn_value, tamcn_source = classify_tamcn(raw_row.get("TAMCN", ""))
    out.tamcn = tamcn_value
    out.sensitive_field_sources["tamcn"] = tamcn_source

    out.service_request_type = (raw_row.get("SERVICE_REQUEST_TYPE", "") or "").strip()
    out.problem_summary = (raw_row.get("PROBLEM_SUMMARY", "") or "").strip()
    out.priority = normalize_priority(raw_row.get("MASTER_PRIORITY_CODE", ""))

    raw_defect = (raw_row.get("DEFECT_CODE", "") or "").strip()
    out.defect_code_raw = raw_defect
    primary, secondary, had_trailing = normalize_defect_code(raw_defect)
    out.defect_code_primary = primary
    out.defect_code_secondary = secondary
    if had_trailing:
        out._warnings.append("defect_code_trailing_period_normalized")

    out.open_date = parse_oracle_date(raw_row.get("DATE_RECEIVED_IN_SHOP", ""))
    if out.open_date is None and (raw_row.get("DATE_RECEIVED_IN_SHOP") or "").strip():
        out._warnings.append("open_date_unparsable")

    out.deadlined_date = parse_oracle_date(raw_row.get("DEADLINED_DATE", ""))
    if out.deadlined_date is None and (raw_row.get("DEADLINED_DATE") or "").strip():
        out._warnings.append("deadlined_date_unparsable")

    out.job_status_date = parse_oracle_date(raw_row.get("JOB_STATUS_DATE", ""))
    if out.job_status_date is None and (raw_row.get("JOB_STATUS_DATE") or "").strip():
        out._warnings.append("job_status_date_unparsable")

    out.echelon_numeric = normalize_echelon(raw_row.get("ECHELON_OF_MAINT", ""))
    if out.echelon_numeric is None and (raw_row.get("ECHELON_OF_MAINT") or "").strip():
        out._warnings.append("echelon_unparsable")

    uic_value, uic_source = classify_uic_source(raw_row.get("OWNER_UNIT_ADDRESS_CODE", ""))
    out.unit_uic_hashed = uic_value
    out.unit_uic_source = uic_source
    out.sensitive_field_sources["owner_unit_address_code"] = uic_source

    return out


# ---------------------------------------------------------------------------
# CSV-level driver
# ---------------------------------------------------------------------------

def ingest_sr_header_csv(
    source: IO[str] | str | Path,
    *,
    cm_only: bool = True,
) -> IngestReport:
    """Ingest a real-format GCSS-MC SR header CSV from a file path, an
    open text stream, or a raw CSV string (auto-detected on type).

    `cm_only=True` filters down to `Maintenance - CM` rows (matches the
    posture SPIRE was built around)."""
    if isinstance(source, (str, Path)):
        s = str(source)
        if "\n" in s or "," in s and not Path(s).exists():
            stream = io.StringIO(s)
        else:
            stream = open(s, "r", encoding="utf-8-sig", newline="")
    else:
        stream = source

    report = IngestReport()
    try:
        reader = csv.DictReader(stream)
        if reader.fieldnames:
            missing = [c for c in EXPECTED_HEADER_COLUMNS if c not in reader.fieldnames]
            if missing:
                report.schema_warnings.append(
                    f"missing_columns: {','.join(missing)}"
                )
            extra = [c for c in reader.fieldnames if c not in EXPECTED_HEADER_COLUMNS]
            if extra:
                report.schema_warnings.append(
                    f"extra_columns: {','.join(extra)}"
                )
        for raw in reader:
            report.rows_total += 1
            srt = (raw.get("SERVICE_REQUEST_TYPE", "") or "").strip()
            if cm_only and srt and "CM" not in srt.upper():
                report.rows_filtered_pmcs += 1
                continue
            parsed = parse_header_row(raw)
            if "defect_code_trailing_period_normalized" in parsed._warnings:
                report.defect_code_trailing_period_normalized += 1
            for w in parsed._warnings:
                if w.endswith("_unparsable") and "date" in w:
                    report.date_parse_failures += 1
            if parsed._warnings:
                report.rows_with_warnings += 1
            for field_name, src in parsed.sensitive_field_sources.items():
                if src == "self_hashed":
                    report.unsanitized_field_counts[field_name] = (
                        report.unsanitized_field_counts.get(field_name, 0) + 1
                    )
            report.rows_kept += 1
            report.rows.append(parsed)
    finally:
        if isinstance(source, (str, Path)) and stream is not source:
            try:
                stream.close()
            except Exception:
                pass
    return report


# ---------------------------------------------------------------------------
# Convenience: report → JSON-serializable dict
# ---------------------------------------------------------------------------

def report_to_dict(r: IngestReport, *, include_rows: bool = False) -> Dict[str, Any]:
    """JSONable summary, suitable for the SENTRY review-queue endpoint."""
    out: Dict[str, Any] = {
        "rows_total": r.rows_total,
        "rows_kept": r.rows_kept,
        "rows_filtered_pmcs": r.rows_filtered_pmcs,
        "rows_with_warnings": r.rows_with_warnings,
        "defect_code_trailing_period_normalized": r.defect_code_trailing_period_normalized,
        "date_parse_failures": r.date_parse_failures,
        "unsanitized_field_counts": dict(r.unsanitized_field_counts),
        "schema_warnings": list(r.schema_warnings),
    }
    if include_rows:
        out["rows"] = [
            {
                "sr_number": p.sr_number,
                "service_request_type": p.service_request_type,
                "defect_code_primary": p.defect_code_primary,
                "defect_code_secondary": p.defect_code_secondary,
                "defect_code_raw": p.defect_code_raw,
                "problem_summary": p.problem_summary,
                "open_date": p.open_date.isoformat() if p.open_date else None,
                "echelon_numeric": p.echelon_numeric,
                "serial_number": p.serial_number,
                "tamcn": p.tamcn,
                "deadlined_date": p.deadlined_date.isoformat() if p.deadlined_date else None,
                "priority": p.priority,
                "unit_uic_hashed": p.unit_uic_hashed,
                "unit_uic_source": p.unit_uic_source,
                "job_status_date": p.job_status_date.isoformat() if p.job_status_date else None,
                "warnings": list(p._warnings),
            }
            for p in r.rows
        ]
    return out


__all__ = [
    "EXPECTED_HEADER_COLUMNS",
    "ParsedSrHeader",
    "IngestReport",
    "normalize_defect_code",
    "parse_oracle_date",
    "normalize_priority",
    "normalize_echelon",
    "classify_uic_source",
    "classify_sr_number",
    "classify_serial_number",
    "classify_tamcn",
    "parse_header_row",
    "ingest_sr_header_csv",
    "report_to_dict",
]
