"""Profile the synthetic SPIRE dataset and emit gcss_synth_profile.json.

Mirror of `profile_gcss_real.py` so synthetic vs. real distributions can be
compared field-by-field. Runs the in-memory dataset pipeline (quick mode) and
aggregates over the produced ServiceRequest / PartRequisition records.

Usage:
    python -m dataset.scripts.profile_gcss_synth
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, median
from typing import Any, Dict, Iterable, List, Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_PATH = REPO_ROOT / "dataset" / "data" / "gcss_synth_profile.json"


def _is_null(value: Optional[str]) -> bool:
    return value is None or (isinstance(value, str) and value.strip() == "")


def _enum_profile(values: Iterable[str], top_n: int = 25) -> Dict[str, Any]:
    counts: Counter = Counter()
    null_count = 0
    total = 0
    for v in values:
        total += 1
        if _is_null(v):
            null_count += 1
            continue
        counts[v.strip() if isinstance(v, str) else v] += 1
    non_null = total - null_count
    top = counts.most_common(top_n)
    top_table = [
        {"value": v, "count": c, "pct": round(100 * c / non_null, 4) if non_null else 0.0}
        for v, c in top
    ]
    other = non_null - sum(c for _, c in top)
    return {
        "total_rows": total,
        "null_count": null_count,
        "null_pct": round(100 * null_count / total, 4) if total else 0.0,
        "unique_count": len(counts),
        "top_n": top_n,
        "top_values": top_table,
        "other_pct": round(100 * other / non_null, 4) if non_null else 0.0,
    }


def _numeric_profile(values: Iterable[float]) -> Dict[str, Any]:
    nums: List[float] = []
    null_count = 0
    total = 0
    for v in values:
        total += 1
        if v is None:
            null_count += 1
            continue
        try:
            nums.append(float(v))
        except (TypeError, ValueError):
            null_count += 1
    if not nums:
        return {"total_rows": total, "null_count": null_count,
                "null_pct": 0.0, "min": None, "max": None,
                "mean": None, "median": None}
    return {
        "total_rows": total,
        "null_count": null_count,
        "null_pct": round(100 * null_count / total, 4) if total else 0.0,
        "min": min(nums),
        "max": max(nums),
        "mean": round(mean(nums), 4),
        "median": round(median(nums), 4),
    }


def _delta_days_profile(start_vals: Iterable, end_vals: Iterable) -> Dict[str, Any]:
    deltas: List[int] = []
    paired = 0
    for s, e in zip(start_vals, end_vals):
        if s is None or e is None:
            continue
        paired += 1
        deltas.append((e - s).days)
    if not deltas:
        return {"paired_rows": 0, "min": None, "max": None, "mean": None,
                "median": None, "p25": None, "p75": None, "p90": None}
    s = sorted(deltas)
    n = len(s)

    def pct(p: float) -> int:
        idx = max(0, min(n - 1, int(round(p * (n - 1)))))
        return s[idx]

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


def _build_dataset() -> Dict[str, Any]:
    """Run the in-memory pipeline and return the produced records."""
    sys.path.insert(0, str(REPO_ROOT / "dataset"))
    from config import RANDOM_SEED  # type: ignore
    from fleet import generate_fleet  # type: ignore
    from personnel import generate_personnel  # type: ignore
    from lifecycle import run_simulation  # type: ignore
    from config import OUTPUT_TARGETS  # type: ignore

    seed = RANDOM_SEED
    units, assets = generate_fleet(seed)
    roster = generate_personnel(units, OUTPUT_TARGETS["personnel_count"], seed)
    srs, snaps, reqs = run_simulation(units, assets, roster, seed)
    return {"srs": srs, "reqs": reqs, "assets": assets}


def _defect_code_full(sr) -> str:
    a = (sr.defect_code_primary or "").strip()
    b = (sr.defect_code_secondary or "").strip()
    if not a and not b:
        return ""
    if not b:
        return a
    return f"{a}.{b}"


def profile_header(srs) -> Dict[str, Any]:
    defect_codes = [_defect_code_full(s) for s in srs]
    return {
        "row_count": len(srs),
        "sr_number_unique": len({s.sr_number for s in srs}),
        "fields": {
            "SERVICE_REQUEST_TYPE": _enum_profile(
                [getattr(s, "service_request_type", "") for s in srs]
            ),
            "DEFECT_CODE": _enum_profile(defect_codes, top_n=50),
            "ECHELON_OF_MAINT": _enum_profile(
                [str(getattr(s, "echelon_numeric", "") or "") for s in srs], top_n=10
            ),
            "ECHELON_LABEL": _enum_profile(
                [str(s.maintenance_level or "") for s in srs], top_n=10
            ),
            "MASTER_PRIORITY_CODE": _enum_profile(
                [str(s.priority or "") for s in srs], top_n=20
            ),
            "DATE_RECEIVED_IN_SHOP": {
                "min": min((s.open_date for s in srs), default=None).isoformat() if srs else None,
                "max": max((s.open_date for s in srs), default=None).isoformat() if srs else None,
            },
            "DEADLINED_minus_RECEIVED_days": _delta_days_profile(
                [s.open_date for s in srs],
                [getattr(s, "deadlined_date", None) for s in srs],
            ),
        },
        "dirty_signals": {
            "defect_code_trailing_period_count": sum(
                1 for v in defect_codes if v.endswith(".")
            ),
        },
    }


def profile_parts(reqs) -> Dict[str, Any]:
    return {
        "row_count": len(reqs),
        "fields": {
            "SERVICE_ACTIVITY": _enum_profile(
                [getattr(r, "service_activity", "") for r in reqs], top_n=10
            ),
            "ITEM_TYPE": _enum_profile(
                [getattr(r, "item_type", "") for r in reqs], top_n=10
            ),
            "QUANTITY_REQUIRED": _numeric_profile(
                [getattr(r, "qty_ordered", None) for r in reqs]
            ),
            "PARTS_CHARGE": _numeric_profile(
                [getattr(r, "total_cost", None) for r in reqs]
            ),
        },
    }


def profile_due_in(reqs) -> Dict[str, Any]:
    return {
        "row_count": len(reqs),
        "fields": {
            "DIC": _enum_profile(
                [getattr(r, "dic", "") for r in reqs], top_n=10
            ),
            "PRI_CD": _enum_profile(
                [str(getattr(r, "priority", "") or "") for r in reqs], top_n=10
            ),
            "ITEM_TYPE": _enum_profile(
                [getattr(r, "item_type", "") for r in reqs], top_n=10
            ),
            "DOC_STATUS": _enum_profile(
                [getattr(r, "doc_status", "") for r in reqs], top_n=10
            ),
        },
    }


def main() -> int:
    sys.stdout.write("Building synthetic dataset (quick mode) ...\n")
    ds = _build_dataset()
    all_srs = ds["srs"]
    reqs = ds["reqs"]
    # Real GCSS-MC export only contains corrective-maintenance SRs (no PMCS).
    # Filter to CM-only so synth and real are comparable.
    srs = [s for s in all_srs if not getattr(s, "is_pmcs", False)]
    sys.stdout.write(
        f"  {len(all_srs):,} total SRs ({len(srs):,} CM after PMCS filter), "
        f"{len(reqs):,} requisitions\n"
    )
    profile = {
        "_meta": {
            "source": "SPIRE synthetic dataset (in-memory quick run)",
            "generated_at": datetime.now(timezone.utc).replace(tzinfo=None).isoformat() + "Z",
            "sr_count": len(srs),
            "req_count": len(reqs),
        },
        "header": profile_header(srs),
        "parts": profile_parts(reqs),
        "due_in": profile_due_in(reqs),
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(profile, f, indent=2, sort_keys=False, default=str)
    sys.stdout.write(f"Wrote profile to {OUT_PATH}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
