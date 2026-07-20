"""Profile the real (sanitized) GCSS-MC export.

Reads tmp/gcss-mc/{hashed_header,hashed_sr_parts,hashed_due_in}.csv and writes
ground-truth aggregate distributions (counts, percentages, top-N value tables,
date format, lead-time deltas) to dataset/data/gcss_real_profile.json.

The aggregates contain only counts and percentages, no row-level PII. They
are committed to the repository and serve as ground truth for the synthetic
dataset realignment work (WP-1 through WP-4).

Usage:
    python -m dataset.scripts.profile_gcss_real
"""
from __future__ import annotations

import csv
import json
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from statistics import mean, median
from typing import Any, Dict, Iterable, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = REPO_ROOT / "tmp" / "gcss-mc"
OUT_PATH = REPO_ROOT / "dataset" / "data" / "gcss_real_profile.json"

HEADER_CSV = RAW_DIR / "hashed_header.csv"
PARTS_CSV = RAW_DIR / "hashed_sr_parts.csv"
DUE_IN_CSV = RAW_DIR / "hashed_due_in.csv"


def _is_null(value: Optional[str]) -> bool:
    return value is None or value.strip() == ""


def _parse_oracle_date(value: str) -> Optional[datetime]:
    """Parse Oracle-style 'DD-MON-YY' (e.g. '27-JAN-24'). Returns None on fail."""
    if _is_null(value):
        return None
    v = value.strip()
    for fmt in ("%d-%b-%y", "%d-%b-%Y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return datetime.strptime(v, fmt)
        except ValueError:
            continue
    return None


def _enum_profile(values: Iterable[str], top_n: int = 25) -> Dict[str, Any]:
    counts: Counter = Counter()
    null_count = 0
    total = 0
    for v in values:
        total += 1
        if _is_null(v):
            null_count += 1
            continue
        counts[v.strip()] += 1
    non_null = total - null_count
    top = counts.most_common(top_n)
    top_table = [
        {"value": v, "count": c, "pct": round(100 * c / non_null, 4) if non_null else 0.0}
        for v, c in top
    ]
    other_count = non_null - sum(c for _, c in top)
    return {
        "total_rows": total,
        "null_count": null_count,
        "null_pct": round(100 * null_count / total, 4) if total else 0.0,
        "unique_count": len(counts),
        "top_n": top_n,
        "top_values": top_table,
        "other_pct": round(100 * other_count / non_null, 4) if non_null else 0.0,
    }


def _numeric_profile(values: Iterable[str]) -> Dict[str, Any]:
    nums: List[float] = []
    null_count = 0
    total = 0
    for v in values:
        total += 1
        if _is_null(v):
            null_count += 1
            continue
        try:
            nums.append(float(v.strip()))
        except (TypeError, ValueError):
            null_count += 1
    if not nums:
        return {
            "total_rows": total,
            "null_count": null_count,
            "null_pct": round(100 * null_count / total, 4) if total else 0.0,
            "min": None,
            "max": None,
            "mean": None,
            "median": None,
        }
    return {
        "total_rows": total,
        "null_count": null_count,
        "null_pct": round(100 * null_count / total, 4) if total else 0.0,
        "min": min(nums),
        "max": max(nums),
        "mean": round(mean(nums), 4),
        "median": round(median(nums), 4),
    }


def _date_profile(values: Iterable[str]) -> Dict[str, Any]:
    parsed: List[datetime] = []
    raw_samples: List[str] = []
    null_count = 0
    total = 0
    formats_seen: Counter = Counter()
    for v in values:
        total += 1
        if _is_null(v):
            null_count += 1
            continue
        if len(raw_samples) < 5:
            raw_samples.append(v.strip())
        d = _parse_oracle_date(v)
        if d is None:
            null_count += 1
            continue
        parsed.append(d)
        v_strip = v.strip()
        if len(v_strip) == 9 and v_strip[2] == "-" and v_strip[6] == "-":
            formats_seen["DD-MON-YY"] += 1
        elif len(v_strip) == 10 and v_strip[4] == "-":
            formats_seen["YYYY-MM-DD"] += 1
        else:
            formats_seen["other"] += 1
    if not parsed:
        return {
            "total_rows": total,
            "null_count": null_count,
            "null_pct": round(100 * null_count / total, 4) if total else 0.0,
            "min": None,
            "max": None,
            "format_seen": dict(formats_seen),
            "samples": raw_samples,
        }
    return {
        "total_rows": total,
        "null_count": null_count,
        "null_pct": round(100 * null_count / total, 4) if total else 0.0,
        "min": min(parsed).strftime("%Y-%m-%d"),
        "max": max(parsed).strftime("%Y-%m-%d"),
        "format_seen": dict(formats_seen),
        "samples": raw_samples,
    }


def _delta_days_profile(start_vals: Iterable[str], end_vals: Iterable[str]) -> Dict[str, Any]:
    deltas: List[int] = []
    paired = 0
    for s, e in zip(start_vals, end_vals):
        sd = _parse_oracle_date(s)
        ed = _parse_oracle_date(e)
        if sd and ed:
            paired += 1
            deltas.append((ed - sd).days)
    if not deltas:
        return {"paired_rows": 0, "min": None, "max": None, "mean": None, "median": None,
                "p25": None, "p75": None, "p90": None}
    deltas_sorted = sorted(deltas)
    n = len(deltas_sorted)

    def pct(p: float) -> int:
        idx = max(0, min(n - 1, int(round(p * (n - 1)))))
        return deltas_sorted[idx]

    return {
        "paired_rows": paired,
        "min": min(deltas),
        "max": max(deltas),
        "mean": round(mean(deltas), 2),
        "median": median(deltas),
        "p25": pct(0.25),
        "p75": pct(0.75),
        "p90": pct(0.90),
    }


def _read_column(path: Path, column: str) -> List[str]:
    out: List[str] = []
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            out.append(row.get(column, ""))
    return out


def _read_columns(path: Path, columns: List[str]) -> Dict[str, List[str]]:
    cols: Dict[str, List[str]] = {c: [] for c in columns}
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            for c in columns:
                cols[c].append(row.get(c, ""))
    return cols


def profile_header() -> Dict[str, Any]:
    needed = [
        "SERVICE_REQUEST_TYPE",
        "SR_NUMBER",
        "DEFECT_CODE",
        "DATE_RECEIVED_IN_SHOP",
        "ECHELON_OF_MAINT",
        "SERIAL_NUMBER",
        "TAMCN",
        "DEADLINED_DATE",
        "MASTER_PRIORITY_CODE",
        "OWNER_UNIT_ADDRESS_CODE",
        "JOB_STATUS_DATE",
    ]
    cols = _read_columns(HEADER_CSV, needed)
    total = len(cols["SR_NUMBER"])
    sr_unique = len({s for s in cols["SR_NUMBER"] if not _is_null(s)})
    return {
        "row_count": total,
        "sr_number_unique": sr_unique,
        "sr_number_unique_pct": round(100 * sr_unique / total, 4) if total else 0.0,
        "fields": {
            "SERVICE_REQUEST_TYPE": _enum_profile(cols["SERVICE_REQUEST_TYPE"]),
            "DEFECT_CODE": _enum_profile(cols["DEFECT_CODE"], top_n=50),
            "ECHELON_OF_MAINT": _enum_profile(cols["ECHELON_OF_MAINT"], top_n=10),
            "MASTER_PRIORITY_CODE": _enum_profile(cols["MASTER_PRIORITY_CODE"], top_n=20),
            "TAMCN": _enum_profile(cols["TAMCN"], top_n=25),
            "OWNER_UNIT_ADDRESS_CODE": _enum_profile(cols["OWNER_UNIT_ADDRESS_CODE"], top_n=25),
            "DATE_RECEIVED_IN_SHOP": _date_profile(cols["DATE_RECEIVED_IN_SHOP"]),
            "DEADLINED_DATE": _date_profile(cols["DEADLINED_DATE"]),
            "JOB_STATUS_DATE": _date_profile(cols["JOB_STATUS_DATE"]),
            "JOB_STATUS_minus_RECEIVED_days": _delta_days_profile(
                cols["DATE_RECEIVED_IN_SHOP"], cols["JOB_STATUS_DATE"]
            ),
            "DEADLINED_minus_RECEIVED_days": _delta_days_profile(
                cols["DATE_RECEIVED_IN_SHOP"], cols["DEADLINED_DATE"]
            ),
        },
        "dirty_signals": {
            "defect_code_trailing_period_count": sum(
                1 for v in cols["DEFECT_CODE"] if not _is_null(v) and v.strip().endswith(".")
            ),
        },
    }


def profile_parts() -> Dict[str, Any]:
    needed = ["SR_NUMBER", "SERVICE_ACTIVITY", "RNSN", "QUANTITY_REQUIRED",
              "PARTS_CHARGE", "DOCUMENT_NUMBER"]
    cols = _read_columns(PARTS_CSV, needed)
    total = len(cols["SR_NUMBER"])
    return {
        "row_count": total,
        "fields": {
            "SERVICE_ACTIVITY": _enum_profile(cols["SERVICE_ACTIVITY"], top_n=10),
            "QUANTITY_REQUIRED": _numeric_profile(cols["QUANTITY_REQUIRED"]),
            "PARTS_CHARGE": _numeric_profile(cols["PARTS_CHARGE"]),
            "DOCUMENT_NUMBER_null_pct": round(
                100 * sum(1 for v in cols["DOCUMENT_NUMBER"] if _is_null(v)) / total, 4
            ) if total else 0.0,
            "RNSN_unique_count": len({v for v in cols["RNSN"] if not _is_null(v)}),
        },
    }


def profile_due_in() -> Dict[str, Any]:
    needed = [
        "DIC", "PRI_CD", "ITEM_TYPE", "DOC_STATUS", "RULE_ASSIGNED",
        "SUPP_ADD", "ESTABLISHED_DT", "MAX_STAT_DT", "SOS", "RCVR_CD",
        "REMAIN_DUE_RULE", "ADVICE_CODE",
    ]
    cols = _read_columns(DUE_IN_CSV, needed)
    total = len(cols["DIC"])
    remain_nonzero = 0
    for v in cols["REMAIN_DUE_RULE"]:
        if _is_null(v):
            continue
        try:
            if float(v.strip()) != 0:
                remain_nonzero += 1
        except (TypeError, ValueError):
            pass
    return {
        "row_count": total,
        "fields": {
            "DIC": _enum_profile(cols["DIC"], top_n=10),
            "PRI_CD": _enum_profile(cols["PRI_CD"], top_n=10),
            "ITEM_TYPE": _enum_profile(cols["ITEM_TYPE"], top_n=10),
            "DOC_STATUS": _enum_profile(cols["DOC_STATUS"], top_n=10),
            "RULE_ASSIGNED": _enum_profile(cols["RULE_ASSIGNED"], top_n=15),
            "SUPP_ADD": _enum_profile(cols["SUPP_ADD"], top_n=25),
            "SOS": _enum_profile(cols["SOS"], top_n=10),
            "RCVR_CD": _enum_profile(cols["RCVR_CD"], top_n=10),
            "ADVICE_CODE": _enum_profile(cols["ADVICE_CODE"], top_n=10),
            "ESTABLISHED_DT": _date_profile(cols["ESTABLISHED_DT"]),
            "MAX_STAT_DT": _date_profile(cols["MAX_STAT_DT"]),
            "ESTABLISHED_to_MAX_STAT_days": _delta_days_profile(
                cols["ESTABLISHED_DT"], cols["MAX_STAT_DT"]
            ),
            "REMAIN_DUE_nonzero_pct": round(100 * remain_nonzero / total, 4) if total else 0.0,
        },
    }


def main() -> int:
    if not RAW_DIR.exists():
        sys.stderr.write(
            f"ERROR: Raw GCSS-MC export not found at {RAW_DIR}. "
            "Stage the sanitized CSVs there before profiling.\n"
        )
        return 1
    profile = {
        "_meta": {
            "source": "GCSS-MC sanitized export (hashed PII)",
            "generated_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
            "files": {
                "header": HEADER_CSV.name,
                "parts": PARTS_CSV.name,
                "due_in": DUE_IN_CSV.name,
            },
        },
        "header": profile_header(),
        "parts": profile_parts(),
        "due_in": profile_due_in(),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(profile, f, indent=2, sort_keys=False)
    sys.stdout.write(f"Wrote profile to {OUT_PATH}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
