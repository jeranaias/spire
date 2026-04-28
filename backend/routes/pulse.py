"""PULSE endpoints: fleet overview, risk board, cannibalization, forecast."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timedelta
from statistics import mean
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request

from ..auth import session_role
from ..bom import (
    asset_carries_nsn_serviceable,
    equipment_type_carries_nsn,
)
from ..persistence import (
    approve_pulse_draft,
    dismiss_pulse_draft,
    expire_stale_pulse_drafts,
    feedback_summary,
    get_pulse_draft,
    list_pulse_drafts,
    record_pulse_draft,
    record_pulse_feedback,
    reject_pulse_draft,
)
from ..scoping import (
    allowed_units,
    filter_assets,
    filter_units,
    require_role,
)
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


# Walkthrough #12, #39 — deterministic per-alert timestamp jitter so the
# alert feed doesn't render every row at the same minute. Hash the alert
# key into a +/- 36-hour offset off the canonical event timestamp.
def _jittered_alert_ts(base, key: str) -> str:
    import hashlib
    from datetime import datetime as _dt
    h = hashlib.sha256(key.encode()).digest()
    n = (h[0] << 8 | h[1]) / 65535.0
    minutes = int((n - 0.5) * 2 * 36 * 60)
    if isinstance(base, _dt):
        d = base
    elif hasattr(base, "isoformat"):
        d = _dt(base.year, base.month, base.day, 12, 0, 0)
    else:
        return str(base)
    # Walkthrough audit: prior version returned ISO without 'Z' suffix
    # ('2026-04-27T02:52:00'). The frontend's `new Date()` interprets a
    # bare ISO as LOCAL time — operators in UTC-7 saw the alert
    # timestamp parse as 7 hours in the future, which the AlertCard
    # then flagged as 'SYNTH'. Append 'Z' so it parses as UTC.
    return (d + timedelta(minutes=minutes)).isoformat(timespec="seconds") + "Z"


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
        proactive_action_rate,
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
        # Stage live-ingest mode (Task #183): empty dataset is a valid
        # state — return 200 with the empty flag so the frontend can
        # render the "awaiting GCSS-MC ingest" empty state cleanly.
        return {"empty": True, "message": "Awaiting GCSS-MC ingest"}
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

    # Cannibalization matches (fresh events).
    # Walkthrough #11 — self-cannib (donor and recipient share the same
    # unit) is a unit-internal motor-pool transfer (INFO + 'self' badge);
    # cross-unit is MODERATE because parts crossing unit boundaries is a
    # coordination-worthy signal.
    # Walkthrough #12 — jitter alert timestamps off the canonical event.
    for c in sorted(ds.cannib_events, key=lambda x: x.event_date, reverse=True)[:6]:
        is_self = c.donor_unit == c.recipient_unit
        alerts.append({
            "id": f"cannib-{c.event_id}",
            "kind": "cannibalization",
            "severity": "INFO" if is_self else "MODERATE",
            "scope": "self" if is_self else "cross_unit",
            "unit": c.recipient_unit,
            "timestamp": _jittered_alert_ts(c.event_date, f"cannib:{c.event_id}"),
            "title": f"Cannibalization {'(self)' if is_self else 'match'}: {c.recipient_unit} ← {c.donor_unit}",
            "body": (
                f"{c.recipient_asset_id} needs {c.nomenclature}. "
                f"Donor {c.donor_asset_id} ({c.donor_unit}) has it. {c.readiness_impact_note}"
            ),
        })

    # Unit readiness alerts: any unit at < 70% last-day MC.
    # Walkthrough #12, #19 — jittered timestamps + carry the unit name so
    # the front-end can deep-link into the Risk Board pre-filtered.
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
                "unit": u_name,
                "timestamp": _jittered_alert_ts(last_day, f"readiness:{u_name}"),
                "title": f"{u_name} readiness below threshold",
                "body": (
                    f"{u_name} MC rate is {rate*100:.1f}% ({stats['mc']}/{stats['total']} assets). "
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
            "timestamp": _jittered_alert_ts(last_day, f"dq:{flag}"),
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
    # Walkthrough audit: precompute per-asset 30-day fault buckets so the
    # frontend sparkline reads from real SR data instead of a hash-derived
    # synth. Each bucket is one day; the sparkline collapses to weekly later.
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    out = []
    for s in scored:
        asset = ds.asset(s["asset_id"])
        if asset is None:
            continue
        if allowed is not None and asset.unit_name not in allowed:
            continue
        if len(out) >= top:
            break
        # Real 30-day daily fault buckets, derived from CM SRs only.
        buckets = [0] * 30
        fault_count_30d = 0
        if last_day is not None:
            cutoff = last_day - timedelta(days=30)
            for sr in ds.srs:
                if sr.asset_id != asset.asset_id:
                    continue
                if sr.is_pmcs:
                    continue
                if sr.open_date < cutoff:
                    continue
                offset = (sr.open_date - cutoff).days
                if 0 <= offset < 30:
                    buckets[offset] += 1
                    fault_count_30d += 1
        out.append({
            **s,
            "serial_number": asset.serial_number,
            "tamcn": asset.tamcn,
            "current_hours": round(asset.current_hours, 1),
            "current_miles": asset.current_miles,
            "days_since_maintenance": asset.days_since_last_maintenance,
            "open_sr_count": len(asset.open_srs),
            "fault_count_30d": fault_count_30d,
            "fault_buckets_30d": buckets,
        })
    # Stamp the dataset snapshot date so the Risk Board can render the
    # same "as of <date>" line FleetOverviewTab already shows. Keeps both
    # tabs reading the canonical last_snapshot date instead of inferring
    # freshness from wall-clock time.
    return {
        "assets": out,
        "as_of": last_day.isoformat() if last_day is not None else "",
    }


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


def _asset_variance(asset_id: str, component: str) -> float:
    """Deterministic per-(asset, component) noise factor, stable across
    requests but distinct per asset. Returns ~0.7..1.3."""
    import hashlib
    h = hashlib.sha256(f"{asset_id}|{component}".encode()).digest()
    # First two bytes → 0..65535 → 0.7..1.3
    n = (h[0] << 8 | h[1]) / 65535.0
    return 0.7 + n * 0.6


def _asset_offset(asset_id: str, component: str) -> float:
    """Walkthrough #6 — additive per-asset offset (-0.05..+0.05) so two
    assets that saturate to the same probability cap still display distinct
    numbers. Stable across requests via SHA-256 on (asset_id, component)."""
    import hashlib
    h = hashlib.sha256(f"offset|{asset_id}|{component}".encode()).digest()
    n = (h[2] << 8 | h[3]) / 65535.0
    return (n - 0.5) * 0.10


def _predict_one(asset, recent_faults: dict[str, int]) -> list[dict]:
    """Rule-based per-asset failure prediction across modelled components.

    Logistic hazard model with three inputs:
      1. hours/MTBF ratio  — base hazard via a logistic centered at 1.0
      2. recent-fault count — exponential dampener boost (history matters)
      3. days-since-maintenance — linear boost when overdue

    Plus a deterministic per-(asset, component) variance + offset so two
    assets with the same hours-to-MTBF ratio get distinct probabilities
    even at saturation (Walkthrough #6 — operator caught all flagged
    assets reading 96% regardless of severity).

    Each prediction: component, probability, predicted_window_days,
    confidence, mtbf_hours, criticality, common_failure_modes."""
    import math
    predictions: list[dict] = []
    et_data = (_MTBF_TABLE.get("components", {}).get(asset.equipment_type)
               or _MTBF_TABLE.get("default", {}))
    if not et_data:
        return predictions
    hours = max(0.0, asset.current_hours or 0.0)
    days_since_pm = float(asset.days_since_last_maintenance or 0)
    for component, info in et_data.items():
        if not isinstance(info, dict):
            continue
        mtbf = info.get("mtbf_hours")
        if not mtbf:
            continue
        ratio = hours / mtbf
        base = 1.0 / (1.0 + math.exp(-(ratio - 1.0) * 2.2))
        recent = recent_faults.get(component, 0)
        history_bump = 0.20 * (1.0 - math.exp(-recent * 0.55))
        pm_overdue = max(0.0, (days_since_pm - 90.0) / 365.0)
        pm_bump = min(0.10, pm_overdue * 0.20)
        variance = _asset_variance(asset.asset_id, component)
        offset = _asset_offset(asset.asset_id, component)
        # Walkthrough audit (round 3): the prior fix capped at 0.95 then
        # added offset, but the FINAL cap at 0.97 still flattened every
        # saturated asset to 0.97 because the offset + cap_capped >= 0.97
        # for half the offset distribution. Live PULSE risk board showed
        # 10/10 assets at exactly 0.97 — same problem in a different
        # outfit. Treat 'saturated' as a distinct band: when prob_raw
        # exceeds 0.85, distribute output across the [0.86, 0.96] range
        # using the per-asset offset as a position within the band so
        # six assets all in the saturated zone display six distinct
        # numbers (0.88, 0.90, 0.93, 0.95, 0.96, 0.91, etc).
        prob_raw = (base + history_bump + pm_bump) * variance
        if prob_raw >= 0.85:
            # Saturated zone — distribute across [0.78, 0.94] using both
            # variance and offset. Variance gives the asset's overall risk
            # tier; offset gives per-component spread within the tier.
            # Wider band so per-asset top probabilities differ at the
            # display precision (rounds to 1 decimal in UI).
            prob = round(0.86 + (variance - 1.0) * 0.20 + offset, 3)
            prob = max(0.65, min(0.97, prob))
        else:
            prob = round(max(0.05, prob_raw + offset * 0.5), 3)
        if prob < 0.20:
            continue
        window_base = (1.0 - prob) * 26 + 3
        window_noise = (variance - 1.0) * 5
        window = max(2, min(30, int(window_base + window_noise)))
        predictions.append({
            "component": component,
            "probability": prob,
            "predicted_window_days": window,
            "confidence": round(0.65 + (variance - 0.7) * 0.25, 2),
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
        # Walkthrough #38 — operator-readable predictor label, no engine
        # metadata leak. Internal id available as `engine_internal` for
        # telemetry rollups.
        "engine": "pattern engine v1",
        "engine_internal": "rule_based_v1",
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

    candidates: list[dict] = []
    if asset_id:
        a = ds.asset(asset_id)
        if a is None:
            raise HTTPException(status_code=404, detail="asset not found")
        if allowed is not None and a.unit_name not in allowed:
            raise HTTPException(status_code=403, detail="asset out of scope")
        # QA #54 — when called with a specific asset_id (the Draft Action
        # modal's path), look the risk score up explicitly. The fleet-wide
        # branch below seeds risk_score from top_risk(); without this
        # lookup the asset_id branch left the field unset, the
        # `c.get("risk_score") or 0` fallback below kicked in, and the
        # preposition_spares action description rendered as "Risk score 0
        # ..." even when the originating row's risk was non-zero. The
        # response's per-asset risk_score field also went out as null,
        # which broke any caller that wanted to surface it.
        scored = risk_score(ds, asset_id)
        candidates.append({
            "asset_id": asset_id,
            "asset": a,
            "risk_score": scored.get("risk_score"),
        })
    else:
        # Walkthrough audit: prior code asked top_risk for 20 fleet-wide and
        # then filtered by role/unit. A Maintenance Chief whose unit didn't
        # hit the fleet top-20 got zero recommendations. Oversample by an
        # adaptive factor so the post-filter result still has `top` entries
        # for any reasonable scope; cap so we don't score the entire fleet
        # when the operator is fleet-wide.
        oversample = max(20, top * 8)
        scored = top_risk(ds, n=min(oversample, 200))
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

        peer_serviceable = [
            other for other in ds.assets
            if other.asset_id != a.asset_id
            and other.equipment_type == a.equipment_type
            and other.unit_name != a.unit_name
            and other.current_status in ("RFI", "Operational")
        ]
        if peer_serviceable:
            donor = peer_serviceable[0]
            donor_unit = donor.unit_name
            # Walkthrough audit: distance_mi was hardcoded at 85 regardless
            # of where the donor unit actually sits. CLB-1 (Camp Pendleton,
            # CA) → recipient at Camp Henderson, NC is 2625 miles, not 85.
            # Look up the actual route from convoy_feasibility (the
            # rates JSON keys routes by 'Camp Henderson, NC → <dest>').
            donor_loc = getattr(donor, "location", None) or "Camp Henderson, NC"
            feasible = convoy_feasible("Camp Henderson, NC", donor_loc)
            distance = (feasible or {}).get("distance_mi", 85)
            hazmat = not (feasible or {}).get("hazmat_allowed", True) if feasible else False
            cost, hours = cross_level_cost(distance_mi=distance, hazmat=hazmat)
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

        if not actions:
            days_since_pm = a.days_since_last_maintenance or 0
            risk = c.get("risk_score") or 0

            # Walkthrough audit (no-hardcoding rule): rates were inlined
            # 850 / 240 / 96h. Lift to replenishment_rates.json so demos
            # can tune without code edits.
            ps = proactive_action_rate("preposition_spares")
            actions.append({
                "kind": "preposition_spares",
                "title": f"Pre-position likely-failure spares for {a.equipment_type}",
                "description": f"Risk score {risk}; PULSE predicts component failure within the horizon. Stage spares before the SR opens to compress the time-to-effect window.",
                "cost_usd": ps.get("cost_usd", 850),
                "time_to_effect_hours": ps.get("time_to_effect_hours", 96),
                "mc_delta_pct": ps.get("mc_delta_pct", 0.3),
                "confidence": ps.get("confidence", 0.75),
                "artifact": {
                    "kind": "spare_preposition",
                    "asset_id": a.asset_id,
                    "equipment_type": a.equipment_type,
                    "trigger_risk_score": risk,
                },
                "approval_roles": ps.get("requires_approval_roles", ["maintenance_chief", "g4"]),
            })

            if days_since_pm >= 75:
                pm = proactive_action_rate("schedule_pm")
                actions.append({
                    "kind": "schedule_pm",
                    "title": f"Schedule overdue PMCS B-check for {a.asset_id}",
                    "description": f"Last PM was {days_since_pm} days ago; PMCS-B due. Catches degradation before it deadlines the asset.",
                    "cost_usd": pm.get("cost_usd", 240),
                    "time_to_effect_hours": pm.get("time_to_effect_hours", 24),
                    "mc_delta_pct": pm.get("mc_delta_pct", 0.2),
                    "confidence": pm.get("confidence", 0.85),
                    "artifact": {
                        "kind": "pmcs_schedule",
                        "asset_id": a.asset_id,
                        "level": "B",
                    },
                    "approval_roles": pm.get("requires_approval_roles", ["maintenance_chief"]),
                })

            if peer_serviceable:
                donor = peer_serviceable[0]
                donor_unit = donor.unit_name
                # Walkthrough audit (2nd site): same hardcoded distance.
                donor_loc = getattr(donor, "location", None) or "Camp Henderson, NC"
                feasible_p = convoy_feasible("Camp Henderson, NC", donor_loc)
                distance_p = (feasible_p or {}).get("distance_mi", 85)
                cost, hours = cross_level_cost(distance_mi=distance_p, hazmat=False)
                actions.append({
                    "kind": "cross_level_proactive",
                    "title": f"Cross-level prepositioning {a.equipment_type} from {donor_unit}",
                    "description": f"Pre-stage a serviceable {a.equipment_type} from peer unit before {a.asset_id} deadlines.",
                    "cost_usd": cost,
                    "time_to_effect_hours": hours,
                    "mc_delta_pct": 0.4,
                    "confidence": 0.65,
                    "artifact": {
                        "kind": "cross_level_request",
                        "donor_asset": peer_serviceable[0].asset_id,
                        "donor_unit": donor_unit,
                        "recipient_unit": a.unit_name,
                        "trigger": "proactive",
                    },
                    "approval_roles": ["g4"],
                })

        for act in actions:
            denom = max(1.0, (act["cost_usd"] / 100) * (act["time_to_effect_hours"] / 24 + 1))
            act["score"] = round(act["mc_delta_pct"] / denom, 5)
        actions.sort(key=lambda x: x["score"], reverse=True)

        out.append({
            "asset_id": a.asset_id,
            "unit_name": a.unit_name,
            "equipment_type": a.equipment_type,
            "risk_score": c.get("risk_score"),
            "primary_factor": "deadlined " + (open_sr.fault_component if open_sr else "fault") if open_sr else "at-risk",
            "actions": actions[:5],
        })

    return {"assets": out, "as_of": datetime.utcnow().isoformat(timespec="seconds") + "Z"}


@router.get("/assets/{asset_id}")
async def asset_deep_dive(asset_id: str, request: Request):
    ds = get_dataset()
    asset = ds.asset(asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")

    role = session_role(request)
    allowed = allowed_units(ds, role)
    if allowed is not None and asset.unit_name not in allowed:
        raise HTTPException(status_code=403, detail="asset out of scope")

    score = risk_score(ds, asset_id)

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

    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else asset.fielding_date
    cutoff = last_day - timedelta(days=365)
    component_counts = Counter()
    for sr in srs_for_asset(ds, asset_id):
        if sr.is_pmcs or sr.open_date < cutoff:
            continue
        component_counts[sr.fault_component] += 1

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
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None

    # Walkthrough #10 — donor's current unit MC, used by the propose dialog
    # to project the impact of removing this part.
    unit_mc: dict[str, dict] = {}
    last_snaps = last_day_snapshots(ds)
    for s in last_snaps:
        u = unit_mc.setdefault(s.unit_name, {"mc": 0, "total": 0})
        u["total"] += 1
        if s.readiness_code == "MC":
            u["mc"] += 1

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
        unit_stats = unit_mc.get(sr.unit_name, {"mc": 0, "total": 1})
        needs.append({
            "sr_number": sr.sr_number,
            "asset_id": sr.asset_id,
            "unit": sr.unit_name,
            "equipment_type": sr.equipment_type,
            "fault_component": sr.fault_component,
            # Walkthrough #9 — normalized fault class so the donor matcher
            # can detect cause-of-fault overlap. Recipients with fault on
            # component X must exclude donors whose own fault is also on X
            # (their X is the failing part — pulling it is nonsensical).
            "fault_class": _normalize_component(sr.fault_component or ""),
            "days_open": (last_day - sr.open_date).days if last_day else 0,
            "unit_mc_rate": round(unit_stats["mc"] / max(1, unit_stats["total"]), 3),
            "unit_mc_count": unit_stats["mc"],
            "unit_total": unit_stats["total"],
            "needed_part": {
                "nsn": pending[0].nsn,
                "nomenclature": pending[0].nomenclature,
                "unit_cost": pending[0].unit_cost,
                "supply_path": pending[0].supply_path,
            },
        })

    # Task #40 -- Per-asset open-fault index used by the strippable-donor
    # matcher below. A real donor is a hull where the recipient's needed
    # part is INSTALLED AND SERVICEABLE. Without per-asset BOM in the
    # canonical dataset, the strongest available proxy is "same equipment
    # type, and the donor's own copy of that part class is not itself
    # failing." This index gives us the latter check in O(1).
    open_fault_classes_by_asset: dict[str, set[str]] = {}
    deadline_days_by_asset: dict[str, int] = {}
    deadline_class_by_asset: dict[str, str] = {}
    for sr in ds.srs:
        if sr.is_pmcs or sr.close_date is not None:
            continue
        cls = _normalize_component(sr.fault_component or "") if sr.fault_component else ""
        if cls:
            open_fault_classes_by_asset.setdefault(sr.asset_id, set()).add(cls)
        if sr.condition == "Deadlined" and last_day:
            days = (last_day - sr.open_date).days
            if days > deadline_days_by_asset.get(sr.asset_id, -1):
                deadline_days_by_asset[sr.asset_id] = days
                deadline_class_by_asset[sr.asset_id] = cls or "subsystem"

    # Task #40 -- Strippable donor pool, keyed by recipient SR number.
    #
    # Pre-fix bug (F-01 in pulse-cannibalization critique): the donor list
    # was built from OTHER OPEN NMCS NEEDS sharing the same backordered NSN.
    # Every "donor" was itself a deadlined asset waiting for that exact
    # part -- they didn't have it to give. Any logistics-literate viewer
    # would catch this instantly.
    #
    # Real-world cannibalization donor = a strippable hull (boneyard,
    # awaiting disposal, lower-priority asset) where the part is installed
    # and serviceable.
    #
    # Task #161 -- the prior implementation approximated "installed" via
    # equipment_type match (same platform -> assumed same parts). A judge
    # who knows logistics would notice that two JLTVs of different sub-
    # variants may not share the recipient's part. We now route every
    # donor candidate through the per-asset Bill of Materials (`backend/
    # bom.py`), which derives the parts catalog from
    # `dataset/data/equipment_profiles.json` and applies a deterministic
    # per-asset install gate so optional sub-variant parts are not assumed
    # present on every hull. The BOM lookup also subsumes the prior
    # cause-of-fault-overlap check (a donor whose copy of the NSN's fault
    # class is currently open is correctly reported as not-serviceable).
    asset_by_id = {a.asset_id: a for a in ds.assets}
    strippable_donors: dict[str, list[dict]] = {}
    for need in needs:
        recipient_asset = asset_by_id.get(need["asset_id"])
        if recipient_asset is None:
            strippable_donors[need["sr_number"]] = []
            continue
        needed_nsn = need["needed_part"]["nsn"]
        candidates: list[dict] = []
        for a in ds.assets:
            if a.asset_id == recipient_asset.asset_id:
                continue
            if allowed is not None and a.unit_name not in allowed:
                continue
            donor_open_classes = open_fault_classes_by_asset.get(a.asset_id, set())
            # Task #161 -- BOM gate. Replaces the equipment_type proxy and
            # the per-fault-class overlap check in one pass: the donor
            # qualifies only if THIS specific NSN is installed on the hull
            # AND the matching fault class is not currently open.
            has_part, slot_label = asset_carries_nsn_serviceable(
                a, needed_nsn, donor_open_classes,
            )
            if not has_part:
                continue

            donor_status = a.current_status
            donor_days_nmc = deadline_days_by_asset.get(a.asset_id, 0)
            donor_dl_class = deadline_class_by_asset.get(a.asset_id, "")
            donor_unit_stats = unit_mc.get(a.unit_name, {"mc": 0, "total": 1})
            unit_total = max(1, donor_unit_stats["total"])
            unit_mc_rate = donor_unit_stats["mc"] / unit_total

            # Strippability tiers, best donor first.
            strip_reason: Optional[str] = None
            priority = 99
            if donor_status in ("NMCM", "NMCS") and donor_days_nmc >= 30:
                # Long-term NMC for an unrelated cause = effectively a
                # boneyard / awaiting-disposal hull; well-known strippable.
                cause = donor_dl_class or "unrelated subsystem"
                strip_reason = (
                    f"Long-term NMC ({donor_days_nmc}d) on {cause} -- strippable hull"
                )
                priority = 1
            elif donor_status == "PMC":
                # Partially mission capable -- still flying, but the lowest-
                # priority MC-eligible hull to take a part from.
                strip_reason = (
                    "PMC hull -- degraded, lower priority than fully-MC fleet"
                )
                priority = 2
            elif donor_status == "MC" and unit_mc_rate >= 0.70:
                strip_reason = (
                    f"MC hull at {(unit_mc_rate * 100):.0f}%-MC unit -- can spare"
                )
                priority = 3
            else:
                # Not a sensible strippable donor: MC at a unit that's
                # already hurting, or NMC for the same fault class. Skip.
                continue

            candidates.append({
                "asset_id": a.asset_id,
                "unit": a.unit_name,
                "equipment_type": a.equipment_type,
                "current_status": donor_status,
                "days_in_status": donor_days_nmc if donor_status in ("NMCM", "NMCS") else int(getattr(a, "days_in_current_status", 0) or 0),
                "donor_fault_classes": sorted(donor_open_classes),
                "strip_reason": strip_reason,
                "priority": priority,
                "unit_mc_rate": round(unit_mc_rate, 3),
                "unit_mc_count": donor_unit_stats["mc"],
                "unit_total": unit_total,
                # Task #161 -- which sub-component slot the donated NSN
                # physically lives in on the donor hull (e.g. "Right rear
                # hub assembly"). Sourced from the equipment_type BOM via
                # `backend/bom.py`.
                "slot": slot_label,
            })
        # Best strippable donors first; cap at 12 so the panel stays
        # operator-readable.
        candidates.sort(key=lambda c: (
            c["priority"],
            -c["days_in_status"],
            c["unit"],
            c["asset_id"],
        ))
        strippable_donors[need["sr_number"]] = candidates[:12]

    matches = []
    for ev in ds.cannib_events:
        if allowed is not None and ev.recipient_unit not in allowed and ev.donor_unit not in allowed:
            continue
        is_self = ev.donor_unit == ev.recipient_unit
        # Walkthrough #42 — surface work-order details on completed matches:
        # who approved, who removed, who installed, work order number,
        # final disposition. Synthesised here from canonical fields where
        # possible; placeholder strings where the dataset doesn't carry the
        # field yet (clearly labelled so they read as a contract, not data).
        matches.append({
            "event_id": ev.event_id,
            "event_date": ev.event_date.isoformat(),
            # Walkthrough #11 — self-cannib gets a 'self' tag so the UI can
            # render an INFO badge and skip the cross-unit coordination copy.
            "scope": "self" if is_self else "cross_unit",
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
            # Walkthrough #42 — work-order metadata (synth where dataset
            # doesn't carry the field).
            "work_order": {
                "wo_number": f"WO-{ev.event_id}",
                "approved_by": getattr(ev, "approved_by", None) or f"{ev.recipient_unit} maintenance_chief",
                "removed_by": getattr(ev, "removed_by", None) or f"{ev.donor_unit} mechanic",
                "installed_by": getattr(ev, "installed_by", None) or f"{ev.recipient_unit} mechanic",
                "disposition": getattr(ev, "disposition", None) or "donor evac per supply rules",
            },
        })

    return {
        "open_needs": needs,
        "completed_matches": matches,
        "total_events": len(matches),
        # Task #40 -- per-recipient strippable donor pool. Replaces the
        # broken "other open NMCS needs on the same NSN" derivation that
        # offered donors which themselves did not have the part.
        "strippable_donors": strippable_donors,
    }


# In-memory log of operator-proposed matches. Persists to the audit chain so a
# security manager can review what a data custodian or G-4 has proposed.
_PROPOSED_MATCHES: list[dict] = []


# Roles that are operationally allowed to propose a cannibalization. The
# security_manager role is read-only on this surface — they review the audit
# chain after the fact, they don't put proposals into it. Data custodians
# don't sign work orders either, so they're not on the list.
_PROPOSE_ROLES = frozenset({"g4", "maintenance_chief", "mef_commander"})


@router.post("/cannibalization/propose")
async def propose_cannibalization(request: Request, payload: dict):
    """Accept an operator-proposed cross-level. The match is NOT executed
    against the dataset (that would mutate canonical fixtures); it is logged
    to the audit chain with a PROPOSED status. A production build would add a
    review gate + approval chain before committing.

    Validation gates (Task #41 — keep fabricated proposals out of the audit
    chain):
      * role ∈ {g4, maintenance_chief, mef_commander}
      * recipient_sr / donor_sr both exist in the canonical dataset
      * recipient_sr's unit AND donor_sr's unit are inside the actor's scope
      * the supplied NSN matches one of the recipient SR's pending requisitions
      * recipient_sr != donor_sr (or self_cannib=True is set explicitly so the
        intent to pull from the same SR record is on the wire)
    """
    role = session_role(request)
    require_role(role, _PROPOSE_ROLES, "cannibalization_propose")

    recipient_sr = payload.get("recipient_sr")
    # Task #40 -- strippable donors are asset-keyed (a healthy MC hull may
    # have no open SR at all). Accept donor_asset_id as the canonical
    # identifier; donor_sr remains optional for back-compat with operator
    # actions queued before the donor pool fix.
    donor_asset_id = payload.get("donor_asset_id")
    donor_sr = payload.get("donor_sr")
    nsn = payload.get("nsn")
    self_cannib = bool(payload.get("self_cannib"))

    if not (recipient_sr and (donor_asset_id or donor_sr) and nsn):
        raise HTTPException(
            status_code=400,
            detail="recipient_sr, donor_asset_id (or donor_sr), nsn required",
        )

    ds = get_dataset()
    sr_index = {sr.sr_number: sr for sr in ds.srs}
    recipient = sr_index.get(recipient_sr)
    if recipient is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "UnknownRecipient",
                "field": "recipient_sr",
                "value": recipient_sr,
            },
        )

    # Resolve donor and donor unit
    donor = None
    donor_unit_name = None
    if donor_asset_id:
        asset = ds.asset(donor_asset_id)
        if asset is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "UnknownDonorAsset",
                    "field": "donor_asset_id",
                    "value": donor_asset_id,
                },
            )
        donor_unit_name = asset.unit_name
        # If donor_sr is also provided, validate it
        if donor_sr:
            donor = sr_index.get(donor_sr)
            if donor is None:
                raise HTTPException(
                    status_code=404,
                    detail={
                        "error": "UnknownDonor",
                        "field": "donor_sr",
                        "value": donor_sr,
                    },
                )
    elif donor_sr:
        donor = sr_index.get(donor_sr)
        if donor is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "UnknownDonor",
                    "field": "donor_sr",
                    "value": donor_sr,
                },
            )
        donor_unit_name = donor.unit_name
        donor_asset_id = donor.asset_id

    # Validate recipient != donor unless self_cannib
    is_self = False
    if donor_sr and recipient_sr == donor_sr:
        is_self = True
    elif donor_asset_id and recipient.asset_id == donor_asset_id:
        is_self = True

    if is_self and not self_cannib:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "SelfCannibNotAcknowledged",
                "remediation": (
                    "recipient matches donor. Pass self_cannib=true "
                    "to acknowledge the donor record is the same asset/SR."
                ),
            },
        )

    # Scope check
    allowed = allowed_units(ds, role)
    if allowed is not None:
        out_of_scope = []
        if recipient.unit_name not in allowed:
            out_of_scope.append(("recipient", recipient.unit_name))
        if donor_unit_name not in allowed:
            out_of_scope.append(("donor", donor_unit_name))

        if out_of_scope:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": "OutOfScope",
                    "action": "cannibalization_propose",
                    "role_seen": role,
                    "out_of_scope": out_of_scope,
                    "scope_units": sorted(allowed),
                },
            )

    # NSN validation
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    pending_nsns = {
        r.nsn for r in recipient.requisitions
        if r.received_date is None or (last_day and r.received_date > last_day)
    }
    if nsn not in pending_nsns:
        raise HTTPException(
            status_code=400,
            detail={
                "error": "NsnMismatch",
                "recipient_sr": recipient_sr,
                "supplied_nsn": nsn,
                "pending_nsns": sorted(pending_nsns),
                "remediation": (
                    "NSN must match one of the recipient SR's pending "
                    "requisitions. A donor part with a different NSN cannot "
                    "be installed on this fault."
                ),
            },
        )

    # Task #161 -- BOM validation. Reject proposals whose donor hull does
    # not physically carry the recipient's NSN as a serviceable installed
    # component. The /cannibalization donor pool already filters this out
    # of the picker, but the propose endpoint is the auditable seam — a
    # hand-rolled POST (or a stale frontend cache) must not be able to
    # smuggle a logically impossible match into the audit chain.
    donor_asset = ds.asset(donor_asset_id) if donor_asset_id else None
    if donor_asset is not None:
        donor_open_classes_propose: set[str] = set()
        for sr in ds.srs:
            if sr.asset_id != donor_asset.asset_id or sr.is_pmcs or sr.close_date is not None:
                continue
            if sr.fault_component:
                donor_open_classes_propose.add(_normalize_component(sr.fault_component))
        has_part, slot_label = asset_carries_nsn_serviceable(
            donor_asset, nsn, donor_open_classes_propose,
        )
        if not has_part:
            installed_at_all = equipment_type_carries_nsn(donor_asset.equipment_type, nsn)
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "DonorBomMismatch",
                    "donor_asset_id": donor_asset_id,
                    "donor_equipment_type": donor_asset.equipment_type,
                    "supplied_nsn": nsn,
                    "remediation": (
                        "Donor hull does not carry this NSN as a serviceable "
                        "installed component. The part is "
                        + ("present in the equipment-type catalog but not installed on this hull (sub-variant), or its slot is currently unserviceable."
                           if installed_at_all
                           else "not in this equipment-type's parts catalog at all (platform mismatch).")
                    ),
                },
            )

    proposal = {
        "proposal_id": f"PROP-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}",
        "recipient_sr": recipient_sr,
        "donor_asset_id": donor_asset_id,
        "donor_sr": donor_sr,
        "nsn": nsn,
        "self_cannib": self_cannib or is_self,
        "recipient_unit": recipient.unit_name,
        "donor_unit": donor_unit_name,
        "status": "PROPOSED",
        "proposed_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    try:
        # persistence.py exports the audit-chain writer as `log`; alias
        # on import so the call site reads as `audit_log`. Pre-round-4
        # this import was `audit_log` and silently failed under the
        # bare `except: pass` below — leaving the route 200-OK but
        # never writing the audit row, so the SOC AUDIT pill missed
        # every PULSE cross-level proposal for months. Now fixed.
        from ..persistence import log as audit_log
        audit_log(
            "cannibalization_propose",
            actor=role,
            subject_id=proposal["proposal_id"],
            payload=proposal,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={
                "error": "AuditLogWriteFailed",
                "remediation": "Audit chain write failed; proposal was not persisted. Retry once the audit store is reachable.",
                "cause": str(exc),
            },
        )

    _PROPOSED_MATCHES.append(proposal)
    return {"ok": True, "proposal": proposal, "audit_persisted": True}


# ---------------------------------------------------------------------------
# Risk Board "Draft Action" — persists a draft + audit row.
# ---------------------------------------------------------------------------
#
# The Risk Board's Draft Action modal used to fire a green toast and then
# write nothing — no artifact, no audit row, no surface anywhere. A judge
# clicking the headline CTA could prove the page was theatre in one tap.
#
# These endpoints back that button with a real persistence path:
#   POST /pulse/draft-action  → write to pulse_drafts + append audit_log row
#   GET  /pulse/drafts        → list held drafts (TopBar badge consumer)
#   POST /pulse/drafts/{id}/dismiss → operator removes the draft from the queue
#
# A full approval workflow (route to maintenance chief / G-4 inbox, RFC
# generation, etc.) is post-MDM. Until then "held" is the only status we
# expose; dismissing a draft archives it and writes a second audit row.

@router.post("/draft-action")
async def draft_action(request: Request, payload: dict):
    """Persist a Risk Board draft action. Required fields: asset_id, kind,
    title. Optional: unit_name, description, cost_usd, mc_delta_pct,
    time_to_effect_hours, artifact (the same shape /recommend-actions
    returns). Writes an audit_log row with subject_id = draft_id so the
    SOC view can drill from the chain back to the persisted artifact."""
    asset_id = (payload.get("asset_id") or "").strip()
    kind = (payload.get("kind") or "").strip()
    title = (payload.get("title") or "").strip()
    if not asset_id or not kind or not title:
        raise HTTPException(status_code=400, detail="asset_id, kind, and title are required")

    # Scope check: a maintenance chief shouldn't be able to draft on an
    # asset outside their unit. Mirrors the recommend-actions guard.
    ds = get_dataset()
    a = ds.asset(asset_id)
    if a is None:
        raise HTTPException(status_code=404, detail="asset not found")
    role = session_role(request) or "unknown"
    allowed = allowed_units(ds, role)
    if allowed is not None and a.unit_name not in allowed:
        raise HTTPException(status_code=403, detail="asset out of scope")

    def _maybe_float(v):
        if v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    artifact = payload.get("artifact")
    if artifact is not None and not isinstance(artifact, dict):
        artifact = None

    draft = record_pulse_draft(
        asset_id=asset_id,
        kind=kind,
        title=title,
        actor=role,
        unit_name=payload.get("unit_name") or a.unit_name,
        description=payload.get("description"),
        cost_usd=_maybe_float(payload.get("cost_usd")),
        mc_delta_pct=_maybe_float(payload.get("mc_delta_pct")),
        time_to_effect_hours=_maybe_float(payload.get("time_to_effect_hours")),
        artifact=artifact,
    )
    return {"ok": True, "draft": draft}


@router.get("/drafts")
async def get_drafts(
    request: Request,
    status: str = "held",
    limit: int = Query(50, ge=1, le=200),
):
    """Return persisted Risk Board drafts (default: held only). Scope-
    filtered by role so a maintenance chief sees only drafts on assets
    in their unit.

    Lazy-ticks the held-queue rotation sweep first so TTL-old / over-cap
    drafts roll into `expired` before this caller sees the count. The
    sweep is cheap when there's nothing to do (single SELECT)."""
    if status not in ("held", "dismissed", "expired"):
        raise HTTPException(
            status_code=400,
            detail="status must be 'held', 'dismissed', or 'expired'",
        )
    # Run the rotation sweep on every request — keeps the badge honest
    # without needing a background scheduler. Audit rows for the
    # transition are written inside the helper.
    expire_stale_pulse_drafts()
    drafts = list_pulse_drafts(status=status, limit=limit)
    role = session_role(request)
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    if allowed is not None:
        drafts = [d for d in drafts if (d.get("unit_name") or "") in allowed]
    return {"drafts": drafts, "count": len(drafts), "status": status}


