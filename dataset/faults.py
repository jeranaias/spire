"""
Fault injection -- probabilistic trigger driven by the asset's operating
profile and the per-fault-type probability tables in equipment_profiles.json.

Returns a FaultEvent describing which fault triggered, so lifecycle.py can
open a Service Request against the asset.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Optional

from config import FAULT_PROBABILITY_SCALE

DATA_DIR = Path(__file__).parent / "data"

with open(DATA_DIR / "equipment_profiles.json", encoding="utf-8") as f:
    EQUIPMENT_PROFILES: dict = json.load(f)


@dataclass
class FaultEvent:
    """A triggered fault ready to be turned into a Service Request."""
    fault_id: str
    component: str
    description: str
    defect_code: tuple
    condition_impact: str  # "Deadlined" / "Degraded" / "Minor" / "Supply" / "Service"
    avg_repair_hours: int
    avg_parts_cost: float
    parts_needed: list
    tm_reference: str
    classified: bool
    maintenance_level: str
    remark_templates: list
    triggered_on: date

    @classmethod
    def from_profile(cls, fault_profile: dict, day: date) -> "FaultEvent":
        return cls(
            fault_id=fault_profile["id"],
            component=fault_profile["component"],
            description=fault_profile["description"],
            defect_code=tuple(fault_profile["defect_code"]),
            condition_impact=fault_profile["condition_impact"],
            avg_repair_hours=fault_profile["avg_repair_hours"],
            avg_parts_cost=fault_profile["avg_parts_cost"],
            parts_needed=list(fault_profile["parts_needed"]),
            tm_reference=fault_profile["tm_reference"],
            classified=fault_profile.get("classified", False),
            maintenance_level=fault_profile.get("maintenance_level", "Organizational"),
            remark_templates=list(fault_profile["remark_templates"]),
            triggered_on=day,
        )


def _daily_probability(fault: dict, asset) -> float:
    """Convert the fault's per-1000-unit probability into today's probability
    given the asset's miles or hours accrued today."""
    if "probability_per_1000_miles" in fault:
        per_unit = fault["probability_per_1000_miles"] / 1000.0
        driver = asset.miles_today
    elif "probability_per_1000_hours" in fault:
        per_unit = fault["probability_per_1000_hours"] / 1000.0
        driver = asset.hours_today
    else:
        return 0.0
    return per_unit * max(0.0, driver)


def _threshold_met(fault: dict, asset) -> bool:
    if "min_miles_before_occurrence" in fault:
        if asset.current_miles < fault["min_miles_before_occurrence"]:
            return False
    if "min_hours_before_occurrence" in fault:
        if asset.current_hours < fault["min_hours_before_occurrence"]:
            return False
    return True


def _age_modifier(asset, current_date: date) -> float:
    """Older equipment faults more often. 10% per year."""
    years = (current_date - asset.fielding_date).days / 365.0
    return 1.0 + years * 0.10


def _post_maintenance_modifier(asset) -> float:
    """Recently-serviced equipment faults less. Half-odds inside 30 days."""
    return 0.30 if asset.days_since_last_maintenance < 30 else 1.0


def check_for_fault(asset, current_date: date, rng: random.Random) -> Optional[FaultEvent]:
    """Walk the asset's fault catalog in declared order; the first fault whose
    probability trial succeeds is the one that fires today. At most one
    corrective fault per asset per day (matches reality -- Marines rarely log
    two unrelated CM SRs same day)."""
    profile = EQUIPMENT_PROFILES.get(asset.equipment_type)
    if profile is None:
        return None

    age_mod = _age_modifier(asset, current_date)
    maint_mod = _post_maintenance_modifier(asset)

    # Local copy — shuffling the shared list would reorder the catalog for
    # every future asset's check in this same simulation day.
    faults = list(profile["faults"])
    rng.shuffle(faults)

    for fault in faults:
        if not _threshold_met(fault, asset):
            continue
        p = _daily_probability(fault, asset) * age_mod * maint_mod * FAULT_PROBABILITY_SCALE
        if p <= 0:
            continue
        if rng.random() < p:
            return FaultEvent.from_profile(fault, current_date)

    return None


def fleet_fault_incidence_summary(rng: random.Random) -> dict:
    """Sanity check: for each equipment type, what is the expected number of
    fault events per 1000 miles/hours? Used for calibration."""
    summary = {}
    for eq_type, profile in EQUIPMENT_PROFILES.items():
        totals = []
        for f in profile["faults"]:
            if "probability_per_1000_miles" in f:
                totals.append((f["id"], f["probability_per_1000_miles"], "mi"))
            elif "probability_per_1000_hours" in f:
                totals.append((f["id"], f["probability_per_1000_hours"], "hr"))
        summary[eq_type] = totals
    return summary


if __name__ == "__main__":
    summary = fleet_fault_incidence_summary(random.Random(0))
    print("Fault incidence per 1000 operating units (from profiles):")
    for eq, faults in summary.items():
        total = sum(p for _, p, _ in faults)
        print(f"  {eq:<22}: {total:5.2f} events/1000 -- {len(faults)} fault types")
