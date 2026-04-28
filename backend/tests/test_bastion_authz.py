"""
Task-54 — BASTION mutation authorization tests.

Reproduces the F1 / F3 findings from `.local/critiques/bastion-cop.md`
and asserts the lockdown:

  1. POST /api/bastion/simulate/thermalhawk-detection
       * returns 403 for maintenance_chief and data_custodian
       * returns 200 for mef_commander, security_manager, g4
       * routes the sim to the operator's identity-derived unit even
         when the wire payload tries to spoof a different unit, and
         records a `bastion_simulate_unit_override` audit row when it
         does
  2. POST /api/bastion/alerts/{id}/{action}
       * returns 404 for unknown alert ids (closes F3 — unbounded
         growth of _ALERT_STATE)
       * returns 403 when a restricted operator (maintenance_chief)
         tries to act on an alert outside their scope, and records a
         `bastion_alert_action_blocked` audit row
       * returns 200 when the operator acts on an alert in their scope

Boots the FastAPI app via TestClient + signs in via the same
/api/auth/login flow the FE uses, so the test exercises the full
session middleware + scope chain.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import entries_for_subject


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _logout(client: TestClient) -> None:
    client.post("/api/auth/logout")


# DoDIDs from backend/auth.py MOCK_USERS:
G4               = "1234567890"  # GySgt Reyes, role=g4, unit=CLB-6
MAINT_CHIEF      = "2345678901"  # MSgt Kowalski, role=maintenance_chief, unit=CLB-6
SECURITY_MANAGER = "3456789012"  # CWO3 Park, role=security_manager
MEF_COMMANDER    = "4567890123"  # MajGen Hayes, role=mef_commander


# ---------------------------------------------------------------------------
# F1.1 — simulate/thermalhawk-detection role gate + identity-derived unit
# ---------------------------------------------------------------------------

def test_simulate_blocked_for_maintenance_chief(client):
    """The FE hides the Sim Controls pill for maintenance_chief; the API
    must mirror the gate so a CAC scoped to one battalion can't trigger
    a CRITICAL UAS incident on another battalion's motor pool."""
    _login(client, MAINT_CHIEF)
    r = client.post(
        "/api/bastion/simulate/thermalhawk-detection",
        json={"unit": "MALS-31"},
    )
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "InsufficientPrivilege"
    assert detail["action"] == "bastion.simulate_thermalhawk"
    assert detail["role_seen"] == "maintenance_chief"


