"""
Context-appropriate sensitive data injection into maintenance remarks.

All values are SYNTHETIC:
  - MGRS coords are inside the unit's realistic operating area but are fake
    points never tied to real facilities
  - Frequencies use the TAD / training net ranges, not live tactical freqs
  - COMSEC device serial numbers are prefixed "USMC-" + synthetic sequence
  - Classified TM references are pure placeholders (TM XX-XXXX-XXX-XX-X)
  - EDIPIs and SSN last-4 come from personnel.py's synthetic generators

The module exposes inject_sensitive_data(), which mutates a remark string
by layering in context-appropriate sensitive elements based on the fault,
the asset, and the rules in config.SENSITIVITY_RULES.
"""
from __future__ import annotations

import random
from typing import List, Tuple

from config import MGRS_BY_AREA, SENSITIVITY_RULES

# Synthetic frequency / callsign / COMSEC pools -- not real tactical nets.
TAD_FREQS_MHZ = ["30.050", "34.125", "38.900", "41.250", "44.800", "46.175", "49.625"]
SATCOM_CHANNELS = ["UHF-3425", "UHF-3719", "UHF-4102", "UHF-4588"]
COMSEC_DEVICES = ["KGV-72", "KGV-136B", "KG-175D", "KIV-7M"]
CALLSIGNS = ["RAIDER", "STEEL", "BANDIT", "WARHOG", "PHOENIX", "KILO-6", "VIPER-2", "WATCHDOG-3"]
NET_IDS = ["BN TAC", "CO OPS", "BN COC", "REGT CMD", "LOG ADMIN"]


# ---------------------------------------------------------------------------
# Sensitive-element generators
# ---------------------------------------------------------------------------

def make_mgrs(location: str, rng: random.Random) -> str:
    """Generate a plausible-for-the-area MGRS 10-digit grid coordinate."""
    area = MGRS_BY_AREA.get(location)
    if area is None:
        # Fallback: CONUS East generic
        area = MGRS_BY_AREA["Camp Lejeune, NC"]
    easting = rng.randint(*area["easting_range"])
    northing = rng.randint(*area["northing_range"])
    return f"{area['grid_zone']} {area['square']} {easting:05d} {northing:05d}"


def make_comsec_reference(rng: random.Random, seq: int) -> str:
    device = rng.choice(COMSEC_DEVICES)
    return f"{device} S/N USMC-{seq:05d}"


def make_net_reference(rng: random.Random) -> str:
    freq = rng.choice(TAD_FREQS_MHZ)
    net = rng.choice(NET_IDS)
    return f"on {net} Net {freq} MHz"


def make_satcom_reference(rng: random.Random) -> str:
    return f"SATCOM channel {rng.choice(SATCOM_CHANNELS)}"


def make_callsign(rng: random.Random) -> str:
    return rng.choice(CALLSIGNS)


def make_poc_line(mechanic, rng: random.Random) -> Tuple[str, str]:
    """Return (poc_text, flavor_key). Mechanic is a personnel.Marine."""
    r = rng.random()
    flavors = SENSITIVITY_RULES["pii"]["flavors"]
    if r < flavors["name_ext"]:
        return f"POC: {mechanic.display} / ext {mechanic.phone_ext}", "pii_name_ext"
    elif r < flavors["name_ext"] + flavors["name_edipi"]:
        return f"POC: {mechanic.display} / EDIPI {mechanic.edipi}", "pii_name_edipi"
    else:
        return f"POC: {mechanic.display} / SSN last4 {mechanic.ssn_last4}", "pii_name_ssn4"


def make_controlled_serial(equipment_type: str, rng: random.Random) -> str:
    prefix = {
        "M1A1_ABRAMS": "USA",
        "HIMARS": "USMC-HMR",
        "AN_TPS80_GATOR": "USMC-RAD",
        "AN_TPQ36_FIREFINDER": "USMC-FFD",
    }.get(equipment_type, "USMC")
    return f"S/N {prefix}-{rng.randint(10000, 99999)}"


# ---------------------------------------------------------------------------
# Injection
# ---------------------------------------------------------------------------

