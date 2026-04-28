"""
Task #115 — BASTION incident-feed role scoping.

Task #55 closed `/api/bastion/cop`'s installation-map leak but the
sibling endpoints `/api/bastion/incidents` and
`/api/bastion/incidents/{id}/response` still returned every incident on
the installation regardless of role — `location_building`,
`location_grid`, response force, damage figures and FPCON change for
every UAS incursion / EOD response on base, including ammo-depot and
arms-storage incidents, served to a maintenance_chief or g4 CAC.

This test pins the lockdown:

  * maintenance_chief (Kowalski, CLB-6) only sees incidents tied to
    CLB-6 buildings — no ammunition / arms_storage / fuel / hazmat /
    communications / tactical types in the payload.
  * g4 (Reyes, 2d MLG) sees the 2d MLG footprint, not 14th Marines or
    1st MLG (CLB-1) incidents.
  * security_manager and mef_commander still receive the full feed.
  * `/api/bastion/incidents/{id}/response` 403s for an out-of-scope
    incident and emits a `bastion_incident_view_blocked` audit row;
    the in-scope path 200s and returns the checklist.
  * `total` reflects the post-scoping count so the BASTION incident
    table reads the operator's footprint, not the master count.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import entries_for_subject


SENSITIVE_TYPES = {
    "ammunition",
    "arms_storage",
    "fuel",
    "hazmat",
    "communications",
    "tactical",
}


# DoDIDs from backend/auth.py MOCK_USERS (mirrors test_bastion_authz.py).
G4               = "1234567890"  # GySgt Reyes, role=g4
MAINT_CHIEF      = "2345678901"  # MSgt Kowalski, role=maintenance_chief
SECURITY_MANAGER = "3456789012"  # CWO3 Park, role=security_manager
MEF_COMMANDER    = "4567890123"  # MajGen Hayes, role=mef_commander


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _logout(client: TestClient) -> None:
    client.post("/api/auth/logout")


def _incidents(client: TestClient, role: str) -> dict:
    r = client.get(f"/api/bastion/incidents?role={role}&limit=200")
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# /api/bastion/incidents — list scoping
# ---------------------------------------------------------------------------

def test_full_view_role_sees_unfiltered_feed_as_baseline(client):
    """Sanity floor: the security_manager sees every incident the dataset
    has, including ammo / arms / fuel / hazmat. Used as the unscoped
    reference for the restricted-role tests below — if this drops to
    zero the rest of the file is meaningless."""
    _login(client, SECURITY_MANAGER)
    body = _incidents(client, "security_manager")
    assert body["total"] == len(body["incidents"]) > 0
    types_seen = {b["location"] for b in body["incidents"]}
    # Master feed has incidents at >20 distinct buildings — anything less
    # means the test fixture or generator drifted.
    assert len(types_seen) >= 10, types_seen


def test_maintenance_chief_does_not_see_ammo_arms_fuel_hazmat_incidents(client):
    """The Maintenance Chief CAC must not surface UAS / EOD / hazmat
    incidents at the ammunition depot, arms storage, fuel farm, or comms
    nodes — those belong to the OSINT installation product Task #55
    stripped from the COP. Same exposure surface, same fix."""
    _login(client, MAINT_CHIEF)
    body = _incidents(client, "maintenance_chief")

    # The chief's footprint is CLB-6 only — far smaller than the master
    # feed and never zero (CLB-6 owns multiple buildings in the dataset).
    assert 0 < body["total"] < 60, body["total"]
    assert body["total"] == len(body["incidents"])

    # Pull the master feed via security_manager and assert no leakage.
    _logout(client)
    _login(client, SECURITY_MANAGER)
    master = _incidents(client, "security_manager")
    master_by_id = {i["incident_number"]: i for i in master["incidents"]}

    # Every visible incident must map to a CLB-6 building (occupant or
    # CLB-6's NW sector when the building has no occupant). We don't have
    # the full sector index here, so the regression we *can* assert is
    # that no visible incident sits at a sensitive-type building.
    inst_by_name = _building_index()
    for inc in body["incidents"]:
        b = inst_by_name.get(inc["location"])
        assert b is not None, f"unknown building {inc['location']!r}"
        assert b["type"] not in SENSITIVE_TYPES, (
            f"maintenance_chief got incident at sensitive-type building "
            f"{inc['location']!r} (type={b['type']})"
        )
        # Critical-infra non-occupant buildings are also dropped.
        is_critical = bool(b.get("hazmat_present") or b.get("critical_infrastructure"))
        if is_critical and b.get("occupant_unit") not in ("CLB-6",):
            pytest.fail(
                f"maintenance_chief got incident at non-occupant CI building "
                f"{inc['location']!r} (occupant={b.get('occupant_unit')})"
            )

    # The full feed has incidents the chief should NOT see.
    visible_ids = {i["incident_number"] for i in body["incidents"]}
    hidden_ids = set(master_by_id) - visible_ids
    assert hidden_ids, (
        "expected the master feed to contain incidents outside CLB-6 scope"
    )


def test_g4_sees_2d_mlg_footprint_not_pendleton_or_14th_marines(client):
    """G-4 Reyes sits over 2d MLG — CLB-6, 7th ESB, 3d Maint Bn. He
    must not be reading 14th Marines (TOC-MAIN) or 1st MLG (CLB-1)
    incidents, the same scoping the COP map enforces."""
    _login(client, G4)
    body = _incidents(client, "g4")
    assert body["total"] == len(body["incidents"])
    # 2d MLG is ~3 units of buildings — non-zero, far less than master.
    assert 0 < body["total"] < 80, body["total"]

    inst_by_name = _building_index()
    for inc in body["incidents"]:
        b = inst_by_name.get(inc["location"])
        assert b is not None, f"unknown building {inc['location']!r}"
        assert b["type"] not in SENSITIVE_TYPES, (
            f"g4 got incident at sensitive-type building {inc['location']!r}"
        )
        # Out-of-scope occupants must not appear in the g4 feed.
        occ = b.get("occupant_unit")
        if occ:
            assert occ not in ("CLB-1", "3/6 Marines", "2/14 Marines"), (
                f"g4 got incident at out-of-scope occupant building "
                f"{inc['location']!r} (occupant={occ})"
            )


def test_security_manager_and_mef_commander_see_full_feed(client):
    """Full-view roles must keep the unfiltered incident stream — the
    SOC and the CG legitimately need cross-MEF visibility on every
    incident, including ammo-depot UAS sightings."""
    _login(client, SECURITY_MANAGER)
    sm = _incidents(client, "security_manager")
    _logout(client)

    _login(client, MEF_COMMANDER)
    mc = _incidents(client, "mef_commander")
    assert sm["total"] == mc["total"]
    # Confirm the master feed includes at least one sensitive-type
    # incident so we know the security_manager actually receives them.
    inst_by_name = _building_index()
    sensitive_visible = any(
        inst_by_name.get(i["location"], {}).get("type") in SENSITIVE_TYPES
        for i in sm["incidents"]
    )
    assert sensitive_visible, (
        "security_manager should still receive sensitive-type incidents"
    )


def test_total_reflects_scoped_count_not_master(client):
    """The BASTION incident table reads `total` to render the per-role
    badge. It must reflect the post-scoping count — otherwise a chief
    sees `27 incidents` in the table while the badge claims 100."""
    _login(client, MAINT_CHIEF)
    chief = _incidents(client, "maintenance_chief")
    _logout(client)
    _login(client, SECURITY_MANAGER)
    master = _incidents(client, "security_manager")
    assert chief["total"] < master["total"], (
        f"chief total {chief['total']} should be smaller than master "
        f"{master['total']}"
    )


# ---------------------------------------------------------------------------
# /api/bastion/incidents/{id}/response — per-incident gate
# ---------------------------------------------------------------------------

def test_response_in_scope_succeeds_for_maintenance_chief(client):
    """Positive control: the chief can pull the response checklist for
    an incident inside her CLB-6 footprint."""
    _login(client, MAINT_CHIEF)
    body = _incidents(client, "maintenance_chief")
    assert body["incidents"], "test fixture: chief had no in-scope incidents"
    in_scope_id = body["incidents"][0]["incident_number"]
    r = client.get(f"/api/bastion/incidents/{in_scope_id}/response?role=maintenance_chief")
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["incident_number"] == in_scope_id
    assert "checklist" in payload


def test_response_out_of_scope_blocked_for_maintenance_chief(client):
    """Cross-tenant probe: the chief tries to pull the response for an
    incident OUTSIDE her CLB-6 footprint (learned by querying as
    security_manager first). Must 403 + emit an audit row."""
    # Find an out-of-scope incident via security_manager's full view.
    _login(client, SECURITY_MANAGER)
    sm = _incidents(client, "security_manager")
    chief_visible_ids = set()
    _logout(client)

    _login(client, MAINT_CHIEF)
    chief = _incidents(client, "maintenance_chief")
    chief_visible_ids = {i["incident_number"] for i in chief["incidents"]}
    out_of_scope = next(
        (i for i in sm["incidents"] if i["incident_number"] not in chief_visible_ids),
        None,
    )
    assert out_of_scope is not None, (
        "test fixture: master feed had no incident outside CLB-6 scope"
    )
    other_id = out_of_scope["incident_number"]

    r = client.get(f"/api/bastion/incidents/{other_id}/response?role=maintenance_chief")
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "OutOfScope"
    assert detail["action"] == "bastion.incident.response"
    assert detail["incident_id"] == other_id
    assert detail["user_role"] == "maintenance_chief"

    # Audit chain — the cross-tenant probe must leave a forensic row.
    blocks = [
        e for e in entries_for_subject(other_id, limit=10)
        if e.get("kind") == "bastion_incident_view_blocked"
    ]
    assert blocks, "expected a bastion_incident_view_blocked audit row"
    payload = blocks[0]["payload"]
    assert payload["user_role"] == "maintenance_chief"
    assert payload["action"] == "bastion.incident.response"
    assert payload["incident_id"] == other_id
    assert payload["incident_location"] == out_of_scope["location"]


def test_response_unknown_id_returns_404(client):
    """Sanity: unknown incident ids still 404 (not 403). The 403 branch
    only fires for real incidents the operator can't see."""
    _login(client, MAINT_CHIEF)
    r = client.get("/api/bastion/incidents/totally-fake-id-xyz/response?role=maintenance_chief")
    assert r.status_code == 404, r.text