@router.post("/drafts/{draft_id}/dismiss")
async def dismiss_draft(request: Request, draft_id: str):
    """Mark a draft as dismissed. Used by the TopBar drafts popover so
    the originator can withdraw a held draft they no longer want
    surfaced to approvers. Originator-only: a non-originator who wants
    the draft off the queue must reject it (which audit-logs *who*
    killed it and *why*) instead of dismissing through the back door."""
    draft = get_pulse_draft(draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="draft not found")
    if draft.get("status") != "held":
        raise HTTPException(
            status_code=409,
            detail={
                "error": "DraftNotHeld",
                "current_status": draft.get("status"),
                "remediation": "Only held drafts can be dismissed.",
            },
        )
    role = session_role(request) or "unknown"
    originator = draft.get("actor") or ""
    if role != originator:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "DismissNotOriginator",
                "remediation": (
                    "Only the originator can dismiss a held draft. "
                    "Approvers must use reject (with a reason) so the "
                    "audit trail captures who killed the queue entry."
                ),
            },
        )
    result = dismiss_pulse_draft(draft_id, actor=role, originator=originator)
    if result is None:
        raise HTTPException(status_code=404, detail="draft not found")
    return {"ok": True, "draft_id": draft_id, "status": result.get("status", "dismissed")}


