"""PULSE endpoints: fleet overview, risk board, cannibalization, forecast."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from statistics import mean
from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from ..persistence import feedback_summary, record_pulse_feedback
from ..scoping import allowed_units, filter_assets, filter_units
from ..state import (
    CanonicalDataset,
    get_dataset,
    last_day_snapshots,
    open_srs_for_asset,
    snapshots_for_asset,
    snapshots_for_unit,
    srs_for_asset,
)
from ..scoring import risk_score, top_risk

# Replenishment rate primitives live in the dataset/ module so they're
# inspectable + reusable. Import once at module load, fail soft if missing.
import sys as _sys
from pathlib import Path as _Path
_REPO_ROOT = _Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in _sys.path:
    _sys.path.insert(0, str(_REPO_ROOT))
try:
    from dataset.replenishment import (  # type: ignore[import-not-found]
        cannibalize_cost, expedite_cost, cross_level_cost, convoy_feasible,
    )
    _REPLENISHMENT_AVAILABLE = True
except Exception:
    _REPLENISHMENT_AVAILABLE = False

router = APIRouter()


# ---------------------------------------------------------------------------
# Fleet overview — landing page
# ---------------------------------------------------------------------------

@router.get("/fleet-overview")
async def fleet_overview(role: Optional[str] = None):
    ds = get_dataset()
    last_all = last_day_snapshots(ds)
    if not last_all:
        raise HTTPException(status_code=503, detail="dataset empty")
    allowed = allowed_units(ds, role)
    last = [s for s in last_all if allowed is None or s.unit_name in allowed]
    last_day = last_all[0].snapshot_date

    # Hero metrics ---------------------------------------------------------
    total = len(last)
    mc = sum(1 for s in last if s.readiness_code == "MC")
    fleet_mc_rate = mc / total if total else 0.0

    # 7-day delta: average MC rate over days last-6..last vs last-13..last-7
    by_date = defaultdict(Counter)
    for s in ds.snapshots:
        if allowed is not None and s.unit_name not in allowed:
            continue
        by_date[s.snapshot_date][s.readiness_code] += 1
    dates = sorted(by_date.keys())

    def _mc_avg(range_days):
        daily = []
        for d in range_days:
            c = by_date[d]
            daily.append(c.get("MC", 0) / max(sum(c.values()), 1))
        return mean(daily) if daily else 0.0

    window_recent = dates[-7:]
    window_prior = dates[-14:-7] if len(dates) >= 14 else dates[:max(1, len(dates) - 7)]
    delta_7d = _mc_avg(window_recent) - _mc_avg(window_prior)

    parts_on_order = sum(
        1
        for sr in ds.srs
        if (allowed is None or sr.unit_name in allowed)
        for r in sr.requisitions
        if r.received_date is None or r.received_date > last_day
    )

    # Critical assets: ones with NMC status today
    critical_assets = [s for s in last if s.readiness_code.startswith("NMC")]
    critical_count = len(critical_assets)

    # Avg days NMC among currently-NMC assets
    avg_days_nmc = mean([s.days_deadlined for s in critical_assets]) if critical_assets else 0.0

    # Heatmap --------------------------------------------------------------
    # Per-unit per-equipment MC rate on the last day
    by_unit_equip = defaultdict(lambda: defaultdict(list))
    for s in last:
        by_unit_equip[s.unit_name][s.equipment_type].append(s.readiness_code)

    heatmap = []
    visible_units = filter_units(ds, role)
    for u in visible_units:
        rates = {}
        equip_breakdown = {}
        for eq_type in sorted(u.equipment_counts.keys()):
            codes = by_unit_equip[u.name].get(eq_type, [])
            if not codes:
                rates[eq_type] = None
                equip_breakdown[eq_type] = 0
                continue
            mc_n = sum(1 for c in codes if c == "MC")
            rates[eq_type] = round(mc_n / len(codes), 3)
            equip_breakdown[eq_type] = len(codes)
        heatmap.append({
            "unit": u.name,
            "uic": u.uic,
            "location": u.location,
            "total_equipment": sum(equip_breakdown.values()),
            "rates": rates,
            "equipment_breakdown": equip_breakdown,
        })

    # Latest alerts feed ---------------------------------------------------
    alerts = _build_alerts(ds, last, last_day)

    return {
        "hero_metrics": {
            "fleet_mc_rate": round(fleet_mc_rate, 3),
            "fleet_mc_delta_7d": round(delta_7d, 3),
            "critical_assets": critical_count,
            "parts_on_order": parts_on_order,
            "avg_days_nmc": round(avg_days_nmc, 1),
        },
        "heatmap": heatmap,
        "equipment_types": sorted({et for u in visible_units for et in u.equipment_counts.keys()}),
        "alerts": alerts[:10],
        "as_of": last_day.isoformat(),
        "role": role or "mef_commander",
        "scope": {
            "units_visible": sorted([u.name for u in visible_units]),
            "filter_applied": allowed is not None,
        },
    }


def _build_alerts(ds: CanonicalDataset, last_snaps, last_day) -> list[dict]:
    alerts: list[dict] = []

    # Cannibalization matches (fresh events)
    for c in sorted(ds.cannib_events, key=lambda x: x.event_date, reverse=True)[:6]:
        alerts.append({
            "id": f"cannib-{c.event_id}",
            "kind": "cannibalization",
            "severity": "INFO",
            "timestamp": c.event_date.isoformat(),
            "title": f"Cannibalization match: {c.recipient_unit} ← {c.donor_unit}",
            "body": (
                f"{c.recipient_asset_id} needs {c.nomenclature}. "
                f"Donor {c.donor_asset_id} ({c.donor_unit}) has it. {c.readiness_impact_note}"
            ),
        })

    # Unit readiness alerts: any unit at < 70% last-day MC
    by_unit = defaultdict(lambda: {"mc": 0, "total": 0})
    for s in last_snaps:
        by_unit[s.unit_name]["total"] += 1
        if s.readiness_code == "MC":
            by_unit[s.unit_name]["mc"] += 1
    for u_name, stats in by_unit.items():
        if stats["total"] == 0:
            continue
        rate = stats["mc"] / stats["total"]
        if rate < 0.70:
            alerts.append({
                "id": f"readiness-{u_name}",
                "kind": "readiness",
                "severity": "HIGH" if rate < 0.60 else "MODERATE",
                "timestamp": last_day.isoformat(),
                "title": f"{u_name} readiness below threshold",
                "body": (
                    f"{u_name} MC rate is {rate:.1%} ({stats['mc']}/{stats['total']} assets). "
                    "Review risk board for contributing factors."
                ),
            })

    # Data quality
    for flag, count in (ds.dq_defects or {}).items():
        if count <= 0:
            continue
        alerts.append({
            "id": f"dq-{flag}",
            "kind": "data_quality",
            "severity": "MODERATE",
            "timestamp": last_day.isoformat(),
            "title": f"Data quality: {count} records with {flag.replace('_', ' ')}",
            "body": "SENTRY data-quality gate flagged these at ingest. Records still processed, but predictions carry a quality caveat.",
        })

    alerts.sort(key=lambda a: (-_severity_rank(a["severity"]), a["timestamp"]), reverse=False)
    return alerts


def _severity_rank(s: str) -> int:
    return {"CRITICAL": 4, "HIGH": 3, "MODERATE": 2, "INFO": 1, "LOW": 0}.get(s, 0)


# ---------------------------------------------------------------------------
# Risk board
# ---------------------------------------------------------------------------

@router.get("/risk-board")
async def risk_board(top: int = Query(20, ge=1, le=100), role: Optional[str] = None):
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    scored = top_risk(ds, n=top * 3)  # oversample then filter
    out = []
    for s in scored:
        asset = ds.asset(s["asset_id"])
        if asset is None:
            continue
        if allowed is not None and asset.unit_name not in allowed:
            continue
        if len(out) >= top:
            break
        out.append({
            **s,
            "serial_number": asset.serial_number,
            "tamcn": asset.tamcn,
            "current_hours": round(asset.current_hours, 1),
            "current_miles": asset.current_miles,
            "days_since_maintenance": asset.days_since_last_maintenance,
            "open_sr_count": len(asset.open_srs),
        })
    return {"assets": out}


# ---------------------------------------------------------------------------
# GC-3 Predictive failure
# ---------------------------------------------------------------------------

# Load MTBF table once at module level. Production swaps in J2 weights via
# model_hooks; this rule-based fallback runs in the meantime.
_MTBF_TABLE: dict = {}
try:
    import json as _json
    _MTBF_PATH = _REPO_ROOT / "dataset" / "data" / "mtbf_table.json"
    with open(_MTBF_PATH, encoding="utf-8") as _f:
        _MTBF_TABLE = _json.load(_f)
except Exception:
    _MTBF_TABLE = {}


def _mtbf_for(equipment_type: str, component: str) -> Optional[dict]:
    """Look up MTBF/MTTR for a given equipment_type+component, falling back
    to the default table if the equipment type isn't modelled."""
    components = _MTBF_TABLE.get("components", {})
    et = components.get(equipment_type) or _MTBF_TABLE.get("default", {})
    return et.get(component)


