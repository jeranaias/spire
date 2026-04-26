"""
BASTION multi-stream mock data. Represents what a real installation
commander would see in a unified pane: gate access, utilities, weather.

For the hackathon the streams are rule-generated against the canonical
dataset time window so everything lines up with PULSE readiness (no
timestamp drift). Real deployments would plug in:
  - PACS (Physical Access Control System) for gate access
  - SCADA / BMS for utility telemetry
  - NASA FIRMS or local weather station for meteorological
  - Giant Voice / MassNotification system for alerting
"""
from __future__ import annotations

import random
from datetime import datetime, timedelta
from typing import Any


_VEHICLE_DESCS = [
    "white box truck", "black SUV", "silver sedan", "blue pickup", "red van",
    "rental cargo van", "tradesman flatbed", "local taxi", "ride-share sedan",
]
_PLATE_PATTERNS = [
    "NC-{a}{b}{c}-{d}{e}{f}{g}",
    "VA-{a}{b}{c}{d}-{e}{f}",
    "SC-{a}{b}{c}{d}-{e}{f}",
    "GOV-{a}{b}{c}{d}{e}{f}",
    "CONT-{a}{b}{c}{d}",
]


def _synth_plate(rng: random.Random) -> str:
    pattern = rng.choice(_PLATE_PATTERNS)
    fill = {k: rng.choice("ABCDEFGHJKLMNPRSTUVWXYZ" if i < 4 else "0123456789")
            for i, k in enumerate("abcdefg")}
    try:
        return pattern.format(**fill)
    except KeyError:
        return f"NC-{rng.randint(100, 999)}-{rng.randint(1000, 9999)}"


def gate_access_events(dataset, seed: int = 7) -> list[dict]:
    """Synthetic gate-access anomaly stream. Rules:
      - After-hours vehicle attempt (2200-0500 at closed gates)
      - Repeated access denial from the same badge (~5% of events)
      - Commercial vehicle at personnel-only gate

    Each scenario kind has 3+ body templates with rotating vehicle types and
    deterministic synthetic plates so the live feed shows variety, not 5
    copies of the same row.
    """
    rng = random.Random(seed)
    if not dataset.snapshots:
        return []
    last_day = dataset.snapshots[-1].snapshot_date

    after_hours_bodies = [
        "{vehicle} (plate {plate}) attempted entry at ECP-4 (closed per FPCON BRAVO). Sentry turned away, logged plate and driver.",
        "{vehicle} ({plate}) approached ECP-2 0237L claiming wrong-gate navigation. Diverted to ECP-1, identity confirmed via sponsor.",
        "{vehicle} (plate {plate}) tested ECP-4 turnstile arm at 0114L. No badge presented; sentry initiated K-9 sweep, vehicle departed AOA.",
    ]
    repeat_denial_bodies = [
        "CAC read failed three times for the same badge holder at ECP-3. PMO advised holder contact RAPIDGate for renewal.",
        "{vehicle} ({plate}) refused three times at ECP-1 — sponsor company contract lapsed 14d ago. Driver advised to update DBIDS sponsorship.",
        "Visitor pass {plate} attempted ECP-2 access twice in 90s with mismatched escort. PMO held vehicle pending sponsor callback.",
    ]
    overflow_bodies = [
        "Contractor vehicle queue exceeded 12 at 0640. ECP-1 standby lane opened by Watchdog-1.",
        "Inbound commercial backed up to Westshore Rd at 0712 (32 vehicles). ECP-3 commercial lane manned, queue cleared in 14 min.",
        "Pre-rush surge at ECP-1: 22 trucks staged before 0530 for delivery window. Sponsoring units pre-cleared via DBIDS batch.",
    ]
    suspicious_bodies = [
        "{vehicle} ({plate}) loitered on perimeter road parallel to ECP-2 for 11 min before departing west. Plate logged for SR review.",
        "Drone-shaped silhouette photographed near ECP-4 fence line by sentry; subject vehicle ({vehicle}, {plate}) departed before contact.",
        "{vehicle} stopped on shoulder 80m short of ECP-1, occupant photographed signage. Driver complied with disperse order, plate {plate} logged.",
    ]

    scenarios = [
        ("Gate ECP-4: after-hours attempt at closed ECP", "MODERATE", after_hours_bodies),
        ("Gate ECP-3: repeat denial on expired credential", "LOW", repeat_denial_bodies),
        ("Gate ECP-1: commercial lane overflow", "LOW", overflow_bodies),
        ("Gate ECP-2: suspicious loitering near perimeter", "MODERATE", suspicious_bodies),
    ]

    events: list[dict] = []
    for i in range(8):
        day_offset = rng.randint(0, 6)
        hour = rng.choice([22, 23, 0, 1, 2, 3, 4])
        d = last_day - timedelta(days=day_offset)
        ts = datetime.combine(d, datetime.min.time()).replace(hour=hour, minute=rng.randint(0, 59))

        title, severity, body_pool = rng.choice(scenarios)
        body = rng.choice(body_pool).format(
            vehicle=rng.choice(_VEHICLE_DESCS),
            plate=_synth_plate(rng),
        )
        events.append({
            "id": f"gate-{i}",
            "source": "PACS",
            "severity": severity,
            "timestamp": ts.isoformat(timespec="seconds") + "Z",
            "title": title,
            "body": body,
            "stream": "gate_access",
        })
    return events