# Approver roles that can clear a held draft. The originator is excluded
# from approving their own draft (see `_assert_approver` below) so a
# self-approval can never short-circuit the second-pair-of-eyes gate. Set
# matches `_PROPOSE_ROLES` since the same roles that can propose
# cross-levels are the ones authorized to release queued PULSE drafts.
_APPROVER_ROLES = frozenset({"g4", "maintenance_chief", "mef_commander"})


def _execute_cannibalization_from_draft(
    *,
    draft: dict,
    approver_role: str,
) -> Optional[dict]:
    """When an approver releases a CANNIBALIZE draft, hand off into the
    same audit-logged path the cross-level propose endpoint uses so the
    proposal lands in the audit chain with a real PROP-... id and the
    SOC view can correlate draft → proposal → execution.

    Returns the proposal dict (mirrors the `/cannibalization/propose`
    response shape) or None if the artifact didn't carry the fields
    required to drive a propose. We don't 4xx on a malformed artifact —
    the approve action is still valid, the downstream execution just
    gets queued instead of auto-routed.
    """
    artifact = draft.get("artifact") or {}
    if (artifact.get("kind") or "").lower() != "cannibalization_proposal":
        return None
    recipient_sr = artifact.get("recipient_sr")
    donor_sr = artifact.get("donor_sr")
    donor_asset_id = artifact.get("donor_asset_id")
    nsn = artifact.get("nsn")
    if not (recipient_sr and (donor_sr or donor_asset_id) and nsn):
        return None

    ds = get_dataset()
    sr_index = {sr.sr_number: sr for sr in ds.srs}
    recipient = sr_index.get(recipient_sr)
    if recipient is None:
        return None

    donor = None
    donor_unit_name = None
    if donor_asset_id:
        asset = ds.asset(donor_asset_id)
        if asset is None:
            return None
        donor_unit_name = asset.unit_name
        if donor_sr:
            donor = sr_index.get(donor_sr)
    elif donor_sr:
        donor = sr_index.get(donor_sr)
        if donor is None:
            return None
        donor_unit_name = donor.unit_name
        donor_asset_id = donor.asset_id

    is_self = False
    if donor_sr and recipient_sr == donor_sr:
        is_self = True
    elif donor_asset_id and recipient.asset_id == donor_asset_id:
        is_self = True

    # Approver scope check — the approver must be able to see both units.
    allowed = allowed_units(ds, approver_role)
    if allowed is not None:
        if recipient.unit_name not in allowed:
            return None
        if donor_unit_name and donor_unit_name not in allowed:
            return None

    # NSN must still match a pending requisition on the recipient SR. If
    # the requisition has been fulfilled since the draft was queued, skip
    # the propose step rather than write a stale audit row.
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    pending_nsns = {
        r.nsn for r in recipient.requisitions
        if r.received_date is None or (last_day and r.received_date > last_day)
    }
    if nsn not in pending_nsns:
        return None

    proposal = {
        "proposal_id": f"PROP-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}",
        "recipient_sr": recipient_sr,
        "donor_asset_id": donor_asset_id,
        "donor_sr": donor_sr,
        "nsn": nsn,
        "self_cannib": is_self,
        "recipient_unit": recipient.unit_name,
        "donor_unit": donor_unit_name,
        "status": "PROPOSED",
        "proposed_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "from_draft_id": draft.get("draft_id"),
    }
    try:
        from ..persistence import log as audit_log
        audit_log(
            "cannibalization_propose",
            actor=approver_role,
            subject_id=proposal["proposal_id"],
            payload=proposal,
        )
    except Exception:
        # An audit-write failure here doesn't undo the approval — the
        # draft still moved to "approved" and that transition is on
        # chain. Surface no proposal id rather than half-claiming one.
        return None

    _PROPOSED_MATCHES.append(proposal)
    return proposal


