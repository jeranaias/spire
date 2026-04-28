"""
Task #97 — role-gate + identity-stamping test for the PULSE feedback endpoint.

Sibling tightening to SENTRY review (#25). Two write surfaces still accepted
any session cookie's role string and persisted only the role (not DODID,
cert serial, or name): `record_pulse_feedback` and `record_incident_response`.
This test pins the new behavior on `POST /api/pulse/feedback`:

  Reyes (g4)               → 200, chain entry stamps DODID + name + unit + cert
  Kowalski (maintenance)   → 200, same identity stamping
  Hayes (mef_commander)    → 403 InsufficientPrivilege +
                              `unauthorized_pulse_feedback` audit row carrying
                              Hayes's identity (so the SOC can chase the
                              URL-hack attempt back to a CAC, not just a role).
                              Hayes is the natural off-role demonstration
                              because Park (security_manager) can't even
                              clear the `/api/pulse` view-scope guard.

The persistence layer also gains a unit test for `record_incident_response`
to confirm the identity columns make it through to the chain payload —
the route that consumes it isn't wired up in this lane, but the call
contract has to be ready for the inspector demo.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import (
    conn,
    entries_for_subject,
    record_incident_response,
)
from backend.scoping import PULSE_FEEDBACK_ROLES, allowed_units
from backend.state import get_dataset


def _pick_in_scope_asset_id(role: str) -> str:
    """Return a real asset_id from the canonical dataset whose unit is in
    `role`'s allowed_units. Task #84 added asset-existence + unit-scope
    gates to POST /pulse/feedback, so synthetic IDs like
    ``ASSET-AUTHZ-g4`` now (correctly) 404 before the identity-stamping
    code runs. Pick a real asset so this test keeps exercising the
    Task #97 in-role success path the way it did pre-#84.
    """
    ds = get_dataset()
    allowed = allowed_units(ds, role) or set()
    for a in ds.assets:
        if a.unit_name in allowed:
            return a.asset_id
    pytest.skip(f"no in-scope asset for role {role!r}")


def _pulse_feedback_rows_for(asset_id: str) -> list[dict]:
    """Direct DB read so a denied request can't quietly leak a row through
    the persistence layer past the audit-chain check."""
    with conn() as c:
        rows = c.execute(
            "SELECT asset_id, correct, actor_role, actor_dodid "
            "FROM pulse_feedback WHERE asset_id = ?",
            (asset_id,),
        ).fetchall()
    return [dict(r) for r in rows]


# --- Mock CAC roster (mirrors backend/auth.py MOCK_USERS by DoDID) ---------
DODID_REYES    = "1234567890"  # GySgt Reyes — g4, SECRET
DODID_KOWALSKI = "2345678901"  # MSgt Kowalski — maintenance_chief, SECRET
DODID_PARK     = "3456789012"  # CWO3 Park — security_manager, TS//SCI
DODID_HAYES    = "4567890123"  # MajGen Hayes — mef_commander, TS//SCI


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _logout(client: TestClient) -> None:
    client.post("/api/auth/logout")


def _post_feedback(client: TestClient, asset_id: str, *, correct: bool = True):
    return client.post(
        f"/api/pulse/feedback/{asset_id}",
        json={"correct": correct, "note": "test"},
    )


# ---------------------------------------------------------------------------
# Positive controls: in-role users succeed AND get identity in the chain.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "dodid,role_label,expected_name,expected_unit,expected_cert",
    [
        (DODID_REYES,    "g4",                "GySgt Marcus Reyes",  "CLB-Det", "4A7f12C8e03B91a2"),
        (DODID_KOWALSKI, "maintenance_chief", "MSgt Diana Kowalski", "CLB-Det", "6b19E04a8C7d2531"),
    ],
)
def test_pulse_feedback_in_role_writes_identity_to_chain(
    client, dodid, role_label, expected_name, expected_unit, expected_cert
):
    """In-role users land 200 and the hash-chained `pulse_feedback` row
    carries DODID + name + unit + CAC cert serial — not just role."""
    # Task #84 added an asset-existence gate (404) and a unit-scope gate
    # (403) to POST /pulse/feedback — so the asset_id has to be real AND
    # in the caller's allowed_units to reach the identity-stamping path
    # that this test asserts on.
    asset_id = _pick_in_scope_asset_id(role_label)
    _login(client, dodid)
    try:
        r = _post_feedback(client, asset_id, correct=True)
        assert r.status_code == 200, r.text

        rows = entries_for_subject(asset_id, limit=10)
        successes = [r for r in rows if r.get("kind") == "pulse_feedback"]
        assert successes, f"expected a pulse_feedback row; got: {rows!r}"
        payload = successes[0]["payload"]
        assert payload["actor_role"] == role_label
        assert payload["actor_dodid"] == dodid
        assert payload["actor_name"] == expected_name
        assert payload["actor_unit"] == expected_unit
        assert payload["actor_cert_serial"] == expected_cert
        assert payload["correct"] is True
    finally:
        _logout(client)


# ---------------------------------------------------------------------------
# Negative control: mef_commander (read-on-PULSE-but-not-rate) gets 403 +
# `unauthorized_pulse_feedback` audit row carrying their identity.
#
# (Park / security_manager is denied even earlier by the `/api/pulse`
# router-level view-scope guard, so they never reach this gate. Hayes
# is the smallest-blast-radius CAC that demonstrates the role allowlist.)
# ---------------------------------------------------------------------------

def test_pulse_feedback_off_role_mef_commander_is_blocked(client):
    """Hayes (mef_commander) can read every PULSE surface but doesn't sit
    at the rating console. Hitting the endpoint past the FE returns 403
    InsufficientPrivilege and writes an `unauthorized_pulse_feedback`
    audit row carrying Hayes's DODID, name, unit, and cert serial — so
    the SOC can chase the URL-hack attempt back to the CAC, not just a
    role string.
    """
    asset_id = "ASSET-AUTHZ-MEFCDR-DENY"
    _login(client, DODID_HAYES)
    try:
        r = _post_feedback(client, asset_id, correct=True)
        assert r.status_code == 403, r.text
        detail = r.json().get("detail")
        assert isinstance(detail, dict)
        assert detail["error"] == "InsufficientPrivilege"
        assert detail["action"] == "pulse.feedback"
        assert detail["role_seen"] == "mef_commander"
        assert detail["roles_allowed"] == sorted(PULSE_FEEDBACK_ROLES)

        rows = entries_for_subject(asset_id, limit=10)
        denials = [r for r in rows if r.get("kind") == "unauthorized_pulse_feedback"]
        assert denials, f"expected an unauthorized_pulse_feedback row; got: {rows!r}"
        payload = denials[0]["payload"]
        assert payload["actor_role"] == "mef_commander"
        assert payload["actor_dodid"] == DODID_HAYES
        assert payload["actor_name"] == "MajGen Robert Hayes"
        assert payload["actor_unit"] == "III MEF"
        assert payload["actor_cert_serial"] == "C4a8B335E97f1D60"
        assert payload["decision"] == "blocked"
        assert payload["roles_allowed"] == sorted(PULSE_FEEDBACK_ROLES)

        # And critically: NO `pulse_feedback` row should have been
        # written — the gate must run before the persistence call.
        # We check both surfaces:
        #   (a) the audit chain (no `pulse_feedback` chain entry), and
        #   (b) the underlying `pulse_feedback` table (no DB row), so
        #       a future regression that writes the row but skips the
        #       chain entry can't sneak through.
        successes = [r for r in rows if r.get("kind") == "pulse_feedback"]
        assert not successes, (
            f"role gate failed open — pulse_feedback row written despite "
            f"403: {successes!r}"
        )
        db_rows = _pulse_feedback_rows_for(asset_id)
        assert not db_rows, (
            f"role gate failed open — pulse_feedback DB row written "
            f"despite 403: {db_rows!r}"
        )
    finally:
        _logout(client)


# ---------------------------------------------------------------------------
# Persistence layer — incident checklist writes carry identity in chain.
# ---------------------------------------------------------------------------

def test_record_incident_response_persists_identity_in_chain():
    """Direct unit test of the persistence function. The route that drives
    incident-checklist ticks isn't wired in this lane, but the call
    contract has to land identity in the chain so the consumer can pass
    DODID + name + unit + cert serial through when it is."""
    incident_id = "INC-AUTHZ-TEST-0001"
    record_incident_response(
        incident_id,
        "imm-1",
        True,
        actor_role="g4",
        actor_dodid=DODID_REYES,
        actor_name="GySgt Marcus Reyes",
        actor_unit="CLB-Det",
        actor_cert_serial="4A7f12C8e03B91a2",
    )
    rows = entries_for_subject(incident_id, limit=5)
    matches = [r for r in rows if r.get("kind") == "incident_response"]
    assert matches, f"expected an incident_response row; got: {rows!r}"
    payload = matches[0]["payload"]
    assert payload["actor_role"] == "g4"
    assert payload["actor_dodid"] == DODID_REYES
    assert payload["actor_name"] == "GySgt Marcus Reyes"
    assert payload["actor_unit"] == "CLB-Det"
    assert payload["actor_cert_serial"] == "4A7f12C8e03B91a2"
    assert payload["item"] == "imm-1"
    assert payload["checked"] is True