def utility_events(dataset, seed: int = 8) -> list[dict]:
    """Utility / SCADA-style advisories."""
    rng = random.Random(seed)
    if not dataset.snapshots:
        return []
    last_day = dataset.snapshots[-1].snapshot_date

    events: list[dict] = []
    pool = [
        {
            "title": "Water main pressure dip on Main 2",
            "severity": "LOW",
            "body": "Distribution pressure briefly dropped 12% on Main 2. Facilities investigated — demand spike, not leak.",
        },
        {
            "title": "Water main pressure dip on Main 4",
            "severity": "LOW",
            "body": "Pressure dip 8% on Main 4 during morning surge; recovered to nominal in 6 min. SCADA logged event for trend review.",
        },
        {
            "title": "Grid A load 94% of capacity — advisory",
            "severity": "MODERATE",
            "body": "Load on Grid A exceeded 90% threshold for 40 min during peak hour. Comm Node Alpha on backup ready.",
        },
        {
            "title": "Grid B load excursion — 88% sustained",
            "severity": "MODERATE",
            "body": "Grid B held 88% of capacity for 65 min with HVAC dominant. Load shed not required; advisory only.",
        },
        {
            "title": "Comm Node Bravo: jitter spike",
            "severity": "LOW",
            "body": "Comm Node Bravo reported elevated jitter on data plane for 18 min. Root cause: adjacent construction RF interference. Cleared.",
        },
        {
            "title": "Comm Node Charlie: brief link flap",
            "severity": "LOW",
            "body": "Charlie uplink flapped 4 times in 12 min before stabilizing. Carrier identified loose patch at MDF; reseated, link nominal.",
        },
        {
            "title": "Generator 1 transfer test pass",
            "severity": "LOW",
            "body": "Scheduled monthly generator transfer test: ATS switched Grid A → Gen-1 within 4 sec. Returned to utility power after 30 min.",
        },
        {
            "title": "Generator 3 quarterly load bank PASS",
            "severity": "LOW",
            "body": "Gen-3 load bank held 1.0 PF at 75% rated load for 2 hours. Coolant temp peaked 92C, within margin. Returned to standby.",
        },
        {
            "title": "POL Fuel Farm: fuel quality sample PASS",
            "severity": "LOW",
            "body": "Weekly POL fuel sample returned within spec — particulate and water both nominal.",
        },
        {
            "title": "POL Fuel Farm: tank gauge variance",
            "severity": "LOW",
            "body": "Tank 4 ATG reported 1.2% variance vs manual stick; recalibration scheduled, no fuel loss indicated.",
        },
        {
            "title": "Storm-water lift station: wet-well alarm cleared",
            "severity": "LOW",
            "body": "LS-7 high-level alarm activated for 9 min during heavy rain band, drained naturally. No spillover.",
        },
        {
            "title": "HVAC chiller plant: condenser approach drift",
            "severity": "LOW",
            "body": "Chiller 2 condenser approach climbed 1.4F over 24h trend; tube-bundle cleaning queued for next service window.",
        },
    ]
    for i in range(4):
        day_offset = rng.randint(0, 5)
        d = last_day - timedelta(days=day_offset)
        ts = datetime.combine(d, datetime.min.time()).replace(hour=rng.randint(6, 20), minute=rng.randint(0, 59))
        scenario = rng.choice(pool)
        events.append({
            "id": f"util-{i}",
            "source": "SCADA",
            "severity": scenario["severity"],
            "timestamp": ts.isoformat(timespec="seconds") + "Z",
            "title": scenario["title"],
            "body": scenario["body"],
            "stream": "utility",
        })
    return events


