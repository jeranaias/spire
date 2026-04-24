"""
Fleet generator — builds the fixed 350-asset fleet across 10 units.

Each asset gets a permanent identity that persists through the 365-day
simulation: UIC, serial number, NSN, TAMCN, fielding date, initial hours/miles
seeded by age, and empty maintenance history. The lifecycle module mutates
each asset's state as days tick forward.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from config import (
    OPTEMPO,
    PMCS_INTERVALS,
    SIMULATION_START_DATE,
)

DATA_DIR = Path(__file__).parent / "data"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_json(name: str) -> dict:
    with open(DATA_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def _random_date(start_iso: str, end_iso: str, rng: random.Random) -> date:
    start = date.fromisoformat(start_iso)
    end = date.fromisoformat(end_iso)
    delta = (end - start).days
    return start + timedelta(days=rng.randint(0, delta))


def _niin(rng: random.Random) -> str:
    """Generate a synthetic National Item Identification Number."""
    return f"{rng.randint(100, 999)}-{rng.randint(1000, 9999)}"


def _generate_nsn(fsc: str, rng: random.Random) -> str:
    """13-digit NSN (FSC 4 digits, US country code 01, NIIN 7 digits)."""
    return f"{fsc}-01-{_niin(rng)}"


def _generate_serial(equipment_type: str, fmt: str, fielding_year: int, seq: int, rng: random.Random) -> str:
    """Fill the equipment's serial-number template."""
    params = {
        "year": fielding_year % 100,
        "seq": seq,
        "lot": rng.randint(100, 9999),
        "mod": rng.randint(1, 9),
    }
    try:
        return fmt.format(**params)
    except (KeyError, IndexError):
        return f"{equipment_type[:4]}-{seq:05d}"


def _initial_hours_for_age(equipment_type: str, fielding_date: date, profile: dict, rng: random.Random) -> float:
    """Seed initial operating hours based on age at simulation start."""
    years_old = (SIMULATION_START_DATE - fielding_date).days / 365.0
    mean_hrs_per_year = {
        "wheeled": 350,
        "tracked": 250,
        "static": 450,
        "high": 600,     # aviation
        "medium": 400,
    }.get(profile.get("optempo_type", "wheeled"), 350)
    base = years_old * mean_hrs_per_year
    jitter = rng.uniform(0.7, 1.3)
    return round(max(0.0, base * jitter), 1)


def _initial_miles_for_age(equipment_type: str, fielding_date: date, profile: dict, rng: random.Random) -> int:
    """Seed initial odometer for wheeled/tracked vehicles (0 for static gear)."""
    optempo_type = profile.get("optempo_type", "wheeled")
    if optempo_type in ("static", "high"):
        return 0  # generators and aircraft tracked by hours only
    years_old = (SIMULATION_START_DATE - fielding_date).days / 365.0
    mean_miles_per_year = {"wheeled": 5000, "tracked": 1500, "medium": 4000}.get(optempo_type, 4000)
    base = years_old * mean_miles_per_year
    jitter = rng.uniform(0.7, 1.3)
    return int(max(0, base * jitter))


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Asset:
    asset_id: str
    equipment_type: str
    tamcn: str
    nsn: str
    serial_number: str
    nomenclature: str
    model: str
    fsc: str
    unit_uic: str
    unit_name: str
    unit_parent: str
    location: str
    optempo: str
    # Canonical deployment posture from the unit T/O&E. Never mutated.
    deployment_status: str
    fielding_date: date
    initial_hours: float
    initial_miles: int
    classification_risk: str
    # Mutable state updated by lifecycle.py each simulated day.
    current_deployment_status: str = ""  # today's effective status (field exercise overrides)
    current_hours: float = 0.0
    current_miles: int = 0
    current_status: str = "MC"  # MC / PMC / NMCM / NMCS
    days_in_current_status: int = 0
    days_nmc_last_12mo: int = 0
    nmc_events_last_12mo: int = 0
    open_srs: list = field(default_factory=list)
    maintenance_history: list = field(default_factory=list)
    pmcs_due_date: date = field(default_factory=lambda: SIMULATION_START_DATE)
    last_maintenance_date: date = field(default_factory=lambda: SIMULATION_START_DATE)
    days_since_last_maintenance: int = 0
    hours_today: float = 0.0
    miles_today: int = 0

    def __post_init__(self) -> None:
        self.current_hours = self.initial_hours
        self.current_miles = self.initial_miles
        self.current_deployment_status = self.deployment_status


