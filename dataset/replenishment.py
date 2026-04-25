"""
Replenishment action rates + scoring primitives.

Backs the GC-1 autonomous replenishment planner. Loads the inspectable
`replenishment_rates.json` and exposes scoring helpers so the backend's
/pulse/recommend-actions endpoint can rank cannibalize / expedite /
cross-level / redistribute options per risk-board asset.

The rates are order-of-magnitude plausible, not authoritative DLA
numbers — the hackathon dataset is synthetic. Production would pull
these from real DLA/MILSTRIP sources.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

DATA_PATH = Path(__file__).parent / "data" / "replenishment_rates.json"


@dataclass(frozen=True)
class ActionOption:
    """One candidate action the planner can recommend for an asset."""
    kind: str                       # "cannibalize" | "expedite" | "cross_level" | "redistribute"
    description: str                # Human-readable summary
    cost_usd: float                 # Best-effort total cost in dollars
    time_to_effect_hours: int       # Expected hours until readiness uplift lands
    mc_delta_pct: float             # Expected MC% delta if executed (0-100 scale)
    confidence: float               # 0-1: planner's confidence in the uplift estimate
    requires_approval_roles: list[str]
    risk_note: str = ""


def _load() -> dict:
    with open(DATA_PATH, encoding="utf-8") as f:
        return json.load(f)


_CACHE: Optional[dict] = None


def rates() -> dict:
    global _CACHE
    if _CACHE is None:
        _CACHE = _load()
    return _CACHE


def cannibalize_cost(labor_hours_override: Optional[int] = None) -> float:
    r = rates()["action_types"]["cannibalize"]
    hours = labor_hours_override if labor_hours_override is not None else r["base_labor_hours"]
    labor = hours * r["labor_rate_per_hour"]
    return round(labor * (1 + r["admin_overhead_pct"]), 2)


def expedite_cost(tier: str) -> tuple[float, int]:
    """Return (fee_usd, days) for an expedite tier."""
    tiers = rates()["action_types"]["expedite"]["fee_tiers"]
    if tier not in tiers:
        raise ValueError(f"unknown expedite tier {tier!r}")
    t = tiers[tier]
    return float(t["fee_usd"]), int(t["days"])


def cross_level_cost(distance_mi: float, hazmat: bool = False) -> tuple[float, int]:
    """Return (cost_usd, time_to_effect_hours) for a cross-level move."""
    r = rates()["action_types"]["cross_level"]
    transport = distance_mi * r["per_mile_transport_cost_usd"]
    labor = r["handler_labor_hours"] * r["labor_rate_per_hour"]
    total = transport + labor
    if hazmat:
        total *= 1 + r["hazmat_surcharge_pct"]
    # Time scales with distance but clamps to range
    lo, hi = r["time_to_effect_hours_range"]
    hours = max(lo, min(hi, int(24 + distance_mi / 400 * 12)))
    return round(total, 2), hours


def lead_time_for_nsn(nsn: str, criticality: str = "mission_essential") -> tuple[str, int]:
    """Return (supply_path, mean_days) for a given NSN prefix, adjusted
    by criticality. Falls back to 'medium' / 17 days if no match.
    """
    overrides = rates()["lead_time_overrides"]
    mults = rates()["criticality_multipliers"]
    mult = mults.get(criticality, 1.0)
    # Match by NSN prefix (first two segments)
    prefix = "-".join(nsn.split("-")[:2]) if "-" in nsn else nsn[:7]
    if prefix in overrides:
        o = overrides[prefix]
        return o["supply_path"], int(o["mean_days"] * mult)
    return "medium", int(17 * mult)


def convoy_feasible(origin: str, destination: str) -> Optional[dict]:
    """Look up convoy feasibility (distance, risk, hazmat, mode) for a
    garrison-to-garrison move. None if route is not modeled — indicates
    AMC airlift or a special-case approval is needed."""
    key = f"{origin} → {destination}"
    return rates()["convoy_feasibility"].get(key)