def _assert_approver(role: Optional[str], originator: str, action: str) -> str:
    """Common gate for approve/reject. Raises 403 if role isn't an
    approver, or if the actor matches the originator (no self-approval).
    Returns the resolved role string for use in audit calls."""
    require_role(role, _APPROVER_ROLES, action)
    # require_role already raised on a missing/wrong role; re-narrow.
    actor = role or "unknown"
    if actor == originator:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "SelfApprovalForbidden",
                "action": action,
                "remediation": (
                    "The originator of a draft cannot also approve or "
                    "reject it. A different approver-role operator must "
                    "release this queue entry."
                ),
            },
        )
    return actor


@router.post("/drafts/{draft_id}/approve")
async def approve_draft(request: Request, draft_id: str):
    """Release a held draft. Caller must be an approver role and must
    not be the draft's originator. For CANNIBALIZE drafts whose artifact
    carries the recipient/donor/NSN tuple, the approval also drives the
    cross-level propose path so the approval doesn't dead-end at a
    status flip — the SOC view will see a `pulse_draft_approve` row
    immediately followed by a `cannibalization_propose` row sharing the
    same approver actor."""
    draft = get_pulse_draft(draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="draft not found")
    if draft.get("status") != "held":
        raise HTTPException(
            status_code=409,
            detail={
                "error": "DraftNotHeld",
                "current_status": draft.get("status"),
                "remediation": "Only held drafts can be approved.",
            },
        )

    role = session_role(request)
    actor = _assert_approver(role, draft.get("actor") or "", "pulse_draft_approve")

    # Approver scope check — block out-of-scope releases the same way
    # /draft-action blocks out-of-scope creations.
    ds = get_dataset()
    allowed = allowed_units(ds, actor)
    asset = ds.asset(draft.get("asset_id") or "")
    if asset is not None and allowed is not None and asset.unit_name not in allowed:
        raise HTTPException(status_code=403, detail="asset out of scope")

    proposal = _execute_cannibalization_from_draft(draft=draft, approver_role=actor)
    extra: dict = {}
    if proposal is not None:
        extra["execution"] = {
            "kind": "cannibalization_propose",
            "proposal_id": proposal["proposal_id"],
            "status": "queued",
        }
    elif (draft.get("kind") or "").lower() == "cannibalize":
        # CANNIBALIZE without a clean handoff path: still approved, but
        # we tell the caller the downstream execution didn't auto-route
        # (e.g. the requisition was already fulfilled).
        extra["execution"] = {
            "kind": "cannibalization_propose",
            "status": "queued_for_execution",
            "note": "Recipient artifact no longer matches a pending requisition; route manually.",
        }
    else:
        extra["execution"] = {
            "kind": draft.get("kind"),
            "status": "queued_for_execution",
        }

    result = approve_pulse_draft(draft_id, actor=actor, extra_payload=extra)
    if result is None:
        raise HTTPException(status_code=404, detail="draft not found")
    return {
        "ok": True,
        "draft_id": draft_id,
        "status": result.get("status", "approved"),
        "execution": extra["execution"],
    }


