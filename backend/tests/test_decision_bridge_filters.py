"""Task #121 — lock down two semantic guards in `decision_bridge` so a
future refactor can't reintroduce stale data on the bridge dashboard.

1. `alerts_top` drops alerts older than 30 days from the dataset day,
   and within each severity band sorts timestamps DESCENDING.
2. `_class_ix_shortages` excludes NSNs whose only contributing SRs have
   condition in {Minor, Supply, Service}, and includes any NSN with at
   least one Deadlined or Degraded SR.
3. End-to-end across all four personas (Hayes, Reyes, Kowalski, Park):
   `/api/decision-bridge/shortages` never surfaces a Class IX row whose
   item nomenclature contains PAINT, CARC, PRIMER, or LUBRICANT — those
   are routine corrective reqs that historically leaked into the lead
   slot before the mission-essential filter was added.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from typing import Optional

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routes import bastion, decision_bridge
from backend.routes.decision_bridge import _class_ix_shortages, alerts_top


# ---------------------------------------------------------------------------
# Test 1 — alerts_top recency cutoff + per-severity timestamp DESC sort
# ---------------------------------------------------------------------------

def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def test_alerts_top_drops_alerts_older_than_30_days_and_sorts_desc(monkeypatch):
    dataset_day = date(2025, 6, 15)
    cutoff_iso = _iso(datetime(2025, 5, 16, 0, 0, 0))  # day-30

    fake_ds = SimpleNamespace(
        snapshots=[SimpleNamespace(snapshot_date=dataset_day)],
    )

    # Two HIGH alerts inside the window (one fresh, one near the edge),
    # one HIGH alert outside the window (must be dropped), plus a
    # CRITICAL and a LOW so we exercise the cross-severity ordering too.
    fresh_high = {
        "id": "high-fresh",
        "severity": "HIGH",
        "timestamp": _iso(datetime(2025, 6, 14, 12, 0, 0)),
    }
    edge_high = {
        "id": "high-edge",
        "severity": "HIGH",
        "timestamp": _iso(datetime(2025, 5, 20, 9, 0, 0)),
    }
    stale_high = {
        "id": "high-stale",
        "severity": "HIGH",
        # >30 days before the dataset day — must be filtered out.
        "timestamp": _iso(datetime(2025, 4, 1, 0, 0, 0)),
    }
    critical = {
        "id": "crit-1",
        "severity": "CRITICAL",
        "timestamp": _iso(datetime(2025, 6, 10, 0, 0, 0)),
    }
    low = {
        "id": "low-1",
        "severity": "LOW",
        "timestamp": _iso(datetime(2025, 6, 13, 0, 0, 0)),
    }

    async def fake_bastion_alerts(limit: int = 30, role: Optional[str] = None):
        return {
            "alerts": [stale_high, edge_high, fresh_high, critical, low],
            "severity_counts": {"CRITICAL": 1, "HIGH": 3, "LOW": 1},
            "total": 5,
        }

    # Patch the source module the inline import resolves against, plus
    # the dataset hook decision_bridge calls for the cutoff anchor.
    monkeypatch.setattr(bastion, "alerts", fake_bastion_alerts, raising=True)
    monkeypatch.setattr(decision_bridge, "get_dataset", lambda: fake_ds)

    result = asyncio.run(alerts_top(role=None, limit=10))

    ids = [a["id"] for a in result["alerts"]]

    # Recency cutoff: stale HIGH outside the 30-day window is gone.
    assert "high-stale" not in ids, (
        f"stale alert before cutoff ({cutoff_iso}) leaked into the bridge feed"
    )
    # Edge alert sitting comfortably inside the window survives.
    assert "high-edge" in ids
    assert "high-fresh" in ids

    # Cross-severity ordering: CRITICAL precedes HIGH precedes LOW.
    assert ids[0] == "crit-1", f"CRITICAL must lead the bridge, got {ids}"
    assert ids.index("crit-1") < ids.index("high-fresh") < ids.index("low-1")

    # Within HIGH band: timestamps DESCENDING (most recent first).
    high_ids = [a["id"] for a in result["alerts"] if a["severity"] == "HIGH"]
    assert high_ids == ["high-fresh", "high-edge"], (
        f"HIGH band must be timestamp DESC, got {high_ids}"
    )

    # Severity counts reflect the post-filter view (stale HIGH removed).
    assert result["severity_counts"].get("HIGH") == 2
    assert result["total"] == 4


# ---------------------------------------------------------------------------
# Test 2 — _class_ix_shortages mission-essential predicate
# ---------------------------------------------------------------------------

@dataclass
class _Req:
    nsn: str
    nomenclature: str
    ordered_date: Optional[date]
    received_date: Optional[date] = None


@dataclass
class _SR:
    sr_number: str
    unit_name: str
    condition: str
    requisitions: list = field(default_factory=list)


def _build_synthetic_dataset(dataset_day: date):
    """Five NSNs across seven SRs:

      * NSN_A — two `Minor` SRs only             → must be EXCLUDED
      * NSN_B — one `Supply`, one `Service` SR   → must be EXCLUDED
      * NSN_C — one `Deadlined` SR               → must be INCLUDED (NMCS)
      * NSN_D — one `Degraded` SR                → must be INCLUDED (PMC)
      * NSN_E — one `Minor` SR + one `Deadlined` SR → INCLUDED (any-essential)
    """
    ordered = dataset_day - timedelta(days=5)
    srs = [
        _SR("SR-001", "CLB-Det", "Minor", [
            _Req("NSN_A", "PAINT, CARC GREEN", ordered),
            _Req("NSN_E", "FILTER, FUEL", ordered),
        ]),
        _SR("SR-002", "CLB-Det", "Minor", [
            _Req("NSN_A", "PAINT, CARC GREEN", ordered),
        ]),
        _SR("SR-003", "CLB-Det", "Supply", [
            _Req("NSN_B", "PRIMER, ZINC", ordered),
        ]),
        _SR("SR-004", "CLB-Det", "Service", [
            _Req("NSN_B", "PRIMER, ZINC", ordered),
        ]),
        _SR("SR-005", "CLB-Det", "Deadlined", [
            _Req("NSN_C", "TURBOCHARGER ASSY", ordered),
        ]),
        _SR("SR-006", "CLB-Det", "Degraded", [
            _Req("NSN_D", "RADIATOR CORE", ordered),
        ]),
        _SR("SR-007", "CLB-Det", "Deadlined", [
            _Req("NSN_E", "FILTER, FUEL", ordered),
        ]),
    ]
    return SimpleNamespace(
        snapshots=[SimpleNamespace(snapshot_date=dataset_day)],
        srs=srs,
    )


def test_class_ix_shortages_excludes_only_minor_supply_service_nsns():
    ds = _build_synthetic_dataset(date.today())
    rows = _class_ix_shortages(ds, allowed=None, top=10)
    nsns = {r["nsn"] for r in rows}

    # Routine-only NSNs are dropped.
    assert "NSN_A" not in nsns, "NSN with only Minor SRs leaked through"
    assert "NSN_B" not in nsns, "NSN with only Supply/Service SRs leaked through"

    # Mission-essential NSNs survive.
    assert "NSN_C" in nsns, "Deadlined-backed NSN must appear on the bridge"
    assert "NSN_D" in nsns, "Degraded-backed NSN must appear on the bridge"
    # Mixed: a single Deadlined SR is enough to lift the NSN onto the bridge.
    assert "NSN_E" in nsns, (
        "NSN with a Minor + Deadlined SR pair must still surface — any "
        "mission-essential SR backing the part is sufficient"
    )

    # Justification chip data is correctly attributed per NSN.
    by_nsn = {r["nsn"]: r for r in rows}
    assert by_nsn["NSN_C"]["nmcs_sr_count"] == 1
    assert by_nsn["NSN_C"]["pmc_sr_count"] == 0
    assert by_nsn["NSN_D"]["pmc_sr_count"] == 1
    assert by_nsn["NSN_D"]["nmcs_sr_count"] == 0
    # NSN_E's chip should count the Deadlined SR but NOT the Minor one.
    assert by_nsn["NSN_E"]["nmcs_sr_count"] == 1
    assert by_nsn["NSN_E"]["pmc_sr_count"] == 0


# ---------------------------------------------------------------------------
# Test 3 — end-to-end: no PAINT / CARC / PRIMER / LUBRICANT for any persona
# ---------------------------------------------------------------------------

# (DODID, persona last name, backend role) — covers all four bridge
# consumers. The role is sent explicitly on the query string so the
# endpoint exercises its per-role unit scoping (`allowed_units(ds, role)`)
# rather than the unscoped default branch four times in a row.
_PERSONAS = [
    ("4567890123", "Hayes",    "mef_commander"),
    ("1234567890", "Reyes",    "g4"),
    ("2345678901", "Kowalski", "maintenance_chief"),
    ("3456789012", "Park",     "security_manager"),
]

_BANNED_SUBSTRINGS = ("PAINT", "CARC", "PRIMER", "LUBRICANT")


@pytest.fixture()
def client():
    # TestClient context-manager triggers the lifespan, which loads the
    # canonical seeded dataset (RANDOM_SEED=42) so the shortages route
    # has real requisitions to aggregate.
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("dodid,persona,role", _PERSONAS)
def test_shortages_top_excludes_paint_carc_primer_lubricant(client, dodid, persona, role):
    _login(client, dodid)

    # Pull the deepest slice the route allows so we cover slot 1-10, not
    # just the displayed top-3 — a future regression that pushed
    # PAINT/CARC out of slot 1 but kept it in slot 4 should still fail.
    # `role` is forwarded explicitly so the route exercises its
    # per-role `allowed_units(ds, role)` scoping path for each persona.
    r = client.get(
        "/api/decision-bridge/shortages",
        params={"role": role, "limit": 10},
    )
    assert r.status_code == 200, r.text
    payload = r.json()

    rows = payload.get("shortages", []) or []
    offenders = [
        row for row in rows
        if any(token in (row.get("item") or "").upper() for token in _BANNED_SUBSTRINGS)
    ]
    assert not offenders, (
        f"persona={persona} dodid={dodid} role={role} surfaced banned "
        f"routine items on the bridge: "
        f"{[(o.get('nsn'), o.get('item')) for o in offenders]}"
    )