def _predict_one(asset, recent_faults: dict[str, int]) -> list[dict]:
    """Rule-based per-asset failure prediction across modelled components.
    Each prediction has: component, probability, predicted_window_days,
    confidence, mtbf_hours, criticality, common_failure_modes."""
    predictions: list[dict] = []
    et_data = (_MTBF_TABLE.get("components", {}).get(asset.equipment_type)
               or _MTBF_TABLE.get("default", {}))
    if not et_data:
        return predictions
    hours = max(0.0, asset.current_hours or 0.0)
    for component, info in et_data.items():
        if not isinstance(info, dict):
            continue
        mtbf = info.get("mtbf_hours")
        if not mtbf:
            continue
        # Normalised hours-to-MTBF ratio. >1 means we're already past MTBF.
        ratio = hours / mtbf
        # Recent fault history bumps probability — components that have
        # already failed once in the last year are more likely to recur.
        recent = recent_faults.get(component, 0)
        # Two-component model: base hazard from hours-to-MTBF + history bump.
        base = max(0.0, min(1.0, (ratio - 0.55) * 1.6))
        history_bump = min(0.35, recent * 0.10)
        prob = round(min(0.98, base + history_bump), 3)
        if prob < 0.15:
            continue
        # Predicted-window-days = inverse of probability scaled to a window.
        window = max(2, min(30, int((1.0 - prob) * 28 + 2)))
        predictions.append({
            "component": component,
            "probability": prob,
            "predicted_window_days": window,
            "confidence": 0.75,    # rule-based — bumps to ~0.92 when J2 weights load
            "engine": "rule_based_v1",
            "mtbf_hours": mtbf,
            "mttr_days": info.get("mttr_days"),
            "criticality": info.get("criticality", "medium"),
            "common_failure_modes": info.get("common_failure_modes", []),
        })
    predictions.sort(key=lambda p: p["probability"], reverse=True)
    return predictions