def test_query_role_cannot_spoof_past_session_role(client):
    """Defense-in-depth: a maintenance_chief CAC that hand-rolls
    `?role=mef_commander` against the incident endpoints must NOT
    receive the unfiltered feed. `session_middleware._override_query_role`
    strips the client-supplied role and replaces it with the
    authenticated session role; the endpoints additionally call
    `session_role()` first as the truth source. This pins both layers
    so a future middleware change can't silently let a query role
    elevate past the gate.
    """
    _login(client, MAINT_CHIEF)
    spoofed = client.get("/api/bastion/incidents?role=mef_commander&limit=200").json()
    honest = _incidents(client, "maintenance_chief")
    # Spoofed payload must equal the chief's scoped payload — NOT the
    # mef_commander's full feed.
    assert spoofed["total"] == honest["total"], (
        f"client-supplied ?role=mef_commander elevated past the gate: "
        f"got total={spoofed['total']} vs chief's honest total={honest['total']}"
    )

    # Same check on the per-incident response endpoint — pick a known
    # out-of-scope id (via security_manager) and try to spoof.
    _logout(client)
    _login(client, SECURITY_MANAGER)
    sm = _incidents(client, "security_manager")
    chief_ids = {i["incident_number"] for i in honest["incidents"]}
    out_of_scope = next(
        (i for i in sm["incidents"] if i["incident_number"] not in chief_ids),
        None,
    )
    assert out_of_scope is not None
    target_id = out_of_scope["incident_number"]
    _logout(client)

    _login(client, MAINT_CHIEF)
    r = client.get(
        f"/api/bastion/incidents/{target_id}/response?role=mef_commander"
    )
    assert r.status_code == 403, (
        f"client-supplied ?role=mef_commander elevated past the response "
        f"gate: got {r.status_code} on out-of-scope incident {target_id}"
    )
    assert r.json()["detail"]["user_role"] == "maintenance_chief"


def test_response_full_view_role_can_pull_any_incident(client):
    """security_manager pulls ANY incident's response — the SOC needs
    cross-MEF visibility for spillage triage."""
    _login(client, SECURITY_MANAGER)
    sm = _incidents(client, "security_manager")
    assert sm["incidents"]
    # Pick a sensitive-type incident if one exists; else any.
    inst_by_name = _building_index()
    target = next(
        (i for i in sm["incidents"]
         if inst_by_name.get(i["location"], {}).get("type") in SENSITIVE_TYPES),
        sm["incidents"][0],
    )
    r = client.get(
        f"/api/bastion/incidents/{target['incident_number']}/response?role=security_manager"
    )
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _building_index() -> dict:
    """Load installation_data.json once per call and return a name → record
    dict. Lives at file scope (not a fixture) so individual asserts can
    look up building metadata inline without parameterising the fixture
    set."""
    import json
    from pathlib import Path
    p = Path(__file__).resolve().parent.parent.parent / "dataset" / "data" / "installation_data.json"
    with open(p, encoding="utf-8") as f:
        inst = json.load(f)
    return {b["name"]: b for b in inst["buildings"]}
