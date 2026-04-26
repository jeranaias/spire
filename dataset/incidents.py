"""
Installation incident log generator for BASTION.

Produces 100 realistic incidents over the 12-month simulation window at a
synthetic installation ("Camp Henderson"). The distribution skews mundane
(false fire alarms, POV accidents, medical) with a realistic sprinkle of
serious (UAS sightings, perimeter breaches, cyber) and rare critical events
(active threat, CBRN alarm). The 2d LAAD Bn UAS sighting that the demo
script triggers is NOT pre-seeded here -- BASTION injects that in real time
via the ThermalHawk sim.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import List, Optional

from config import SIMULATION_START_DATE, SIMULATION_DAYS, OUTPUT_TARGETS

DATA_DIR = Path(__file__).parent / "data"

INCIDENT_TYPES = {
    # Mundane (70%)
    "FALSE_FIRE_ALARM":    {"weight": 0.15, "severity": "LOW",      "rt": (5, 30)},
    "POV_ACCIDENT":        {"weight": 0.12, "severity": "LOW",      "rt": (10, 45)},
    "MEDICAL_EMERGENCY":   {"weight": 0.10, "severity": "MODERATE", "rt": (3, 15)},
    "DOMESTIC_DISTURBANCE":{"weight": 0.08, "severity": "LOW",      "rt": (8, 30)},
    "LARCENY_THEFT":       {"weight": 0.06, "severity": "LOW",      "rt": (15, 60)},
    "DUI_CHECKPOINT":      {"weight": 0.05, "severity": "LOW",      "rt": (10, 20)},
    "NOISE_COMPLAINT":     {"weight": 0.04, "severity": "LOW",      "rt": (15, 45)},
    "WILDLIFE_HAZARD":     {"weight": 0.05, "severity": "LOW",      "rt": (10, 30)},
    "UTILITY_FAILURE":     {"weight": 0.05, "severity": "MODERATE", "rt": (15, 120)},
    # Serious (25%)
    "PERIMETER_BREACH":    {"weight": 0.05, "severity": "HIGH",     "rt": (3, 15)},
    "UAS_SIGHTING":        {"weight": 0.04, "severity": "HIGH",     "rt": (2, 10)},
    "HAZMAT_SPILL":        {"weight": 0.04, "severity": "MODERATE", "rt": (10, 60)},
    "SUSPICIOUS_PACKAGE":  {"weight": 0.03, "severity": "HIGH",     "rt": (5, 20)},
    "STRUCTURAL_DAMAGE":   {"weight": 0.03, "severity": "MODERATE", "rt": (15, 45)},
    "CYBER_INCIDENT":      {"weight": 0.03, "severity": "HIGH",     "rt": (5, 30)},
    "WEAPONS_DISCHARGE":   {"weight": 0.02, "severity": "HIGH",     "rt": (2, 10)},
    # Critical (5%)
    "ACTIVE_THREAT":       {"weight": 0.01, "severity": "CRITICAL", "rt": (1, 5)},
    "CBRN_ALARM":          {"weight": 0.01, "severity": "CRITICAL", "rt": (2, 10)},
    "MAJOR_FIRE":          {"weight": 0.02, "severity": "CRITICAL", "rt": (3, 15)},
    "MASS_CASUALTY":       {"weight": 0.01, "severity": "CRITICAL", "rt": (2, 10)},
}

# Narrative templates per incident type -- short, realistic language for the
# initial report + resolution paragraphs a watch officer would see.
INCIDENT_NARRATIVES = {
    "FALSE_FIRE_ALARM": (
        "Fire alarm activated in {building}. No visible smoke or fire.",
        "Responding fire team found alarm triggered by {cause}. System reset, alarm cleared.",
    ),
    "POV_ACCIDENT": (
        "POV accident at intersection {grid}. Two vehicles involved, no injuries reported.",
        "PMO responded, both operators unhurt. Tow truck dispatched, report logged.",
    ),
    "MEDICAL_EMERGENCY": (
        "Service member collapsed at {building}, corpsman on scene requesting AMB.",
        "AMBULANCE-1 transported to BMC. Patient stable on arrival.",
    ),
    "DOMESTIC_DISTURBANCE": (
        "Complaint reported at {building}, verbal altercation between residents.",
        "PMO mediated, no charges filed. FAP notified for follow-up.",
    ),
    "LARCENY_THEFT": (
        "Personal property reported stolen from {building}. Estimated loss ${loss}.",
        "Report taken, NCIS notified for investigation.",
    ),
    "DUI_CHECKPOINT": (
        "Scheduled DUI checkpoint at {gate}.",
        "Routine ops -- {contacts} vehicles contacted, {citations} citations issued.",
    ),
    "NOISE_COMPLAINT": (
        "Noise complaint at {building}, loud music after 2200.",
        "PMO contacted residents, issue resolved on scene.",
    ),
    "WILDLIFE_HAZARD": (
        "Deer struck by vehicle on {road}, animal deceased on roadway.",
        "Wildlife officer coordinated removal. Roadway cleared.",
    ),
    "UTILITY_FAILURE": (
        "Power outage affecting {buildings}. Cause under investigation.",
        "Backup generators engaged where available. Grid restored at {time}.",
    ),
    "PERIMETER_BREACH": (
        "Motion sensor alarm on perimeter, grid {grid}. Possible unauthorized entry.",
        "PMO patrol responded, swept sector. {result}. FPCON posture confirmed.",
    ),
    "UAS_SIGHTING": (
        "Small quadcopter observed over {building}, altitude approximately {alt}ft AGL, heading {heading}.",
        "PMO responded, UAS departed airspace. Regional C-UAS coordinator notified. NCIS opened investigation.",
    ),
    "HAZMAT_SPILL": (
        "Hydraulic fluid spill at {building}, approximately {gallons} gal. HAZMAT team en route.",
        "CERBERUS-1 contained spill, materials bagged for disposal. Area decontaminated.",
    ),
    "SUSPICIOUS_PACKAGE": (
        "Unattended package reported at {building}. Area cordoned pending EOD sweep.",
        "IRONHORSE-2 cleared package -- contents {contents}. Cordon lifted after {min} minutes.",
    ),
    "STRUCTURAL_DAMAGE": (
        "{cause} damage reported at {building}. Facilities en route to assess.",
        "Engineers reviewed -- {assessment}. Area secured pending repair.",
    ),
    "CYBER_INCIDENT": (
        "Anomalous login activity detected on {system}. Account locked pending review.",
        "NMCI notified. User contacted, credentials rotated. No data exfiltration confirmed.",
    ),
    "WEAPONS_DISCHARGE": (
        "Weapons discharge reported in {location}. Investigation initiated.",
        "PMO + command investigation determined {cause}. NCIS involvement {ncis}.",
    ),
    "ACTIVE_THREAT": (
        "Reports of armed individual at {building}. Installation lockdown initiated.",
        "PMO + RAIDER-1 cleared area. {result}. Lockdown lifted after {min} minutes.",
    ),
    "CBRN_ALARM": (
        "CBRN detector alarm at {building}. Sector evacuated pending assessment.",
        "CERBERUS-1 and CBRN SME cleared -- {result}. All-clear given at {time}.",
    ),
    "MAJOR_FIRE": (
        "Structure fire reported at {building}. Multiple engines responding.",
        "SHIELD-1 + SHIELD-2 contained fire after {min} minutes. {damage}.",
    ),
    "MASS_CASUALTY": (
        "Multi-vehicle accident on {road}, multiple injuries reported.",
        "MCI triage on scene, {wounded} transported to BMC and off-base hospitals. {fatalities}.",
    ),
}

LOSS_AMOUNTS = [200, 450, 750, 1200, 2400, 3800, 5600]
RESULTS_OK = ["No intrusion confirmed", "No unauthorized personnel found", "Cleared -- animal activity"]
NCIS_INVOLVEMENT = ["confirmed", "not required", "pending legal review"]
STRUCTURAL_CAUSES = ["wind", "vehicle impact", "water leak", "roof material degradation"]
STRUCTURAL_ASSESSMENTS = ["no structural impact", "localized damage, repairs scheduled", "roof membrane failure"]
FIRE_CAUSES = ["cooking appliance", "HVAC electrical fault", "dryer lint ignition", "unknown origin"]


@dataclass
class Incident:
    incident_number: str
    date_time: datetime
    type: str
    severity: str
    location_building: str
    location_grid: str
    location_description: str
    initial_report: str
    fpcon_at_time: str
    fpcon_change: Optional[str]
    response_force: str
    response_time_minutes: int
    actions_taken: str
    casualties: int
    property_damage_usd: int
    resolution: str
    lessons_learned: str
    reported_by: str
    watch_officer: str


def _load_installation():
    with open(DATA_DIR / "installation_data.json", encoding="utf-8") as f:
        return json.load(f)


def _weighted_choice(options: dict, rng: random.Random) -> str:
    r = rng.random()
    acc = 0.0
    for key, meta in options.items():
        acc += meta["weight"]
        if r <= acc:
            return key
    return list(options.keys())[-1]


def _choose_building(installation: dict, itype: str, rng: random.Random) -> dict:
    buildings = installation["buildings"]
    if itype in ("FALSE_FIRE_ALARM", "MEDICAL_EMERGENCY", "DOMESTIC_DISTURBANCE"):
        candidates = [b for b in buildings if b["type"] in ("billeting", "housing", "support", "admin")]
    elif itype in ("UAS_SIGHTING", "SUSPICIOUS_PACKAGE"):
        candidates = [b for b in buildings if b["type"] in ("ammunition", "motor_pool", "communications", "fuel", "aviation")]
    elif itype == "HAZMAT_SPILL":
        candidates = [b for b in buildings if b.get("hazmat_present")]
    elif itype == "WEAPONS_DISCHARGE":
        candidates = [b for b in buildings if b["type"] in ("arms_storage", "training", "admin")]
    elif itype in ("MAJOR_FIRE", "STRUCTURAL_DAMAGE"):
        candidates = [b for b in buildings if b["floors"] > 0]
    elif itype == "CBRN_ALARM":
        candidates = [b for b in buildings if b["type"] in ("ammunition", "hazmat", "fuel")]
    elif itype == "UTILITY_FAILURE":
        candidates = [b for b in buildings if b["type"] in ("utility", "communications")]
    else:
        candidates = buildings
    return rng.choice(candidates) if candidates else rng.choice(buildings)


def _random_fpcon(rng: random.Random) -> str:
    return rng.choices(["NORMAL", "ALPHA", "BRAVO", "CHARLIE"], weights=[0.05, 0.10, 0.80, 0.05])[0]


def _fpcon_change_for(severity: str, rng: random.Random) -> Optional[str]:
    if severity == "CRITICAL":
        return "CHARLIE"
    if severity == "HIGH" and rng.random() < 0.35:
        return "CHARLIE"
    return None


def _fill_narrative(template: str, *, building: dict, itype: str, meta: dict, rng: random.Random) -> str:
    fill = {
        "building": building["name"],
        "grid": building["grid"],
        "cause": rng.choice(["cooking steam", "shower steam", "burned food", "dust from ceiling work"]) if itype == "FALSE_FIRE_ALARM" else rng.choice(FIRE_CAUSES if itype == "MAJOR_FIRE" else STRUCTURAL_CAUSES),
        "loss": rng.choice(LOSS_AMOUNTS),
        "gate": rng.choice(["ECP-1 Main Gate", "ECP-3 Courthouse Bay", "ECP-2 Piney Green"]),
        "contacts": rng.randint(40, 180),
        "citations": rng.randint(0, 6),
        "road": rng.choice(["Basilone Rd", "Vandegrift Blvd", "Harbor Dr", "McHugh Blvd"]),
        "buildings": rng.choice(["Barracks 200-204", "Motor Pool sector", "Family Housing Alpha"]),
        "time": rng.choice(["1415L", "0220L", "1847L", "2301L"]),
        "alt": rng.choice([150, 200, 250, 300, 400]),
        "heading": rng.choice(["E", "NE", "S", "SE", "NW"]),
        "gallons": rng.randint(3, 35),
        "contents": rng.choice(["lost luggage", "delivery misrouted", "non-hazardous gear", "personal effects"]),
        "min": rng.randint(15, 90),
        "result": rng.choice(RESULTS_OK),
        "assessment": rng.choice(STRUCTURAL_ASSESSMENTS),
        "system": rng.choice(["NMCI workstation", "MCEN enclave", "contractor VPN", "admin share"]),
        "location": rng.choice(["range control", "armory vicinity", "training area OP"]),
        "ncis": rng.choice(NCIS_INVOLVEMENT),
        "wounded": rng.randint(3, 12),
        "fatalities": rng.choice(["No fatalities reported.", "One fatality confirmed on scene."]),
        "damage": rng.choice(["Partial roof damage, one injured.", "Fire contained to single unit, no injuries.", "Significant structural impact, building red-tagged."]),
    }
    out = template
    for k, v in fill.items():
        out = out.replace(f"{{{k}}}", str(v))
    return out


def _build_watch_officer_pool(roster, units) -> dict:
    """Build a per-unit pool of watch-officer candidates from the canonical
    personnel roster. We pull officers (CWO2/3) and SNCOs (SSgt/GySgt/MSgt)
    so the SDO/OOD billet line reads like a real duty roster, not a fixed
    cycle of 4 names. Falls back to any roster entry if a unit has no
    officer/SNCO seats (shouldn't happen with the default 200-Marine roster
    but we degrade gracefully)."""
    by_unit: dict = {}
    duty_ranks = {"CWO2", "CWO3", "MSgt", "GySgt", "SSgt"}
    for unit in units:
        in_unit = [m for m in roster if m.unit_name == unit.name]
        eligible = [m for m in in_unit if m.rank in duty_ranks]
        if not eligible:
            eligible = in_unit or list(roster)
        by_unit[unit.name] = eligible
    return by_unit


def _format_watch_officer(marine, rng: random.Random) -> str:
    """Render an SDO/OOD line. CWO billets are SDO; SNCOs rotate SDO/OOD."""
    billet = "SDO" if marine.rank.startswith("CWO") else rng.choice(["SDO", "OOD"])
    return f"{marine.rank} {marine.last_name} {marine.first_initial}., {billet}"


def _resolve_unit_for_incident(building: dict) -> str:
    """Pick a unit whose footprint plausibly owns an incident at this building.
    Used to weight the watch-officer roster draw; falls back to None if the
    building can't be tied to a unit (we then sample uniformly across all
    units)."""
    name = building.get("name", "")
    # Match unit names that appear in the building name (e.g. "CLB-6 Motor Pool")
    candidates = ("CLB-6", "CLB-1", "3d Maint Bn", "2d Tank Bn", "2d LAR Bn",
                  "MALS-31", "MWSS-372", "2d LAAD Bn", "5/11 Marines", "7th ESB")
    for c in candidates:
        if c in name:
            return c
    return ""


def generate_incidents(seed: int, count: int = OUTPUT_TARGETS["incident_count"],
                       roster: Optional[List] = None, units: Optional[List] = None) -> List[Incident]:
    rng = random.Random(seed + 5)
    installation = _load_installation()
    start = SIMULATION_START_DATE
    incidents: List[Incident] = []

    # If roster + units are supplied, watch-officer names rotate through the
    # canonical roster filtered to officer/SNCO ranks, weighted by the unit
    # plausibly owning the incident's building. Without the roster we fall
    # back to the legacy 4-name cycle so existing call sites keep working.
    watch_pool = _build_watch_officer_pool(roster, units) if (roster and units) else None

    # Spread incidents across the 365-day window; some cluster (exercises,
    # storm events) but otherwise uniform.
    for i in range(count):
        day_offset = int(rng.random() * SIMULATION_DAYS)
        incident_date = start + timedelta(days=day_offset)
        hours = rng.randint(0, 23)
        minutes = rng.randint(0, 59)
        ts = datetime.combine(incident_date, time(hours, minutes))

        itype = _weighted_choice(INCIDENT_TYPES, rng)
        meta = INCIDENT_TYPES[itype]
        building = _choose_building(installation, itype, rng)

        fpcon = _random_fpcon(rng)
        change = _fpcon_change_for(meta["severity"], rng)
        rt = rng.randint(*meta["rt"])
        initial_tmpl, resolution_tmpl = INCIDENT_NARRATIVES[itype]
        initial = _fill_narrative(initial_tmpl, building=building, itype=itype, meta=meta, rng=rng)
        resolution = _fill_narrative(resolution_tmpl, building=building, itype=itype, meta=meta, rng=rng)

        casualties = {
            "LOW": 0 if rng.random() < 0.95 else 1,
            "MODERATE": rng.randint(0, 1),
            "HIGH": rng.randint(0, 2),
            "CRITICAL": rng.randint(1, 8),
        }[meta["severity"]]

        damage = {
            "LOW": rng.choice([0, 0, 0, 500, 1200]),
            "MODERATE": rng.randint(500, 12000),
            "HIGH": rng.randint(2000, 45000),
            "CRITICAL": rng.randint(15000, 250000),
        }[meta["severity"]]

        response_force = _assign_response_force(itype, rng)
        actions = _actions_for(itype, building, rng)
        lessons = _lessons_for(itype, rng)
        reporter = _reporter(rng)
        if watch_pool:
            owning_unit = _resolve_unit_for_incident(building)
            pool = watch_pool.get(owning_unit) if owning_unit else None
            if not pool:
                # Building doesn't tie to a unit (e.g. ECP / housing / utility)
                # — sample across the full SNCO/officer pool weighted by unit size.
                flat = []
                for marines in watch_pool.values():
                    flat.extend(marines)
                pool = flat or None
            if pool:
                watch_officer = _format_watch_officer(rng.choice(pool), rng)
            else:
                watch_officer = rng.choice([
                    "Capt Chen S., SDO", "Capt Vargas R., SDO",
                    "1stLt Park J., OOD", "1stLt Williams T., OOD",
                ])
        else:
            watch_officer = rng.choice([
                "Capt Chen S., SDO", "Capt Vargas R., SDO",
                "1stLt Park J., OOD", "1stLt Williams T., OOD",
            ])

        incident_num = f"INC-{incident_date.year}-{i+1:04d}"
        incidents.append(Incident(
            incident_number=incident_num,
            date_time=ts,
            type=itype,
            severity=meta["severity"],
            location_building=building["name"],
            location_grid=building["grid"],
            location_description=f"{building['name']} ({building['type']}), grid {building['grid']}",
            initial_report=initial,
            fpcon_at_time=fpcon,
            fpcon_change=change,
            response_force=response_force,
            response_time_minutes=rt,
            actions_taken=actions,
            casualties=casualties,
            property_damage_usd=damage,
            resolution=resolution,
            lessons_learned=lessons,
            reported_by=reporter,
            watch_officer=watch_officer,
        ))

    incidents.sort(key=lambda i: i.date_time)
    return incidents


def _assign_response_force(itype: str, rng: random.Random) -> str:
    families = {
        "FALSE_FIRE_ALARM": ["SHIELD-1", "SHIELD-2"],
        "MEDICAL_EMERGENCY": ["MEDIC-1", "WATCHDOG-1"],
        "MAJOR_FIRE": ["SHIELD-1 + SHIELD-2", "SHIELD-1 + MEDIC-1"],
        "HAZMAT_SPILL": ["CERBERUS-1", "CERBERUS-1 + SHIELD-1"],
        "SUSPICIOUS_PACKAGE": ["IRONHORSE-2", "IRONHORSE-2 + RAIDER-1"],
        "UAS_SIGHTING": ["WATCHDOG-3 + RAIDER-1", "WATCHDOG-1 + WATCHDOG-3"],
        "ACTIVE_THREAT": ["RAIDER-1 + WATCHDOG-1 + WATCHDOG-2", "RAIDER-1 + PMO All"],
        "CBRN_ALARM": ["CERBERUS-1 + RAIDER-1", "CERBERUS-1 + SHIELD-2"],
        "MASS_CASUALTY": ["MEDIC-1 + SHIELD-1 + RAIDER-1"],
        "PERIMETER_BREACH": ["WATCHDOG-2 + RAIDER-1", "WATCHDOG-1"],
        "WEAPONS_DISCHARGE": ["WATCHDOG-3 + RAIDER-1"],
        "CYBER_INCIDENT": ["NMCI Incident Response"],
    }
    options = families.get(itype, [f"WATCHDOG-{rng.randint(1, 4)}"])
    return rng.choice(options)


def _actions_for(itype: str, building: dict, rng: random.Random) -> str:
    if itype == "UAS_SIGHTING":
        return (f"Giant Voice activated. ECPs adjacent to {building['id']} locked down. "
                "QRF dispatched for visual confirmation. CCTV preserved. Regional C-UAS and NCIS notified.")
    if itype == "ACTIVE_THREAT":
        return ("Installation lockdown initiated, all ECPs closed. RAIDER-1 cleared sector. "
                "Giant Voice issued shelter-in-place, MCI team pre-staged.")
    if itype == "MAJOR_FIRE":
        return ("Evacuation order issued for affected building. Fire suppression initiated. "
                "Medical standby established. Facilities and safety representative responding.")
    if itype == "CBRN_ALARM":
        return ("Sector evacuated, ventilation secured, CBRN SME and HAZMAT team responding. "
                "FPCON elevation considered; installation CO notified.")
    if itype == "HAZMAT_SPILL":
        return ("Spill perimeter established, absorbents deployed, ventilation assessed. "
                "Environmental office notified, cleanup documented for reportable threshold.")
    if itype == "SUSPICIOUS_PACKAGE":
        return ("Cordon established 300m, EOD dispatched. Personnel in {building['id']} evacuated to rally point.")
    if itype == "PERIMETER_BREACH":
        return ("Sector swept by mounted patrol, CCTV reviewed, K9 team on standby. FPCON review initiated.")
    return "Standard response executed per installation EAP; incident logged and resolved on scene."


def _lessons_for(itype: str, rng: random.Random) -> str:
    options = {
        "UAS_SIGHTING": [
            "Sentry position 3 lacked night vision to track departure vector; recommend NVG issue at FPCON BRAVO+.",
            "Time from sighting to C-UAS coordinator contact was 11 min; target under 5.",
        ],
        "FALSE_FIRE_ALARM": [
            "Occupant accountability at RP exceeded 18 minutes; drill recommended.",
            "Panel reset procedure should be laminated at each alarm panel.",
        ],
        "PERIMETER_BREACH": [
            "Motion sensor false-alarm rate in Sector B trending up; recalibration required.",
        ],
        "HAZMAT_SPILL": [
            "Absorbent locker at motor pool was 40% depleted; restock protocol needs review.",
        ],
        "CYBER_INCIDENT": [
            "MFA fatigue pattern observed; push notifications to be replaced with number-match.",
        ],
    }
    return rng.choice(options.get(itype, ["Incident handled per SOP; no material lessons."]))


def _reporter(rng: random.Random) -> str:
    ranks = ["Sgt", "Cpl", "SSgt", "LCpl"]
    names = ["Rodriguez M.", "Smith T.", "Diaz R.", "Chen J.", "Williams D.", "Patel A."]
    return f"{rng.choice(ranks)} {rng.choice(names)}, Post Sentry"


if __name__ == "__main__":
    from config import RANDOM_SEED
    incidents = generate_incidents(RANDOM_SEED)
    print(f"Generated {len(incidents)} incidents.")
    from collections import Counter
    types = Counter(i.type for i in incidents)
    sevs = Counter(i.severity for i in incidents)
    print(f"Type distribution: {dict(types)}")
    print(f"Severity distribution: {dict(sevs)}")
    print("\nFirst 3 incidents:")
    for i in incidents[:3]:
        print(f"  {i.incident_number} {i.date_time} {i.type} ({i.severity}) @ {i.location_building}")
        print(f"    -> {i.initial_report[:160]}")