@dataclass
class Unit:
    uic: str
    name: str
    parent: str
    location: str
    optempo: str
    deployment_status: str
    equipment_counts: dict  # equipment_type -> count
    assets: list = field(default_factory=list)


# ---------------------------------------------------------------------------
# Fleet assembly
# ---------------------------------------------------------------------------

def generate_fleet(seed: int) -> tuple[list[Unit], list[Asset]]:
    """Return (units, assets) lists for the full 10-unit fleet."""
    rng = random.Random(seed)
    structure = _load_json("unit_structure.json")
    profiles = _load_json("equipment_profiles.json")

    units: list[Unit] = []
    assets: list[Asset] = []

    for unit_def in structure["units"]:
        unit = Unit(
            uic=unit_def["uic"],
            name=unit_def["name"],
            parent=unit_def["parent"],
            location=unit_def["location"],
            optempo=unit_def["optempo"],
            deployment_status=unit_def["deployment_status"],
            equipment_counts={k: v["count"] for k, v in unit_def["equipment"].items()},
        )

        for equip_type, equip_def in unit_def["equipment"].items():
            profile = profiles.get(equip_type)
            if profile is None:
                raise ValueError(f"Missing profile for equipment type: {equip_type}")

            serial_fmt = profile.get("serial_format", "{seq:05d}")

            for i in range(equip_def["count"]):
                fielding = _random_date("2018-01-01", "2024-06-01", rng)
                serial = _generate_serial(equip_type, serial_fmt, fielding.year, rng.randint(100, 99999), rng)
                nsn = _generate_nsn(equip_def["fsc"], rng)
                asset_id = f"{unit.uic}-{equip_type}-{i+1:03d}"

                initial_hours = _initial_hours_for_age(equip_type, fielding, profile, rng)
                initial_miles = _initial_miles_for_age(equip_type, fielding, profile, rng)

                pmcs_jitter_days = rng.randint(0, PMCS_INTERVALS["B_CHECK"] - 1)

                asset = Asset(
                    asset_id=asset_id,
                    equipment_type=equip_type,
                    tamcn=equip_def["tamcn"],
                    nsn=nsn,
                    serial_number=serial,
                    nomenclature=profile["nomenclature"],
                    model=profile.get("model", ""),
                    fsc=equip_def["fsc"],
                    unit_uic=unit.uic,
                    unit_name=unit.name,
                    unit_parent=unit.parent,
                    location=unit.location,
                    optempo=unit.optempo,
                    deployment_status=unit.deployment_status,
                    fielding_date=fielding,
                    initial_hours=initial_hours,
                    initial_miles=initial_miles,
                    classification_risk=profile["classification_risk"],
                    pmcs_due_date=SIMULATION_START_DATE + timedelta(days=pmcs_jitter_days),
                )
                assets.append(asset)
                unit.assets.append(asset)

        units.append(unit)

    # Uniqueness invariants
    serials = [a.serial_number for a in assets]
    if len(serials) != len(set(serials)):
        duplicates = {s for s in serials if serials.count(s) > 1}
        raise ValueError(f"Duplicate serial numbers detected: {duplicates}")

    return units, assets


def summarize(units: list[Unit], assets: list[Asset]) -> None:
    print(f"Generated {len(units)} units, {len(assets)} assets.")
    for u in units:
        by_type = {}
        for a in u.assets:
            by_type[a.equipment_type] = by_type.get(a.equipment_type, 0) + 1
        print(f"  {u.name:<15} ({u.uic}): {len(u.assets)} assets -- {by_type}")


if __name__ == "__main__":
    from config import RANDOM_SEED

    units, assets = generate_fleet(RANDOM_SEED)
    summarize(units, assets)