def inject_sensitive_data(
    base_remark: str,
    asset,
    fault_event,
    mechanic,
    current_date,
    rng: random.Random,
    seq: int,
) -> Tuple[str, List[str], str]:
    """Apply context-appropriate sensitive injections.

    Returns (rendered_remark, sensitive_flags, ground_truth_classification).
    sensitive_flags is a list of category tags the SENTRY classifier will
    learn to detect: 'pii', 'geo', 'comms', 'classified', 'controlled'.
    ground_truth_classification is one of UNCLASSIFIED / CUI / CONFIDENTIAL / SECRET
    which the classification engine later validates against source marking.
    """
    text = base_remark
    flags: List[str] = []

    # ---- PII (POC line) ----
    if rng.random() < SENSITIVITY_RULES["pii"]["probability"]:
        poc_line, flavor = make_poc_line(mechanic, rng)
        text = f"{text} {poc_line}"
        flags.append("pii")

    # ---- Grid coordinates (only when deployed / field exercise) ----
    geo_rule = SENSITIVITY_RULES["grid_coords"]
    if asset.deployment_status in geo_rule["trigger_deployment_status"]:
        if rng.random() < geo_rule["probability"]:
            grid = make_mgrs(asset.location, rng)
            if rng.random() < 0.5:
                text = f"Location: {grid}. {text}"
            else:
                text = f"{text} Location: {grid}."
            flags.append("geo")

    # ---- Communications refs (comms-component faults or radar/firefinder) ----
    comms_rule = SENSITIVITY_RULES["comms"]
    triggered_by_equip = asset.equipment_type in comms_rule["trigger_equipment_types"]
    triggered_by_component = fault_event.component in comms_rule["trigger_fault_component"]
    if (triggered_by_equip or triggered_by_component) and rng.random() < comms_rule["probability"]:
        kind = rng.randint(0, 2)
        if kind == 0:
            text = f"{text} Reported {make_net_reference(rng)} to BN COC."
        elif kind == 1:
            text = f"{text} {make_comsec_reference(rng, seq)} tested post-repair."
        else:
            text = f"{text} Relay station callsign {make_callsign(rng)} verified comms path, {make_satcom_reference(rng)}."
        flags.append("comms")

    # ---- Classified TM (deterministic when fault.classified) ----
    if fault_event.classified:
        flags.append("classified")

    # ---- Controlled item serials ----
    ctrl = SENSITIVITY_RULES["controlled_serial"]
    if asset.equipment_type in ctrl["trigger_equipment_types"] and rng.random() < ctrl["probability"]:
        text = f"{text} {make_controlled_serial(asset.equipment_type, rng)} per DA Form 2062."
        flags.append("controlled")

    # ---- Ground-truth classification derived from flags ----
    classification = derive_classification(flags, fault_event)

    return text, flags, classification


def derive_classification(flags: List[str], fault_event) -> str:
    """
    Classification logic per MDM v3 spec layer 3:
      classified TM                    -> SECRET
      COMSEC / EW params               -> SECRET (subset of comms here)
      fire-control / weapon internals  -> CONFIDENTIAL minimum
      grid, comms, PII, controlled     -> CUI
      none                             -> UNCLASSIFIED
    """
    if "classified" in flags:
        return "SECRET"
    if fault_event.component in ("fire_control", "weapon_system") and "classified" not in flags:
        return "CONFIDENTIAL"
    if any(f in flags for f in ("geo", "comms", "pii", "controlled")):
        return "CUI"
    return "UNCLASSIFIED"


if __name__ == "__main__":
    rng = random.Random(42)
    print("Sample MGRS by area:")
    for area in ["Camp Lejeune, NC", "Camp Pendleton, CA", "Camp Kinser, Okinawa", "MCAS Yuma, AZ"]:
        print(f"  {area}: {make_mgrs(area, rng)}")
    print(f"\nSample COMSEC: {make_comsec_reference(rng, 1234)}")
    print(f"Sample net ref: {make_net_reference(rng)}")
    print(f"Sample controlled serial (M1A1): {make_controlled_serial('M1A1_ABRAMS', rng)}")
