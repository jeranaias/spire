"""Date and datetime parsers.

Real-world exports use four common date dialects:

  * Oracle DD-MON-YY      e.g. "12-MAR-26"     (sliding window for 2-digit years)
  * ISO 8601 date         e.g. "2026-03-12"
  * ISO 8601 datetime     e.g. "2026-03-12T07:14:23Z"
  * Excel serial          e.g. "45728"          (days since 1900-01-01, with leap-year quirk)

Each parser tolerates leading/trailing whitespace, returns None on
parse failure (caller bumps a per-row warning), and never raises.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional


_MONTH_TO_NUM = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}

_NULL_SENTINELS = frozenset({"", "null", "(null)", "n/a", "na", "none"})


def _is_null(s: str) -> bool:
    return s.strip().lower() in _NULL_SENTINELS


def parse_date_oracle(raw: str) -> Optional[date]:
    """Parse Oracle DD-MON-YY (or DD-MON-YYYY)."""
    if raw is None:
        return None
    s = raw.strip()
    if _is_null(s):
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
        # Oracle's default sliding window: 20-69 → 2020s/30s/…/60s,
        # 70-99 → 1970s/80s/90s.
        yr = 2000 + yr if yr < 70 else 1900 + yr
    try:
        return date(yr, mon, day)
    except ValueError:
        return None


def parse_date(raw: str) -> Optional[date]:
    """Parse ISO 8601 date `YYYY-MM-DD` or `YYYY/MM/DD` or `MM/DD/YYYY`."""
    if raw is None:
        return None
    s = raw.strip()
    if _is_null(s):
        return None
    # Try strict ISO first
    m = re.match(r"^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$", s)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    # MM/DD/YYYY (US). Only slash separator — dashes in non-ISO
    # positions are ambiguous between US and European conventions and
    # we'd rather return None than guess wrong on a date that drives
    # readiness math.
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", s)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(1)), int(m.group(2)))
        except ValueError:
            return None
    return None


def parse_datetime(raw: str) -> Optional[datetime]:
    """Parse ISO 8601 datetime, optionally with timezone."""
    if raw is None:
        return None
    s = raw.strip()
    if _is_null(s):
        return None
    # Normalize trailing Z to +00:00 so fromisoformat accepts it.
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


# Excel serial-date arithmetic. Excel treats 1900 as a leap year (it
# isn't), so dates after 1900-02-28 are off by one. Standard fix is
# to anchor at 1899-12-30 and add days.
_EXCEL_EPOCH = date(1899, 12, 30)


def parse_date_excel(raw: str) -> Optional[date]:
    """Parse an Excel serial date (numeric days since the Excel
    epoch)."""
    if raw is None:
        return None
    s = raw.strip()
    if _is_null(s):
        return None
    try:
        n = float(s)
    except ValueError:
        return None
    try:
        return _EXCEL_EPOCH + timedelta(days=int(n))
    except (OverflowError, ValueError):
        return None