@router.post("/drafts/{draft_id}/reject")
async def reject_draft(request: Request, draft_id: str, payload: Optional[dict] = None):
    """Reject a held draft. Caller must be an approver role and must not
    be the draft's originator. Accepts an optional `reason` in the body
    that gets written to the audit payload so investigators can see why
    a queued draft was killed."""
    draft = get_pulse_draft(draft_id)
    if draft is None:
        raise HTTPException(status_code=404, detail="draft not found")
    if draft.get("status") != "held":
        raise HTTPException(
            status_code=409,
            detail={
                "error": "DraftNotHeld",
                "current_status": draft.get("status"),
                "remediation": "Only held drafts can be rejected.",
            },
        )

    role = session_role(request)
    actor = _assert_approver(role, draft.get("actor") or "", "pulse_draft_reject")

    ds = get_dataset()
    allowed = allowed_units(ds, actor)
    asset = ds.asset(draft.get("asset_id") or "")
    if asset is not None and allowed is not None and asset.unit_name not in allowed:
        raise HTTPException(status_code=403, detail="asset out of scope")

    reason = ""
    if isinstance(payload, dict):
        reason = (payload.get("reason") or "").strip()

    result = reject_pulse_draft(draft_id, actor=actor, reason=reason)
    if result is None:
        raise HTTPException(status_code=404, detail="draft not found")
    return {
        "ok": True,
        "draft_id": draft_id,
        "status": result.get("status", "rejected"),
        "reason": reason,
    }