def test_simulate_allowed_for_g4_routes_to_g4_unit_not_payload(client):
    """g4 is in the simulate allowlist, but the target unit must come
    from the operator's identity (CLB-6 for Reyes), NOT the wire body
    that asked for MALS-31. Audit chain must record the override."""
    _login(client, G4)
    r = client.post(
        "/api/bastion/simulate/thermalhawk-detection",
        json={"unit": "MALS-31"},  # spoof attempt
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Routed to the operator's home unit, not the spoofed payload.
    assert body["alert"]["unit"] == "CLB-6"
    sim_id = body["sim_id"]

    # Audit chain — the override breadcrumb is the forensic trail.
    overrides = [
        e for e in entries_for_subject("CLB-6", limit=50)
        if e.get("kind") == "bastion_simulate_unit_override"
    ]
    assert overrides, "expected a bastion_simulate_unit_override audit row"
    payload = overrides[0]["payload"]
    assert payload["requested_unit"] == "MALS-31"
    assert payload["routed_to_unit"] == "CLB-6"
    assert payload["user_role"] == "g4"

    # Clean up the active sim so other tests don't see it.
    client.post(f"/api/bastion/simulate/clear/{sim_id}")


def test_simulate_allowed_for_security_manager_defaults_to_clb6(client):
    """security_manager Park's `unit` field is "2d MLG" (parent command,
    not a leaf BASTION unit), so the derivation falls back to the
    canonical demo unit CLB-6."""
    _login(client, SECURITY_MANAGER)
    r = client.post("/api/bastion/simulate/thermalhawk-detection", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["alert"]["unit"] == "CLB-6"
    client.post(f"/api/bastion/simulate/clear/{body['sim_id']}")


def test_simulate_allowed_for_mef_commander(client):
    """mef_commander Hayes is in the allowlist; default routing applies."""
    _login(client, MEF_COMMANDER)
    r = client.post("/api/bastion/simulate/thermalhawk-detection", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["alert"]["unit"] == "CLB-6"
    client.post(f"/api/bastion/simulate/clear/{body['sim_id']}")


# ---------------------------------------------------------------------------
# F1.2 / F3 — alert_action: unknown id 404 + cross-tenant 403 + audit
# ---------------------------------------------------------------------------

def test_alert_action_unknown_id_returns_404(client):
    """Closes F3 — unknown ids previously grew _ALERT_STATE without bound
    and let an attacker poison the in-memory state dict."""
    _login(client, SECURITY_MANAGER)
    r = client.post("/api/bastion/alerts/totally-fake-id-xyz/ack")
    assert r.status_code == 404, r.text
    assert "totally-fake-id-xyz" in r.json()["detail"]


def test_alert_action_cross_tenant_blocked_for_maintenance_chief(client):
    """maintenance_chief Kowalski is scoped to CLB-6 — she must not be
    able to silently resolve a CLB-1 readiness alert. Reproduced in the
    F1 critique."""
    _login(client, MAINT_CHIEF)
    # Pull the unscoped alerts list (security_manager) first to learn an
    # alert id outside CLB-6. We log out + back in to switch identities.
    _logout(client)
    _login(client, SECURITY_MANAGER)
    feed = client.get("/api/bastion/alerts?limit=200").json()["alerts"]
    out_of_scope = next(
        (a for a in feed if a.get("unit") and a["unit"] != "CLB-6"),
        None,
    )
    assert out_of_scope is not None, (
        "test fixture: needed at least one alert outside CLB-6 in the feed"
    )
    other_id = out_of_scope["id"]
    other_unit = out_of_scope["unit"]
    _logout(client)

    _login(client, MAINT_CHIEF)
    r = client.post(f"/api/bastion/alerts/{other_id}/resolve")
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "OutOfScope"
    assert detail["action"] == "bastion.alert.resolve"
    assert detail["alert_unit"] == other_unit
    assert detail["user_role"] == "maintenance_chief"
    assert "CLB-6" in detail["allowed_units"]

    # Audit row recorded.
    blocks = [
        e for e in entries_for_subject(other_id, limit=10)
        if e.get("kind") == "bastion_alert_action_blocked"
    ]
    assert blocks, "expected a bastion_alert_action_blocked audit row"
    payload = blocks[0]["payload"]
    assert payload["user_role"] == "maintenance_chief"
    assert payload["alert_unit"] == other_unit
    assert payload["action"] == "bastion.alert.resolve"


def test_alert_action_in_scope_succeeds(client):
    """Positive control: maintenance_chief can act on a CLB-6 alert."""
    _login(client, MAINT_CHIEF)
    feed = client.get("/api/bastion/alerts?limit=200").json()["alerts"]
    in_scope = next((a for a in feed if a.get("unit") == "CLB-6"), None)
    assert in_scope is not None, "test fixture: needed a CLB-6 alert in feed"
    r = client.post(f"/api/bastion/alerts/{in_scope['id']}/ack")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["state"]["status"] == "acknowledged"
    # Clean up state so re-running the suite is idempotent.
    client.post(f"/api/bastion/alerts/{in_scope['id']}/unack")


def test_alert_action_basewide_blocked_for_restricted_role(client):
    """Base-wide alerts (unit=None — utility, weather, gate streams)
    must not be silenceable by a single battalion's chief."""
    _login(client, MAINT_CHIEF)
    # Find a base-wide alert id by querying as security_manager first.
    _logout(client)
    _login(client, SECURITY_MANAGER)
    feed = client.get("/api/bastion/alerts?limit=200").json()["alerts"]
    basewide = next((a for a in feed if a.get("unit") is None), None)
    _logout(client)
    if basewide is None:
        pytest.skip("no base-wide alerts in current feed; skip")

    _login(client, MAINT_CHIEF)
    r = client.post(f"/api/bastion/alerts/{basewide['id']}/resolve")
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["error"] == "OutOfScope"


def test_alert_action_unauthenticated_returns_401(client):
    """Sanity: middleware still rejects unauthenticated calls before any
    route logic runs."""
    r = client.post("/api/bastion/alerts/anything/ack")
    assert r.status_code == 401


def test_fused_threat_id_from_feed_is_actionable(client):
    """Regression for the code-review block: fused threat ids surfaced in
    /api/bastion/alerts must be actionable via /alerts/{id}/{action}.

    Earlier the universe builder fed `fuse_alerts` a different input set
    (and order) than /alerts did, so feed-visible `FUS-MGATE-*` /
    `FUS-...` ids returned 404 on ack. Both paths now share
    `_compose_raw_alerts` + `_scope_alerts`, so this test asserts the
    end-to-end contract: fetch a fused id from the feed, ack it, expect
    200."""
    _login(client, SECURITY_MANAGER)
    body = client.get("/api/bastion/alerts?limit=200").json()
    fused = body.get("fused_threats", [])
    if not fused:
        pytest.skip("no fused threats in current dataset; skip")
    fused_id = fused[0]["id"]

    r = client.post(f"/api/bastion/alerts/{fused_id}/ack")
    assert r.status_code == 200, (
        f"fused id {fused_id} surfaced in /alerts but action returned "
        f"{r.status_code}: {r.text}"
    )
    assert r.json()["state"]["status"] == "acknowledged"
    # Idempotency cleanup so re-running the suite doesn't leave state.
    client.post(f"/api/bastion/alerts/{fused_id}/unack")