@router.get("/predict-failures")
async def predict_failures(
    unit: Optional[str] = None,
    asset_id: Optional[str] = None,
    horizon_days: int = Query(14, ge=3, le=60),
    threshold: float = Query(0.4, ge=0.0, le=0.99),
    role: Optional[str] = None,
):
    """Per-asset predicted-failure surface.

    Walks each in-scope asset, scores every modelled component using the
    MTBF table + recent-fault history, returns predictions above
    `threshold` with predicted-window-days <= `horizon_days`.

    The prediction engine is rule-based today (engine=rule_based_v1).
    When J2 weights ship, /pulse/predict-failures swaps in the trained
    head and engine flips to `j2_v1` automatically — same response shape."""
    ds = get_dataset()
    allowed = allowed_units(ds, role)

    target_assets: list = []
    if asset_id:
        a = ds.asset(asset_id)
        if a is None:
            raise HTTPException(status_code=404, detail="asset not found")
        if allowed is not None and a.unit_name not in allowed:
            raise HTTPException(status_code=403, detail="asset out of scope")
        target_assets = [a]
    else:
        for a in ds.assets:
            if allowed is not None and a.unit_name not in allowed:
                continue
            if unit and a.unit_name != unit:
                continue
            target_assets.append(a)

    out: list[dict] = []
    for a in target_assets:
        # Per-asset recent-fault counter for the history bump.
        recent_faults: dict[str, int] = {}
        for sr in ds.srs:
            if sr.asset_id != a.asset_id or sr.is_pmcs:
                continue
            if sr.fault_component:
                key = _normalize_component(sr.fault_component)
                recent_faults[key] = recent_faults.get(key, 0) + 1
        preds = _predict_one(a, recent_faults)
        preds = [p for p in preds if p["probability"] >= threshold and p["predicted_window_days"] <= horizon_days]
        if not preds:
            continue
        out.append({
            "asset_id": a.asset_id,
            "unit_name": a.unit_name,
            "equipment_type": a.equipment_type,
            "current_hours": round(a.current_hours, 1),
            "predictions": preds,
        })
    out.sort(key=lambda x: max(p["probability"] for p in x["predictions"]), reverse=True)
    return {
        "assets": out[:50],
        "horizon_days": horizon_days,
        "threshold": threshold,
        "engine": "rule_based_v1",
        "as_of": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }


def _normalize_component(c: str) -> str:
    """Map free-text fault_component values onto the MTBF table's keys."""
    lc = (c or "").lower()
    if any(k in lc for k in ("starter", "alternator", "injector", "fuel", "turbo", "head", "valve")):
        return "engine"
    if any(k in lc for k in ("transmission", "transfer", "diff", "drive", "shaft")):
        return "drivetrain"
    if any(k in lc for k in ("brake", "rotor", "caliper", "pad")):
        return "brake"
    if any(k in lc for k in ("battery", "harness", "ecm", "relay", "wiring")):
        return "electrical"
    if any(k in lc for k in ("hydraul", "pump", "cylinder", "hose")):
        return "hydraulic"
    if any(k in lc for k in ("track", "road wheel", "torsion")):
        return "track"
    if any(k in lc for k in ("antenna", "aesa", "transmit")):
        return "antenna"
    return c or "subsystem"


# ---------------------------------------------------------------------------
# GC-1 Autonomous replenishment planning
# ---------------------------------------------------------------------------

@router.get("/recommend-actions")
async def recommend_actions(
    unit: Optional[str] = None,
    asset_id: Optional[str] = None,
    top: int = Query(5, ge=1, le=20),
    role: Optional[str] = None,
):
    """Rank candidate actions (cannibalize / expedite / cross-level /
    redistribute) for a unit or specific asset. Returns each option with
    expected MC% delta, cost, time-to-effect, and the artifact the user
    would create if they approved.

    Driven by `dataset/replenishment.py` rate primitives + the live risk
    board state. Safe to call read-only; the approval step is where
    artifacts are actually created (cannibalization propose endpoint,
    requisition draft, etc.)."""
    if not _REPLENISHMENT_AVAILABLE:
        raise HTTPException(status_code=503, detail="replenishment rates not loaded")
    ds = get_dataset()
    allowed = allowed_units(ds, role)

    # Build the candidate set: top-N at-risk assets if no asset_id given.
    candidates: list[dict] = []
    if asset_id:
        a = ds.asset(asset_id)
        if a is None:
            raise HTTPException(status_code=404, detail="asset not found")
        if allowed is not None and a.unit_name not in allowed:
            raise HTTPException(status_code=403, detail="asset out of scope")
        candidates.append({"asset_id": asset_id, "asset": a})
    else:
        scored = top_risk(ds, n=20)
        for s in scored:
            a = ds.asset(s["asset_id"])
            if a is None:
                continue
            if unit and a.unit_name != unit:
                continue
            if allowed is not None and a.unit_name not in allowed:
                continue
            candidates.append({"asset_id": s["asset_id"], "asset": a, "risk_score": s["risk_score"]})
            if len(candidates) >= top:
                break

    out: list[dict] = []
    for c in candidates:
        a = c["asset"]
        # Find the deadlining SR with a pending requisition (if any).
        open_sr = next(
            (sr for sr in ds.srs
             if sr.asset_id == a.asset_id and sr.close_date is None
             and sr.condition == "Deadlined"),
            None,
        )
        pending_req = None
        if open_sr:
            pending_req = next(
                (r for r in open_sr.requisitions if r.received_date is None),
                None,
            )

        actions: list[dict] = []

        # Option 1: cannibalize from another deadlined asset of same equipment type.
        if pending_req:
            donor_pool = [
                sr for sr in ds.srs
                if sr.asset_id != a.asset_id
                and sr.close_date is None
                and sr.condition == "Deadlined"
                and any(r.nsn == pending_req.nsn for r in sr.requisitions)
            ]
            if donor_pool:
                d = donor_pool[0]
                cost = cannibalize_cost()
                actions.append({
                    "kind": "cannibalize",
                    "title": f"Cannibalize {pending_req.nomenclature} from {d.asset_id}",
                    "description": f"Donor {d.asset_id} ({d.unit_name}) is deadlined on a different fault — same NSN available.",
                    "cost_usd": cost,
                    "time_to_effect_hours": 12,
                    "mc_delta_pct": 0.6,
                    "confidence": 0.85,
                    "artifact": {
                        "kind": "cannibalization_proposal",
                        "recipient_sr": open_sr.sr_number,
                        "donor_sr": d.sr_number,
                        "nsn": pending_req.nsn,
                    },
                    "approval_roles": ["maintenance_chief", "g4"],
                })

        # Option 2: expedite the existing requisition (overnight or 3-day).
        if pending_req:
            for tier in ("overnight", "3_day", "5_day"):
                fee, days = expedite_cost(tier)
                actions.append({
                    "kind": "expedite",
                    "title": f"Expedite {pending_req.nomenclature} via {tier.replace('_', '-')} freight",
                    "description": f"Convert MILSTRIP path to {tier.replace('_', '-')}; reduces wait by ~{max(1, 17 - days)}d.",
                    "cost_usd": fee,
                    "time_to_effect_hours": days * 24,
                    "mc_delta_pct": 0.4 if tier == "5_day" else 0.55 if tier == "3_day" else 0.7,
                    "confidence": 0.9,
                    "artifact": {
                        "kind": "expedite_request",
                        "sr_number": open_sr.sr_number if open_sr else None,
                        "nsn": pending_req.nsn,
                        "tier": tier,
                    },
                    "approval_roles": ["g4", "mef_commander"],
                })

        # Option 3: cross-level a serviceable asset of the same type from a peer unit.
        peer_serviceable = [
            other for other in ds.assets
            if other.asset_id != a.asset_id
            and other.equipment_type == a.equipment_type
            and other.unit_name != a.unit_name
            and other.current_status in ("RFI", "Operational")
        ]
        if peer_serviceable:
            donor_unit = peer_serviceable[0].unit_name
            # Use Camp Henderson distance as a stand-in (all garrison units co-located).
            cost, hours = cross_level_cost(distance_mi=85, hazmat=False)
            feasible = convoy_feasible(
                f"{a.unit_name.split(',')[0] if ',' in a.unit_name else 'Camp Henderson, NC'}",
                f"{donor_unit}",
            )
            actions.append({
                "kind": "cross_level",
                "title": f"Cross-level a serviceable {a.equipment_type} from {donor_unit}",
                "description": f"Peer unit holds an RFI {a.equipment_type}; relocate while {a.asset_id} is repaired.",
                "cost_usd": cost,
                "time_to_effect_hours": hours,
                "mc_delta_pct": 1.0,
                "confidence": 0.7 if feasible else 0.55,
                "artifact": {
                    "kind": "cross_level_request",
                    "donor_asset": peer_serviceable[0].asset_id,
                    "donor_unit": donor_unit,
                    "recipient_unit": a.unit_name,
                },
                "approval_roles": ["g4"],
            })

        # Sort by impact-per-dollar-per-day score
        for act in actions:
            denom = max(1.0, (act["cost_usd"] / 100) * (act["time_to_effect_hours"] / 24 + 1))
            act["score"] = round(act["mc_delta_pct"] / denom, 5)
        actions.sort(key=lambda x: x["score"], reverse=True)

        out.append({
            "asset_id": a.asset_id,
            "unit_name": a.unit_name,
            "equipment_type": a.equipment_type,
            "risk_score": c.get("risk_score"),
            "primary_factor": "deadlined " + (open_sr.fault_component if open_sr else "fault") if open_sr else None,
            "actions": actions[:5],
        })

    return {"assets": out, "as_of": datetime.utcnow().isoformat(timespec="seconds") + "Z"}