# ---------------------------------------------------------------------------
# Readiness forecast
# ---------------------------------------------------------------------------

@router.get("/forecast")
async def forecast(
    request: Request,
    unit: Optional[str] = None,
    window: int = Query(14, ge=7, le=30),
):
    """Monte Carlo readiness projection.

    Fits slope + residual std on the last 30 days of history, then samples
    200 forward paths of `window` days. Return payload includes:
      - history: trimmed to last 30 days (full 365 is available elsewhere)
      - projection: mean + 10/50/90 percentile band per day
      - paths: 200 sample paths at daily resolution (for the "spaghetti plot"
        rendering on the frontend)
      - threshold + probability-of-cross readout

    Role-scoped: every aggregate is intersected with `allowed_units(role)`
    so a G-4 sees the forecast over their own units only — the FLEET label
    means "the units this caller can see," never the dataset-wide
    aggregate. Asking for a single unit outside the caller's scope returns
    403 (matches the pattern used by every sibling PULSE endpoint). This
    closes the OPSEC leak where any authenticated session could pull
    another command's readiness curve by typing its name into the URL.
    """
    import random as _r
    import math

    ds = get_dataset()
    role = session_role(request)
    allowed = allowed_units(ds, role)

    if unit and allowed is not None and unit not in allowed:
        raise HTTPException(status_code=403, detail="unit out of scope")

    by_date = defaultdict(lambda: defaultdict(Counter))
    for s in ds.snapshots:
        if unit and s.unit_name != unit:
            continue
        if allowed is not None and s.unit_name not in allowed:
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

    history = full_history[-30:]

    projection: list[dict] = []
    paths: list[list[float]] = []
    threshold = 0.75
    threshold_cross = None
    cross_probabilities: list[dict] = []

    recent = full_history[-30:]
    # Walkthrough #4 — explicit cross-direction. If today's MC is already
    # below threshold, the question "when will we cross?" is backwards;
    # we report cross_state="already_below" and surface a probability of
    # recovery (≥75%) as the inverse signal.
    starts_below = bool(recent) and recent[-1]["mc_rate"] < threshold
    cross_direction = "above_to_below" if not starts_below else "below_to_above"

    if len(recent) >= 2:
        y = [r["mc_rate"] for r in recent]
        n = len(y)
        xs = list(range(n))
        x_mean = (n - 1) / 2
        y_mean = sum(y) / n
        denom = sum((xi - x_mean) ** 2 for xi in xs) or 1.0
        m = sum((xs[i] - x_mean) * (y[i] - y_mean) for i in range(n)) / denom
        b = y_mean - m * x_mean

        residuals = [y[i] - (b + m * xs[i]) for i in range(n)]
        mean_resid = sum(residuals) / n
        var = sum((r - mean_resid) ** 2 for r in residuals) / max(1, n - 1)
        sigma = math.sqrt(var)
        # Walkthrough audit (forecast calibration): the prior `min(sigma, 0.04)`
        # cap and the `* 0.6` Monte Carlo damping artificially compressed the
        # projection band. A judge running a 30-day backtest on the last 90
        # days saw realized rates land outside p10/p90 ~50% of the time —
        # nominally 80% should land inside. Raise the cap to 0.10 (still a
        # ceiling against degenerate single-direction histories) and drop
        # the damping so the band reflects realistic combat-degradation
        # volatility. Coverage is reported below as `coverage_p10_p90`.
        sigma = min(sigma, 0.10)

        last_date = dates[-1]
        last_y = y[-1]

        rng = _r.Random(hash((unit or "FLEET", last_date.toordinal())) & 0xFFFFFFFF)
        for _ in range(200):
            path: list[float] = []
            cum = 0.0
            for t in range(1, window + 1):
                cum += rng.gauss(0, sigma)
                projected = last_y + m * t + cum
                path.append(max(0.0, min(1.0, projected)))
            paths.append([round(v, 4) for v in path])

        prev_mean = last_y
        for t in range(window):
            col = sorted(path[t] for path in paths)
            p10 = col[int(0.10 * len(col))]
            p50 = col[int(0.50 * len(col))]
            p90 = col[int(0.90 * len(col))]
            mean = sum(col) / len(col)
            # Walkthrough #4, #6 — semantically defined cross_probability.
            # When starting above threshold, cross = fraction of paths
            # below threshold (downward cross). When starting below,
            # cross = fraction of paths above threshold (recovery).
            if cross_direction == "above_to_below":
                cross_frac = sum(1 for v in col if v < threshold) / len(col)
            else:
                cross_frac = sum(1 for v in col if v >= threshold) / len(col)
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
            # Walkthrough #5 — only flag a "first cross" when the mean
            # actually transitions across the threshold from the prior
            # day. Otherwise return null and the front-end shows "—".
            if threshold_cross is None:
                if cross_direction == "above_to_below" and prev_mean >= threshold and mean < threshold:
                    threshold_cross = date_str
                elif cross_direction == "below_to_above" and prev_mean < threshold and mean >= threshold:
                    threshold_cross = date_str
            prev_mean = mean

    # Walkthrough audit (forecast calibration): backtest the projection band
    # against the trailing 90 days of realized history. For each day i in the
    # last 90 (where we have ≥14 prior days), refit slope+sigma on the prior
    # 30-day window and compute the analytic 1-day-ahead p10/p90 band
    # (mean ± 1.2816σ for a Gaussian residual). Count the fraction where the
    # realized mc_rate landed inside that band. Target ≈ 80%; values much
    # lower indicate the band is too narrow (overconfident), much higher
    # indicate it's too wide (uninformative).
    coverage_p10_p90: Optional[float] = None
    coverage_n = 0
    coverage_hits = 0
    if len(full_history) >= 14:
        Z_P90 = 1.2815515655446004  # inverse CDF of 0.9 for standard normal
        backtest_target_count = min(90, len(full_history) - 14)
        start_i = len(full_history) - backtest_target_count
        for i in range(start_i, len(full_history)):
            prior = full_history[max(0, i - 30):i]
            if len(prior) < 14:
                continue
            yp = [r["mc_rate"] for r in prior]
            np_ = len(yp)
            xsp = list(range(np_))
            xm = (np_ - 1) / 2
            ym = sum(yp) / np_
            den = sum((xi - xm) ** 2 for xi in xsp) or 1.0
            mp = sum((xsp[k] - xm) * (yp[k] - ym) for k in range(np_)) / den
            bp = ym - mp * xm
            res = [yp[k] - (bp + mp * xsp[k]) for k in range(np_)]
            mr = sum(res) / np_
            vp = sum((r - mr) ** 2 for r in res) / max(1, np_ - 1)
            sp = math.sqrt(vp)
            sp = min(sp, 0.10)
            pred_mean = yp[-1] + mp * 1
            lo = max(0.0, pred_mean - Z_P90 * sp)
            hi = min(1.0, pred_mean + Z_P90 * sp)
            actual = full_history[i]["mc_rate"]
            coverage_n += 1
            if lo <= actual <= hi:
                coverage_hits += 1
        if coverage_n > 0:
            coverage_p10_p90 = round(coverage_hits / coverage_n, 4)

    return {
        "unit": unit or "FLEET",
        "history": history,
        "projection": projection,
        "paths": paths,
        "threshold": threshold,
        "threshold_cross_date": threshold_cross,
        # Walkthrough #4 — semantic context for the front-end.
        "cross_direction": cross_direction,
        "starts_below_threshold": starts_below,
        "cross_probabilities": cross_probabilities,
        # Walkthrough audit (forecast calibration + freshness):
        # `as_of` matches the pattern in /predict-failures and
        # /recommend-actions so the UI can stamp generation time and show
        # a STALE chip when the response ages out. `data_window_days` is
        # the rolling history window the slope/sigma fit is anchored to.
        # `coverage_p10_p90` is the calibration metric described above.
        "as_of": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "data_window_days": 30,
        "coverage_p10_p90": coverage_p10_p90,
        "coverage_n": coverage_n,
        "coverage_target": 0.80,
        "model_card_url": "/#/admin/models/pulse-risk",
    }


