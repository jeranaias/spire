"""
Risk-score computation + derivations used across PULSE endpoints.

Mirrors spec §PULSE:Layer-2 weighting (hours-since-service 0.25, fault
frequency 0.25, severity trend 0.20, days NMC 0.15, age 0.10, cost trend
0.05). Rule-based for deterministic explainability; the trained
HawkStack 8K predictor will later plug in as an alternate scorer.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import timedelta
from statistics import mean
from typing import Optional

from .state import CanonicalDataset, snapshots_for_asset, srs_for_asset


# Equipment-type mean hours between service (days). Pulled from
# equipment_profiles.json mean fields where available.
MEAN_BETWEEN_SERVICE = {
    "JLTV": 90, "MTVR_CARGO": 85, "MTVR_WRECKER": 90, "LVSR": 95,
    "TRAILER_M1095": 120, "MEP_803A": 60, "M1A1_ABRAMS": 50,
    "M88A2_RECOVERY": 70, "MRAP_RG31": 80, "LAV_25": 60, "LAV_AT": 60,
    "MV22B_OSPREY": 30, "CH53E_STALLION": 30, "HIMARS": 65,
    "AN_TPS80_GATOR": 40, "AN_TPQ36_FIREFINDER": 45,
    "D7G_DOZER": 75, "TRAM": 85, "ROWPU": 50,
}


def _fleet_average_fault_rate(ds: CanonicalDataset, equipment_type: str) -> float:
    """Average number of CM SRs opened in the last 180 days across every asset
    of this equipment type. Used as the baseline a specific asset gets
    compared against."""
    counts = []
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    if last_day is None:
        return 0.0
    cutoff = last_day - timedelta(days=180)
    by_asset = defaultdict(int)
    for sr in ds.srs:
        if sr.is_pmcs:
            continue
        if sr.equipment_type != equipment_type:
            continue
        if sr.open_date < cutoff:
            continue
        by_asset[sr.asset_id] += 1
    if not by_asset:
        return 0.0
    return mean(by_asset.values())


def _count_faults_in_window(ds: CanonicalDataset, asset_id: str, window_days: int) -> int:
    if not ds.snapshots:
        return 0
    last_day = ds.snapshots[-1].snapshot_date
    cutoff = last_day - timedelta(days=window_days)
    return sum(
        1
        for sr in ds.srs
        if sr.asset_id == asset_id and not sr.is_pmcs and sr.open_date >= cutoff
    )


def _severity_escalation(ds: CanonicalDataset, asset_id: str) -> float:
    """Score rises if the asset's recent faults trend toward higher
    maintenance levels (Org → Intermediate → Depot)."""
    history = [sr for sr in srs_for_asset(ds, asset_id) if not sr.is_pmcs]
    if len(history) < 2:
        return 0.0
    level_score = {"Organizational": 1, "Intermediate": 2, "Depot": 3}
    score = [level_score.get(sr.maintenance_level, 1) for sr in history[-6:]]
    if len(score) < 2:
        return 0.0
    return max(0.0, score[-1] - score[0]) / 2.0  # normalized 0-1


def _days_nmc_fraction(ds: CanonicalDataset, asset_id: str) -> float:
    snaps = snapshots_for_asset(ds, asset_id)
    if not snaps:
        return 0.0
    nmc = sum(1 for s in snaps if s.readiness_code.startswith("NMC"))
    return nmc / len(snaps)


def _age_factor(ds: CanonicalDataset, asset_id: str) -> float:
    asset = ds.asset(asset_id)
    if asset is None:
        return 0.0
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else asset.fielding_date
    years = (last_day - asset.fielding_date).days / 365.0
    return min(1.0, years / 7.0)  # 7+ years = max


def _cost_trend(ds: CanonicalDataset, asset_id: str) -> float:
    """Approximate cost trend by comparing recent SR parts cost vs.
    lifetime mean for this asset."""
    srs = [sr for sr in srs_for_asset(ds, asset_id) if not sr.is_pmcs and sr.parts_cost_actual > 0]
    if len(srs) < 3:
        return 0.0
    recent = srs[-3:]
    baseline = srs[:-3] or srs
    r_mean = mean(s.parts_cost_actual for s in recent)
    b_mean = mean(s.parts_cost_actual for s in baseline) or 1.0
    return max(0.0, min(1.0, (r_mean / b_mean - 1.0)))


def risk_score(ds: CanonicalDataset, asset_id: str) -> dict:
    """Return the full scored breakdown for one asset."""
    asset = ds.asset(asset_id)
    if asset is None:
        return {"error": "asset not found"}

    # Factor 1: hours since last service vs fleet mean
    mean_days = MEAN_BETWEEN_SERVICE.get(asset.equipment_type, 90)
    hours_factor = min(1.0, asset.days_since_last_maintenance / (mean_days * 1.5))

    # Factor 2: fault frequency vs fleet average
    asset_faults = _count_faults_in_window(ds, asset_id, 180)
    fleet_avg = _fleet_average_fault_rate(ds, asset.equipment_type) or 1.0
    freq_factor = min(1.0, asset_faults / (fleet_avg * 3.0))

    # Factor 3: severity escalation
    sev_factor = _severity_escalation(ds, asset_id)

    # Factor 4: days NMC fraction
    nmc_factor = min(1.0, _days_nmc_fraction(ds, asset_id) / 0.3)

    # Factor 5: age + usage
    age_factor = _age_factor(ds, asset_id)

    # Factor 6: parts cost trend
    cost_factor = _cost_trend(ds, asset_id)

    weights = {
        "hours": 0.25,
        "fault_freq": 0.25,
        "severity": 0.20,
        "nmc": 0.15,
        "age": 0.10,
        "cost": 0.05,
    }

    score = 100 * (
        weights["hours"] * hours_factor
        + weights["fault_freq"] * freq_factor
        + weights["severity"] * sev_factor
        + weights["nmc"] * nmc_factor
        + weights["age"] * age_factor
        + weights["cost"] * cost_factor
    )
    score = round(score, 1)

    # Primary factor — the single contributor with largest weighted contribution
    contribs = [
        ("Hours since last service", weights["hours"] * hours_factor, hours_factor),
        ("Fault frequency", weights["fault_freq"] * freq_factor, freq_factor),
        ("Severity escalation trend", weights["severity"] * sev_factor, sev_factor),
        ("Days NMC history", weights["nmc"] * nmc_factor, nmc_factor),
        ("Age / usage", weights["age"] * age_factor, age_factor),
        ("Parts cost trend", weights["cost"] * cost_factor, cost_factor),
    ]
    contribs.sort(key=lambda t: t[1], reverse=True)
    primary = contribs[0][0]

    # Predicted next failure heuristic
    pred = None
    if score >= 76:
        horizon = 14
        pred = f"Failure within {horizon} days"
    elif score >= 51:
        horizon = 30
        pred = f"Degradation within {horizon} days"

    return {
        "asset_id": asset_id,
        "risk_score": score,
        "band": _band(score),
        "primary_factor": primary,
        "contributing_factors": [
            {"factor": f, "weighted": round(w, 3), "raw": round(r, 3)} for f, w, r in contribs
        ],
        "predicted_failure": pred,
        "equipment_type": asset.equipment_type,
        "unit_name": asset.unit_name,
    }


def _band(score: float) -> str:
    if score >= 76:
        return "CRITICAL"
    if score >= 51:
        return "HIGH"
    if score >= 26:
        return "MODERATE"
    return "LOW"


def score_all(ds: CanonicalDataset) -> list[dict]:
    """Score every asset (slow: ~350 × scoring)."""
    # Insufficient-data threshold: need >= 3 CM events in last 12 months
    scored = []
    for asset in ds.assets:
        cm_events_12mo = _count_faults_in_window(ds, asset.asset_id, 365)
        if cm_events_12mo < 3:
            scored.append({
                "asset_id": asset.asset_id,
                "risk_score": None,
                "band": "INSUFFICIENT_DATA",
                "primary_factor": f"Insufficient data — {cm_events_12mo} CM events in last 12 months, 3 required",
                "contributing_factors": [],
                "predicted_failure": None,
                "equipment_type": asset.equipment_type,
                "unit_name": asset.unit_name,
            })
            continue
        scored.append(risk_score(ds, asset.asset_id))
    return scored


def top_risk(ds: CanonicalDataset, n: int = 20) -> list[dict]:
    scored = [s for s in score_all(ds) if s["risk_score"] is not None]
    scored.sort(key=lambda s: s["risk_score"], reverse=True)
    return scored[:n]
