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


def gate_access_events(dataset, seed: int = 7) -> list[dict]:
    """Synthetic gate-access anomaly stream. Rules:
      - After-hours vehicle attempt (2200-0500 at closed gates)
      - Repeated access denial from the same badge (~5% of events)
      - Commercial vehicle at personnel-only gate
    """
    rng = random.Random(seed)
    if not dataset.snapshots:
        return []
    last_day = dataset.snapshots[-1].snapshot_date

    events: list[dict] = []
    for i in range(8):
        day_offset = rng.randint(0, 6)
        hour = rng.choice([22, 23, 0, 1, 2, 3, 4])
        d = last_day - timedelta(days=day_offset)
        ts = datetime.combine(d, datetime.min.time()).replace(hour=hour, minute=rng.randint(0, 59))

        scenario = rng.choice([
            {
                "title": "Gate ECP-4: after-hours attempt at closed ECP",
                "severity": "MODERATE",
                "body": "Commercial vehicle attempted entry at ECP-4 (closed per FPCON BRAVO). Sentry turned away, logged plate and driver.",
            },
            {
                "title": "Gate ECP-3: repeat denial on expired credential",
                "severity": "LOW",
                "body": "CAC read failed three times for the same badge holder. PMO advised holder contact RAPIDGate for renewal.",
            },
            {
                "title": "Gate ECP-1: commercial lane overflow",
                "severity": "LOW",
                "body": "Contractor vehicle queue exceeded 12 at 0640. ECP-1 standby lane opened by Watchdog-1.",
            },
        ])
        events.append({
            "id": f"gate-{i}",
            "source": "PACS",
            "severity": scenario["severity"],
            "timestamp": ts.isoformat(timespec="seconds") + "Z",
            "title": scenario["title"],
            "body": scenario["body"],
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
            "title": "Grid A load 94% of capacity — advisory",
            "severity": "MODERATE",
            "body": "Load on Grid A exceeded 90% threshold for 40 min during peak hour. Comm Node Alpha on backup ready.",
        },
        {
            "title": "Comm Node Bravo: jitter spike",
            "severity": "LOW",
            "body": "Comm Node Bravo reported elevated jitter on data plane for 18 min. Root cause: adjacent construction RF interference. Cleared.",
        },
        {
            "title": "Generator 1 transfer test pass",
            "severity": "LOW",
            "body": "Scheduled monthly generator transfer test: ATS switched Grid A → Gen-1 within 4 sec. Returned to utility power after 30 min.",
        },
        {
            "title": "POL Fuel Farm: fuel quality sample PASS",
            "severity": "LOW",
            "body": "Weekly POL fuel sample returned within spec — particulate and water both nominal.",
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
            "title": "FIRMS heat anomaly — 4 km N of perimeter",
            "severity": "LOW",
            "body": "NASA FIRMS satellite detected thermal anomaly (likely agricultural burn) 4 km NW of ECP-2. No smoke impact on installation airspace.",
        },
        {
            "title": "Wind advisory — SW 30 gust 45 kt expected 1400-1900",
            "severity": "MODERATE",
            "body": "Sustained winds expected 30 kt with gusts to 45 kt this afternoon. HH-1 helipad operations on hold. Cranes secured per SOP.",
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