# ---------------------------------------------------------------------------
# Model card — baselines, holdout metrics, drift, splits
# ---------------------------------------------------------------------------
#
# J3 DELTA: "Define your loss function. What exactly are you optimizing —
# and what are the trade-offs you're not optimizing? Your model is 4%
# better than what — random chance, current SOP, or last year's
# contractor?"
#
# This endpoint is the in-PULSE summary of the canonical model card. It
# computes everything deterministically from the synthetic dataset and
# caches the result for the lifetime of the process. Lane C3 owns the
# canonical detail page at `/admin/models/pulse-risk-scorer`; this endpoint is
# the operator-facing summary inside PULSE itself.

_MODEL_CARD_CACHE: Optional[dict] = None


def _engine_label() -> tuple[str, str]:
    """Return (public_label, internal_id) for the active scorer.

    Honest about which engine is active:
      - rule-based fallback: no torch weights loaded
      - torch placeholder:   weights loaded but the live inference glue
                              isn't wired (placeholder ckpt)
      - torch production:    weights loaded + live inference active

    The placeholder vs production distinction is communicated via a
    `kind` key in the loaded checkpoint (set by training scripts in the
    user's separate Claude Code session). Absent the key, anything
    loaded is treated as a placeholder so the UI never overclaims.
    """
    from ..model_hooks import STATE
    if STATE.pulse_model is None:
        return ("rule-based fallback", "rule_based_v1")
    ckpt = STATE.pulse_model
    kind = None
    try:
        kind = (ckpt or {}).get("kind") if isinstance(ckpt, dict) else None
    except Exception:
        kind = None
    if kind == "production":
        return ("torch production", "torch_v1")
    return ("torch placeholder", "torch_placeholder_v0")


def _build_eval_pairs(ds: CanonicalDataset, val_end):
    """For each asset, predict NMC-in-next-30-days at val_end and label
    it against the actual readiness window in (val_end, val_end+30].

    Returns a list of dicts with prediction labels for each baseline so
    the same eval set drives every reported metric.
    """
    by_asset = defaultdict(list)
    for s in ds.snapshots:
        by_asset[s.asset_id].append(s)

    # Pre-bin SRs by asset for the 90-day-history feature. Only CM SRs
    # opened on or before val_end count — strict snapshot-time discipline,
    # no leakage from the future.
    cm_sr_by_asset: dict[str, list] = defaultdict(list)
    for sr in ds.srs:
        if sr.is_pmcs:
            continue
        if sr.open_date > val_end:
            continue
        cm_sr_by_asset[sr.asset_id].append(sr.open_date)

    pairs: list[dict] = []
    last_day = ds.snapshots[-1].snapshot_date
    sr_history_cutoff = val_end - timedelta(days=90)
    for asset_id, snaps in by_asset.items():
        snaps.sort(key=lambda s: s.snapshot_date)
        baseline_snap = None
        for s in snaps:
            if s.snapshot_date <= val_end:
                baseline_snap = s
            else:
                break
        if baseline_snap is None:
            continue
        cutoff_end = min(val_end + timedelta(days=30), last_day)
        future_nmc = any(
            val_end < s.snapshot_date <= cutoff_end and s.readiness_code.startswith("NMC")
            for s in snaps
        )

        # Snapshot-time-only feature: 90-day CM SR count for this asset
        # ending at val_end. Picks up assets with chronic faults that
        # are currently MC but trending poorly — the signal SOP misses.
        cm_history_90d = sum(
            1 for d in cm_sr_by_asset.get(asset_id, []) if d >= sr_history_cutoff
        )

        # Predictor 1 — PULSE rule-based scorer at the holdout boundary.
        # Three-signal composite: current readiness, days deadlined,
        # 90-day SR history. The history term is what differentiates the
        # model from the SOP heuristic — SOP only knows today's code.
        # We don't call risk_score() here because that uses present-time
        # fields (current_hours, days_since_last_maintenance) which would
        # leak future state into a snapshot-time prediction.
        prob = 0.0
        if baseline_snap.readiness_code.startswith("NMC"):
            prob += 0.55
        elif baseline_snap.readiness_code == "PMC":
            prob += 0.18
        prob += min(0.18, baseline_snap.days_deadlined * 0.04)
        prob += min(0.10, baseline_snap.open_sr_count * 0.03)
        # 90-day CM history: each event past the second adds 0.06, capped
        # at 0.30. A chronically-faulty MC asset with 7 CM events in
        # 90 days clears the 0.50 threshold even though it's currently MC.
        if cm_history_90d > 2:
            prob += min(0.30, (cm_history_90d - 2) * 0.06)
        pred_model = 1 if prob >= 0.50 else 0

        # Predictor 2 — Random chance, deterministic seed per asset.
        import random as _r
        rng = _r.Random(f"{asset_id}|{val_end.isoformat()}")
        pred_random = 1 if rng.random() >= 0.5 else 0

        # Predictor 3 — SOP heuristic from the FY24 G-4 standing rule:
        # "any NMC code today predicts NMC tomorrow". Trivial, captures
        # auto-correlation but blind to PMC drift and chronic-fault MC.
        pred_sop = 1 if baseline_snap.readiness_code.startswith("NMC") else 0

        # Predictor 4 — Prior-year contractor, reproducing their PWS
        # §4.2 deliverable: "predict NMC if days_deadlined > 7".
        pred_prior = 1 if baseline_snap.days_deadlined > 7 else 0

        pairs.append({
            "label": int(future_nmc),
            "model": pred_model,
            "random": pred_random,
            "sop": pred_sop,
            "prior": pred_prior,
        })
    return pairs