def weather_events(dataset, seed: int = 9) -> list[dict]:
    """Synthetic weather / environmental advisories (mirrors NASA FIRMS +
    NWS advisory formats so we can plug in the real feeds post-hackathon)."""
    rng = random.Random(seed)
    if not dataset.snapshots:
        return []
    last_day = dataset.snapshots[-1].snapshot_date

    events: list[dict] = []
    pool = [
        {
            "title": "Coastal flood advisory — Onslow Bight until 2300",
            "severity": "MODERATE",
            "body": "NWS coastal flood advisory in effect for training areas east of the installation. Minor inundation on low-lying roads; motor pool drainage monitored.",
        },
        {
            "title": "Marine weather statement — 6ft seas offshore",
            "severity": "LOW",
            "body": "NWS marine statement: 6-8 ft seas in coastal training waters through 1800. Small-boat ops curtailed; range control notified.",
        },
        {
            "title": "FIRMS heat anomaly — 4 km N of perimeter",
            "severity": "LOW",
            "body": "NASA FIRMS satellite detected thermal anomaly (likely agricultural burn) 4 km NW of ECP-2. No smoke impact on installation airspace.",
        },
        {
            "title": "FIRMS hot pixel — 7 km SE of training area",
            "severity": "LOW",
            "body": "Single FIRMS hot pixel 7 km SE, persistent across 2 satellite passes; coordinated with state forestry, controlled burn confirmed.",
        },
        {
            "title": "Wind advisory — SW 30 gust 45 kt expected 1400-1900",
            "severity": "MODERATE",
            "body": "Sustained winds expected 30 kt with gusts to 45 kt this afternoon. HH-1 helipad operations on hold. Cranes secured per SOP.",
        },
        {
            "title": "Lightning watch — afternoon convection potential",
            "severity": "LOW",
            "body": "8km lightning watch in effect 1300-1700; outdoor lifts and fueling ops to suspend if 5km warning issued by base wx.",
        },
        {
            "title": "Heat advisory — heat index 105F+ through 1800",
            "severity": "MODERATE",
            "body": "Heat-index forecast crossed 105F threshold; commands directed to enforce work/rest cycles per TB MED 507. WBGT monitor staged.",
        },
        {
            "title": "Dense fog advisory — visibility <1/4 mi at airfield",
            "severity": "LOW",
            "body": "Predawn fog reduced field visibility below 1/4 mi for 70 min; flight ops on weather hold, ground convoy departures delayed.",
        },
    ]
    for i in range(3):
        day_offset = rng.randint(0, 4)
        d = last_day - timedelta(days=day_offset)
        ts = datetime.combine(d, datetime.min.time()).replace(hour=rng.randint(7, 18), minute=0)
        scenario = rng.choice(pool)
        events.append({
            "id": f"wx-{i}",
            "source": "WEATHER",
            "severity": scenario["severity"],
            "timestamp": ts.isoformat(timespec="seconds") + "Z",
            "title": scenario["title"],
            "body": scenario["body"],
            "stream": "weather",
        })
    return events


def all_streams(dataset) -> list[dict]:
    out: list[dict] = []
    out.extend(gate_access_events(dataset))
    out.extend(utility_events(dataset))
    out.extend(weather_events(dataset))
    return out
