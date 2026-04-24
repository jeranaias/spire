"""
Maintenance remark generator -- fills fault-template strings with realistic
parameter values and applies Marine-voice normalizations. Remarks are the
primary SENTRY input surface so this module is what makes the dataset
linguistically believable.

The generator drives sensitive.py for classification-label ground truth.

A lightweight post-processor then introduces shop-voice variance:
  - typo drift (~5% of remarks get 1 character-swap / drop)
  - abbreviation swap (~15% swap a long word for its shop shorthand)
  - trailing informal phrase (~5% append a mechanic's note)
  - dropped punctuation (~5% lose the final period)
These perturbations make the corpus pattern-matcher resistant without
changing the semantic content that SENTRY is trained to classify.
"""
from __future__ import annotations

import random
from typing import Tuple

from sensitive import inject_sensitive_data


# Long-form -> Marine shop abbreviation dictionary applied probabilistically.
SHOP_ABBREVS = {
    "vehicle": "veh",
    "Vehicle": "Veh",
    "approximately": "approx",
    "Approximately": "Approx",
    "quantity": "qty",
    "maintenance": "maint",
    "Maintenance": "Maint",
    "replaced": "replcd",
    "inspection": "insp",
    "inspected": "inspected",
    "operation": "ops",
    "operations": "ops",
    "reference": "ref",
    "per the": "per",
}

TRAILING_NOTES = [
    " RTS.",
    " Veh cleared for service.",
    " No further action required.",
    " Close out per {tm_ref}.",
    " PLL stock reordered.",
    " Copy to Cpl {rng_name}.",
    " Same squawk as last month.",
    " Checked twice before closing.",
    "",
    "",
    "",
]

TYPO_TARGETS = [
    ("replaced", "replced"),
    ("inspected", "insepcted"),
    ("checked", "chcked"),
    ("failed", "faield"),
    ("found", "foudn"),
    ("system", "sysetm"),
    ("leaking", "leakng"),
    ("replaced", "replased"),
    ("serviced", "servied"),
]


# Static template-fill pools -- tunable without changing fault-profile JSON.
PARAM_POOLS = {
    "leak_rate":        ["1/2 qt", "1 qt", "2 cups", "steady drip", "small puddle"],
    "leak_rate_hydro":  ["1 qt/hr", "2 qt/hr", "steady weep", "0.5 qt/hr"],
    "tire_position":    ["LF", "RF", "LR", "RR"],
    "position":         ["front", "rear"],
    "axle":             ["front", "rear", "all"],
    "side":             ["left", "right"],
    "ima_unit":         ["1st Maint Bn IMA", "2d Maint Bn IMA", "MCLB Albany", "MCLB Barstow"],
    "subsystem":        ["GPS/INS", "laser rangefinder", "thermal channel", "ballistic computer"],
    "range":            [800, 1000, 1500, 2000],
}


def _pool_picker(rng: random.Random):
    return lambda key: rng.choice(PARAM_POOLS[key])


def _build_params(rng: random.Random, mechanic, fault_event) -> dict:
    pick = _pool_picker(rng)
    params = {
        # references and personnel
        "tm_ref": fault_event.tm_reference,
        "mechanic": mechanic.display + f" ext {mechanic.phone_ext}",
        # quantities with realistic units
        "leak_rate": pick("leak_rate"),
        "leak_rate_hydro": pick("leak_rate_hydro"),
        "tire_psi": rng.choice([30, 35, 40, 45]),
        "tire_position": pick("tire_position"),
        "hose_count": rng.randint(1, 3),
        "voltage": round(rng.uniform(18.0, 22.0), 1),
        "battery_months": rng.randint(18, 48),
        "alt_amps": rng.randint(30, 55),
        "spec_amps": 90,
        "pad_mm": round(rng.uniform(0.5, 2.5), 1),
        "position": pick("position"),
        "axle": pick("axle"),
        "side": pick("side"),
        "tension_in": round(rng.uniform(2.0, 4.0), 1),
        "spec_tension": 2.5,
        "shoe_count": rng.randint(2, 8),
        "throw_count": rng.randint(1, 4),
        "egt_temp": rng.randint(850, 1050),
        "max_egt": 800,
        "boost_psi": rng.randint(5, 12),
        "normal_boost": 22,
        "cycle_time": round(rng.uniform(8.0, 15.0), 1),
        "spec_time": 5.0,
        "flow_rate": round(rng.uniform(1.5, 3.0), 1),
        "pressure": rng.randint(2800, 3200),
        "spec_pressure": 3000,
        "runtime_hours": round(rng.uniform(4.0, 18.0), 1),
        "affected_elements": rng.randint(2, 12),
        "error_code": f"E-{rng.randint(100, 999)}",
        "subsystem": pick("subsystem"),
        "deflection": round(rng.uniform(0.3, 1.2), 1),
        "ima_unit": pick("ima_unit"),
        "range": pick("range"),
        "test_miles": rng.randint(5, 25),
        "seq": rng.randint(10000, 99999),
        "param_desc": rng.choice([
            f"showing {rng.uniform(1.5, 4.0):.1f} mil drift at 1000m",
            f"thermal channel misaligned by {rng.uniform(0.05, 0.2):.2f} degrees",
            f"laser rangefinder reading {rng.uniform(5, 25):.0f}m error at calibration distance",
        ]),
    }
    return params