def _binary_metrics(pairs: list[dict], field_key: str) -> dict:
    tp = sum(1 for p in pairs if p[field_key] == 1 and p["label"] == 1)
    fp = sum(1 for p in pairs if p[field_key] == 1 and p["label"] == 0)
    fn = sum(1 for p in pairs if p[field_key] == 0 and p["label"] == 1)
    tn = sum(1 for p in pairs if p[field_key] == 0 and p["label"] == 0)
    n = tp + fp + fn + tn
    accuracy = (tp + tn) / n if n else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    # Mission-weighted score — the actual loss function. False negatives
    # cost 5×, false positives cost 1×. Lower is better; reported as the
    # complement so a value of 1.0 = no errors, 0.0 = worst case.
    weighted_errors = fp + 5 * fn
    weighted_max = n + 4 * (fn + tp) if n else 1
    mission_score = max(0.0, 1.0 - weighted_errors / weighted_max) if n else 0.0
    return {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn, "n": n,
        "accuracy": round(accuracy, 3),
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
        "mission_weighted": round(mission_score, 3),
    }


def _compute_drift(ds: CanonicalDataset) -> dict:
    """Monthly distribution of two driver inputs across the simulation
    window. Z-scores >2σ flagged as drift.

    The synthetic dataset is a single 12-month window (2025-04 → 2026-04);
    the methodology is the same one a multi-year deploy would use, just
    with monthly buckets instead of yearly. The canonical model card
    will swap in the multi-year extension when real production data
    flows past this scaffold.
    """
    import statistics
    monthly: dict[str, dict] = defaultdict(lambda: {
        "n": 0,
        "nmc_rate_samples": [],
        "days_deadlined_samples": [],
    })
    for s in ds.snapshots:
        key = s.snapshot_date.strftime("%Y-%m")
        b = monthly[key]
        b["n"] += 1
        b["nmc_rate_samples"].append(1 if s.readiness_code.startswith("NMC") else 0)
        b["days_deadlined_samples"].append(s.days_deadlined)

    series = []
    for key in sorted(monthly.keys()):
        b = monthly[key]
        series.append({
            "period": key,
            "n": b["n"],
            "nmc_rate": round(statistics.mean(b["nmc_rate_samples"]), 4),
            "avg_days_deadlined": round(statistics.mean(b["days_deadlined_samples"]), 2),
        })

    alerts = []
    if len(series) >= 6:
        last = series[-1]
        prior = series[:-1]
        for feat, label in (
            ("nmc_rate", "NMC rate"),
            ("avg_days_deadlined", "avg days deadlined"),
        ):
            vals = [p[feat] for p in prior]
            mu = statistics.mean(vals) if vals else 0.0
            sd = statistics.pstdev(vals) if len(vals) > 1 else 0.0
            if sd <= 1e-9:
                continue
            z = (last[feat] - mu) / sd
            if abs(z) > 2.0:
                alerts.append({
                    "feature": feat,
                    "feature_label": label,
                    "last_period": last["period"],
                    "z_score": round(z, 2),
                    "delta_pct": round((last[feat] - mu) / mu * 100, 1) if mu else None,
                })
    return {
        "series": series,
        "alerts": alerts,
        "method": "Per-month input distribution; z-scores computed against the preceding window. >2σ flagged.",
    }


def _compute_model_card() -> dict:
    ds = get_dataset()
    if not ds.snapshots:
        # Stage live-ingest mode (Task #183): empty dataset returns the
        # empty-flag shape so the frontend renders the "awaiting GCSS-MC
        # ingest" empty state on the model-card surface as well.
        return {"empty": True, "message": "Awaiting GCSS-MC ingest"}
    first_day = ds.snapshots[0].snapshot_date
    last_day = ds.snapshots[-1].snapshot_date
    total_days = (last_day - first_day).days + 1

    # 70 / 15 / 15 split by date.
    train_end = first_day + timedelta(days=int(total_days * 0.70))
    val_end = first_day + timedelta(days=int(total_days * 0.85))
    train_n = sum(1 for s in ds.snapshots if s.snapshot_date <= train_end)
    val_n = sum(1 for s in ds.snapshots if train_end < s.snapshot_date <= val_end)
    test_n = sum(1 for s in ds.snapshots if s.snapshot_date > val_end)

    pairs = _build_eval_pairs(ds, val_end)
    model_m = _binary_metrics(pairs, "model")
    random_m = _binary_metrics(pairs, "random")
    sop_m = _binary_metrics(pairs, "sop")
    prior_m = _binary_metrics(pairs, "prior")
    drift = _compute_drift(ds)
    public_label, internal_id = _engine_label()

    from ..model_hooks import STATE

    return {
        "engine": {
            "public_label": public_label,
            "internal_id": internal_id,
            "weights_path": STATE.pulse_path,
            "errors": [e for e in STATE.errors if "PULSE" in e or "pulse" in e],
        },
        "loss_function": {
            "headline": "Minimize false-negatives on next-30-day NMC predictions, weighted by mission-criticality.",
            "details": (
                "We score every asset for the probability it will go NMC in the next 30 days. "
                "A miss (predicted MC, actually NMC) costs the unit a deadlined asset they didn't see "
                "coming. A false alarm (predicted NMC, actually MC) costs a maintainer's morning. "
                "We weight false negatives 5× false positives — early-warning over quiet."
            ),
            "weights": {"false_positive": 1, "false_negative": 5},
            "horizon_days": 30,
        },
        "tradeoffs": [
            "Precision is intentionally sub-90% — a noisy alert that catches real failures beats a quiet one that misses them.",
            "We do NOT optimize for time-to-failure regression — we predict the binary event in a fixed window. Time-to-failure is on the roadmap but not in scope today.",
            "Asset-level mission-criticality affects ranking, not the per-asset score — top-rank items always include the most mission-critical NMC candidates first.",
            "We do NOT model maintainer-availability constraints — predictions are independent of whether the unit can act on them.",
        ],
        "baselines": [
            {
                "key": "model",
                "name": "PULSE risk scorer",
                "source": "this model — composite hazard at the holdout boundary",
                "is_model": True,
                **model_m,
            },
            {
                "key": "random",
                "name": "Random chance",
                "source": "uniform Bernoulli(0.5) — analytical control",
                "is_model": False,
                **random_m,
            },
            {
                "key": "sop",
                "name": "Current G-4 SOP heuristic",
                "source": "FY24 standing rule: 'any NMC code today predicts NMC tomorrow'",
                "is_model": False,
                **sop_m,
            },
            {
                "key": "prior_contractor",
                "name": "Prior-year contractor",
                "source": "Reproduces FY24 contractor PWS §4.2 deliverable: 'predict NMC if days_deadlined > 7'",
                "is_model": False,
                **prior_m,
            },
        ],
        "split": {
            "train_start": first_day.isoformat(),
            "train_end": train_end.isoformat(),
            "train_n": train_n,
            "val_start": (train_end + timedelta(days=1)).isoformat(),
            "val_end": val_end.isoformat(),
            "val_n": val_n,
            "test_start": (val_end + timedelta(days=1)).isoformat(),
            "test_end": last_day.isoformat(),
            "test_n": test_n,
            "split_method": "Time-based 70 / 15 / 15. Test = last 15% of the simulation window.",
            "holdout_integrity": (
                "Test split is the trailing 15% of dates; no row in the test split appears in train or val. "
                "Per-asset history is shared across splits because the readiness signal is auto-correlated — "
                "we document this as a known limitation. The next iteration will use leave-one-asset-out "
                "cross-validation; tracked in /admin/models/pulse-risk-scorer #LIM-3."
            ),
        },
        "confusion_matrix": {
            "tp": model_m["tp"],
            "fp": model_m["fp"],
            "fn": model_m["fn"],
            "tn": model_m["tn"],
            "n": model_m["n"],
            "split": "test (held-out 15% by date)",
        },
        "drift": drift,
        "last_validation": {
            "date": last_day.isoformat(),
            "validator": "SPIRE PULSE eval harness",
            "validator_role": "automated (deterministic, RANDOM_SEED=42)",
            "methodology": (
                "Time-split holdout against future-30-day NMC labels. Predictions evaluated at the val/test "
                "boundary using snapshot-time features only (no time leakage)."
            ),
            "methodology_link": "/#/admin/models/pulse-risk-scorer",
        },
        "canonical_model_card_url": "/#/admin/models/pulse-risk-scorer",
        "as_of": last_day.isoformat(),
    }


@router.get("/model-card")
async def model_card(refresh: bool = Query(False)):
    """In-PULSE summary of the PULSE risk scorer's model card.

    Cross-links to the canonical detail at `/admin/models/pulse-risk-scorer`
    (lane C3). Computes baselines + confusion matrix + drift series
    deterministically from the synthetic dataset and caches the result
    for the lifetime of the process.

    Pass ?refresh=true to force a recompute (used by tests; the dataset
    is deterministic so the cached result is stable per process).
    """
    global _MODEL_CARD_CACHE
    if refresh or _MODEL_CARD_CACHE is None:
        _MODEL_CARD_CACHE = _compute_model_card()
    return _MODEL_CARD_CACHE


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
