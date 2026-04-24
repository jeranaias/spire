"""PULSE endpoints: fleet overview, risk board, cannibalization, forecast."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta
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


# ---------------------------------------------------------------------------
# Readiness forecast
# ---------------------------------------------------------------------------

@router.get("/forecast")
async def forecast(unit: Optional[str] = None, window: int = Query(14, ge=7, le=30)):
    ds = get_dataset()
    by_date = defaultdict(lambda: defaultdict(Counter))
    for s in ds.snapshots:
        if unit and s.unit_name != unit:
            continue
        by_date[s.snapshot_date]["all"][s.readiness_code] += 1

    dates = sorted(by_date.keys())
    if len(dates) < 14:
        raise HTTPException(status_code=503, detail="not enough history for forecast")

    history = []
    for d in dates:
        c = by_date[d]["all"]
        total = sum(c.values())
        if total == 0:
            continue
        history.append({
            "date": d.isoformat(),
            "mc_rate": round(c.get("MC", 0) / total, 3),
            "pmc_rate": round(c.get("PMC", 0) / total, 3),
            "nmc_rate": round((c.get("NMCM", 0) + c.get("NMCS", 0)) / total, 3),
        })

    # Simple linear trend over last 30 days projected forward `window` days
    recent = history[-30:]
    if len(recent) >= 2:
        y = [r["mc_rate"] for r in recent]
        n = len(y)
        # y = m*x + b where x is index
        xs = list(range(n))
        x_mean = (n - 1) / 2
        y_mean = sum(y) / n
        denom = sum((xi - x_mean) ** 2 for xi in xs) or 1.0
        m = sum((xs[i] - x_mean) * (y[i] - y_mean) for i in range(n)) / denom
        b = y_mean - m * x_mean

        last_date = dates[-1]
        projection = []
        for i in range(1, window + 1):
            projected_mc = max(0.0, min(1.0, b + m * (n - 1 + i)))
            projection.append({
                "date": (last_date + timedelta(days=i)).isoformat(),
                "projected_mc_rate": round(projected_mc, 3),
                "confidence_lower": round(max(0.0, projected_mc - 0.05), 3),
                "confidence_upper": round(min(1.0, projected_mc + 0.05), 3),
            })
    else:
        projection = []

    threshold = 0.75
    threshold_cross = None
    for p in projection:
        if p["projected_mc_rate"] < threshold:
            threshold_cross = p["date"]
            break

    return {
        "unit": unit or "FLEET",
        "history": history,
        "projection": projection,
        "threshold": threshold,
        "threshold_cross_date": threshold_cross,
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