def generate_remark(
    fault_event,
    asset,
    mechanic,
    current_date,
    rng: random.Random,
    seq: int,
) -> Tuple[str, list, str]:
    """Render a maintenance remark from a fault template and apply sensitive
    data injection. Returns (text, sensitive_flags, classification)."""
    template = rng.choice(fault_event.remark_templates)
    params = _build_params(rng, mechanic, fault_event)

    # Fill template; leave unknown placeholders visible for debugging (shouldn't happen).
    remark = template
    for key, value in params.items():
        remark = remark.replace(f"{{{key}}}", str(value))

    # Shop-voice perturbations BEFORE sensitive injection so grids / comms
    # references remain canonical (the classifier needs stable tokens for
    # those categories). Typos only touch ordinary maintenance vocabulary.
    remark = _apply_shop_voice(remark, rng)

    # Sensitive data injection (classification labels derived here too).
    remark, flags, classification = inject_sensitive_data(
        remark, asset, fault_event, mechanic, current_date, rng, seq,
    )
    return remark, flags, classification


def _apply_shop_voice(remark: str, rng: random.Random) -> str:
    """Inject realistic shop-floor messiness into a remark. Each perturbation
    is independently sampled; on average a given remark gets 0-2 edits."""
    # Typo (5%)
    if rng.random() < 0.05:
        word, typo = rng.choice(TYPO_TARGETS)
        if word in remark and rng.random() < 0.8:
            remark = remark.replace(word, typo, 1)

    # Abbreviation swap (15%)
    if rng.random() < 0.15:
        long_forms = [k for k in SHOP_ABBREVS if k in remark]
        if long_forms:
            pick = rng.choice(long_forms)
            remark = remark.replace(pick, SHOP_ABBREVS[pick], 1)

    # Trailing informal phrase (5%)
    if rng.random() < 0.05:
        remark = remark.rstrip() + rng.choice(TRAILING_NOTES)

    # Dropped final period (5%)
    if rng.random() < 0.05 and remark.endswith("."):
        remark = remark[:-1]

    return remark


if __name__ == "__main__":
    import datetime as dt
    from config import RANDOM_SEED
    from fleet import generate_fleet
    from personnel import generate_personnel
    from faults import check_for_fault

    rng = random.Random(RANDOM_SEED)
    units, assets = generate_fleet(RANDOM_SEED)
    roster = generate_personnel(units, 200, RANDOM_SEED)

    # Force-drive a few assets to produce faults and render sample remarks.
    samples = 0
    for a in assets[:80]:
        a.current_miles = 25000
        a.current_hours = 1500
        a.miles_today = 120
        a.hours_today = 8
        a.days_since_last_maintenance = 180
        fe = check_for_fault(a, dt.date(2025, 9, 15), rng)
        if not fe:
            continue
        mech = roster[rng.randint(0, len(roster) - 1)]
        text, flags, cls = generate_remark(fe, a, mech, dt.date(2025, 9, 15), rng, seq=samples + 1)
        print(f"[{cls}] flags={flags}")
        print(f"  {a.equipment_type} SN {a.serial_number}")
        print(f"  {text[:240]}")
        print()
        samples += 1
        if samples >= 4:
            break