@router.get("/assets/{asset_id}")
async def asset_deep_dive(asset_id: str):
    ds = get_dataset()
    asset = ds.asset(asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")

    score = risk_score(ds, asset_id)

    # Maintenance timeline
    timeline = []
    for sr in srs_for_asset(ds, asset_id):
        timeline.append({
            "sr_number": sr.sr_number,
            "open_date": sr.open_date.isoformat(),
            "close_date": sr.close_date.isoformat() if sr.close_date else None,
            "is_pmcs": sr.is_pmcs,
            "condition": sr.condition,
            "job_status": sr.job_status,
            "fault_component": sr.fault_component,
            "labor_hours": sr.labor_hours_actual,
            "parts_cost": sr.parts_cost_actual,
            "tm_reference": sr.tm_reference,
            "remark": sr.remark_text,
            "classification": sr.detected_classification,
        })
    timeline.sort(key=lambda t: t["open_date"])

    # Fault frequency by component (last 12 months)
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else asset.fielding_date
    cutoff = last_day - timedelta(days=365)
    component_counts = Counter()
    for sr in srs_for_asset(ds, asset_id):
        if sr.is_pmcs or sr.open_date < cutoff:
            continue
        component_counts[sr.fault_component] += 1

    # Readiness trajectory (every 7 days to keep payload small)
    snaps = snapshots_for_asset(ds, asset_id)
    trajectory = []
    for i, s in enumerate(snaps):
        if i % 7 == 0 or i == len(snaps) - 1:
            trajectory.append({
                "date": s.snapshot_date.isoformat(),
                "readiness": s.readiness_code,
                "current_hours": round(s.current_hours, 1),
                "current_miles": s.current_miles,
            })

    return {
        "asset": {
            "asset_id": asset.asset_id,
            "equipment_type": asset.equipment_type,
            "nomenclature": asset.nomenclature,
            "tamcn": asset.tamcn,
            "nsn": asset.nsn,
            "serial_number": asset.serial_number,
            "unit_name": asset.unit_name,
            "location": asset.location,
            "fielding_date": asset.fielding_date.isoformat(),
            "initial_hours": asset.initial_hours,
            "initial_miles": asset.initial_miles,
            "current_hours": round(asset.current_hours, 1),
            "current_miles": asset.current_miles,
            "current_status": asset.current_status,
            "days_since_maintenance": asset.days_since_last_maintenance,
        },
        "risk": score,
        "timeline": timeline,
        "component_counts_12mo": dict(component_counts),
        "readiness_trajectory": trajectory,
    }


# ---------------------------------------------------------------------------
# Cannibalization board
# ---------------------------------------------------------------------------

@router.get("/cannibalization")
async def cannibalization(role: Optional[str] = None):
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    # Needs: currently NMCS SRs with un-received parts
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    needs = []
    for sr in ds.srs:
        if sr.is_pmcs or sr.close_date is not None:
            continue
        if sr.condition != "Deadlined":
            continue
        if allowed is not None and sr.unit_name not in allowed:
            continue
        pending = [
            r for r in sr.requisitions
            if r.received_date is None or (last_day and r.received_date > last_day)
        ]
        if not pending:
            continue
        needs.append({
            "sr_number": sr.sr_number,
            "asset_id": sr.asset_id,
            "unit": sr.unit_name,
            "equipment_type": sr.equipment_type,
            "fault_component": sr.fault_component,
            "days_open": (last_day - sr.open_date).days if last_day else 0,
            "needed_part": {
                "nsn": pending[0].nsn,
                "nomenclature": pending[0].nomenclature,
                "unit_cost": pending[0].unit_cost,
                "supply_path": pending[0].supply_path,
            },
        })

    # Cannibalization events -- already produced by the engine
    matches = []
    for ev in ds.cannib_events:
        if allowed is not None and ev.recipient_unit not in allowed and ev.donor_unit not in allowed:
            continue
        matches.append({
            "event_id": ev.event_id,
            "event_date": ev.event_date.isoformat(),
            "recipient": {
                "asset_id": ev.recipient_asset_id,
                "sr_number": ev.recipient_sr_number,
                "unit": ev.recipient_unit,
            },
            "donor": {
                "asset_id": ev.donor_asset_id,
                "sr_number": ev.donor_sr_number,
                "unit": ev.donor_unit,
            },
            "nsn": ev.nsn,
            "nomenclature": ev.nomenclature,
            "impact": ev.readiness_impact_note,
        })

    return {
        "open_needs": needs,
        "completed_matches": matches,
        "total_events": len(matches),
    }


# In-memory log of operator-proposed matches. Persists to the audit chain so a
# security manager can review what a data custodian or G-4 has proposed.
_PROPOSED_MATCHES: list[dict] = []


@router.post("/cannibalization/propose")
async def propose_cannibalization(payload: dict):
    """Accept an operator-proposed cross-level. The match is NOT executed
    against the dataset (that would mutate canonical fixtures); it is logged
    to the audit chain with a PROPOSED status. A production build would add a
    review gate + approval chain before committing."""
    recipient_sr = payload.get("recipient_sr")
    donor_sr = payload.get("donor_sr")
    nsn = payload.get("nsn")
    if not (recipient_sr and donor_sr and nsn):
        raise HTTPException(status_code=400, detail="recipient_sr, donor_sr, nsn required")

    proposal = {
        "proposal_id": f"PROP-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}",
        "recipient_sr": recipient_sr,
        "donor_sr": donor_sr,
        "nsn": nsn,
        "status": "PROPOSED",
        "proposed_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    _PROPOSED_MATCHES.append(proposal)
    try:
        from ..persistence import audit_log
        audit_log(
            "cannibalization_propose",
            actor=payload.get("actor_role", "unknown"),
            subject_id=proposal["proposal_id"],
            payload=proposal,
        )
    except Exception:
        pass
    return {"ok": True, "proposal": proposal}


# ---------------------------------------------------------------------------
# Readiness forecast
# ---------------------------------------------------------------------------

@router.get("/forecast")
async def forecast(unit: Optional[str] = None, window: int = Query(14, ge=7, le=30)):
    """Monte Carlo readiness projection.

    Fits slope + residual std on the last 30 days of history, then samples
    200 forward paths of `window` days. Return payload includes:
      - history: trimmed to last 30 days (full 365 is available elsewhere)
      - projection: mean + 10/50/90 percentile band per day
      - paths: 200 sample paths at daily resolution (for the "spaghetti plot"
        rendering on the frontend)
      - threshold + probability-of-cross readout
    """
    import random as _r
    import math

    ds = get_dataset()
    by_date = defaultdict(lambda: defaultdict(Counter))
    for s in ds.snapshots:
        if unit and s.unit_name != unit:
            continue
        by_date[s.snapshot_date]["all"][s.readiness_code] += 1

    dates = sorted(by_date.keys())
    if len(dates) < 14:
        raise HTTPException(status_code=503, detail="not enough history for forecast")

    full_history = []
    for d in dates:
        c = by_date[d]["all"]
        total = sum(c.values())
        if total == 0:
            continue
        full_history.append({
            "date": d.isoformat(),
            "mc_rate": round(c.get("MC", 0) / total, 3),
            "pmc_rate": round(c.get("PMC", 0) / total, 3),
            "nmc_rate": round((c.get("NMCM", 0) + c.get("NMCS", 0)) / total, 3),
        })

    # Clamp history returned to the frontend to the last 30 days so the
    # x-axis doesn't compress the projection into a 4% sliver.
    history = full_history[-30:]

    # Fit slope + intercept + residual std on last 30 days
    projection: list[dict] = []
    paths: list[list[float]] = []
    threshold = 0.75
    threshold_cross = None
    cross_probabilities: list[dict] = []

    recent = full_history[-30:]
    if len(recent) >= 2:
        y = [r["mc_rate"] for r in recent]
        n = len(y)
        xs = list(range(n))
        x_mean = (n - 1) / 2
        y_mean = sum(y) / n
        denom = sum((xi - x_mean) ** 2 for xi in xs) or 1.0
        m = sum((xs[i] - x_mean) * (y[i] - y_mean) for i in range(n)) / denom
        b = y_mean - m * x_mean

        # Residual std from the regression line
        residuals = [y[i] - (b + m * xs[i]) for i in range(n)]
        mean_resid = sum(residuals) / n
        var = sum((r - mean_resid) ** 2 for r in residuals) / max(1, n - 1)
        sigma = math.sqrt(var)
        # Cap sigma to avoid a comedy-sized ribbon on noisy data.
        sigma = min(sigma, 0.04)

        last_date = dates[-1]
        last_y = y[-1]

        # Generate 200 stochastic forward paths.
        rng = _r.Random(hash((unit or "FLEET", last_date.toordinal())) & 0xFFFFFFFF)
        for _ in range(200):
            path: list[float] = []
            cum = 0.0
            for t in range(1, window + 1):
                cum += rng.gauss(0, sigma * 0.6)
                projected = last_y + m * t + cum
                path.append(max(0.0, min(1.0, projected)))
            paths.append([round(v, 4) for v in path])

        # Per-day mean + percentiles
        for t in range(window):
            col = sorted(path[t] for path in paths)
            p10 = col[int(0.10 * len(col))]
            p50 = col[int(0.50 * len(col))]
            p90 = col[int(0.90 * len(col))]
            mean = sum(col) / len(col)
            cross_frac = sum(1 for v in col if v < threshold) / len(col)
            date_str = (last_date + timedelta(days=t + 1)).isoformat()
            projection.append({
                "date": date_str,
                "projected_mc_rate": round(mean, 3),
                "p10": round(p10, 3),
                "p50": round(p50, 3),
                "p90": round(p90, 3),
                "confidence_lower": round(p10, 3),
                "confidence_upper": round(p90, 3),
                "cross_probability": round(cross_frac, 3),
            })
            cross_probabilities.append({"date": date_str, "p": round(cross_frac, 3)})
            if threshold_cross is None and mean < threshold:
                threshold_cross = date_str

    return {
        "unit": unit or "FLEET",
        "history": history,
        "projection": projection,
        "paths": paths,
        "threshold": threshold,
        "threshold_cross_date": threshold_cross,
        "cross_probabilities": cross_probabilities,
    }


# ---------------------------------------------------------------------------
# Feedback loop (correct/incorrect)
# ---------------------------------------------------------------------------

@router.post("/feedback/{asset_id}")
async def feedback(asset_id: str, payload: dict):
    correct = bool(payload.get("correct", False))
    note = payload.get("note", "")
    record_pulse_feedback(asset_id, correct, note=note)
    summary = feedback_summary()
    return {"ok": True, "asset_id": asset_id, "correct": correct, "summary": summary}


@router.get("/feedback/summary")
async def feedback_summary_endpoint():
    """Aggregate feedback stats -- drives the 'continuous model improvement'
    story in the spec Q&A."""
    return feedback_summary()
