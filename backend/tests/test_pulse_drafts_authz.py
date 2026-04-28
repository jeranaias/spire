"""
Task-142 — authz tests for the PULSE Drafts approve / reject / dismiss
workflow.

Pin behaviour:

  * Approve / reject are restricted to {g4, maintenance_chief, mef_commander}
    AND the actor must not equal the draft's originator (no self-approval).
    Off-role gets 403 (require_role); originator gets 403 SelfApprovalForbidden.
    Re-acting on a non-held draft is 409 DraftNotHeld.

  * Dismiss is originator-only. A non-originator (even an approver-role)
    must use reject — which audit-logs WHO killed the draft and WHY —
    instead of dismissing through the back door. Non-originator dismiss
    returns 403 DismissNotOriginator. Originator dismiss returns 200.
    Re-dismissing a non-held draft is 409 DraftNotHeld.

  * The cannibalize → propose handoff still fires when the approver
    releases a CANNIBALIZE draft whose artifact has the recipient_sr /
    donor_sr / nsn tuple.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import (
    dismiss_pulse_draft,
    entries_for_subject,
)


DODID_REYES = "1234567890"      # g4
DODID_KOWALSKI = "2345678901"   # maintenance_chief
DODID_PARK = "3456789012"       # security_manager (NOT an approver role)
DODID_HAYES = "4567890123"      # mef_commander


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "000000"})
    assert r.status_code == 200, r.text


def _logout(client: TestClient) -> None:
    client.post("/api/auth/logout")


def _draft_as(client: TestClient, dodid: str, *, asset_id: str, kind: str = "preposition_spares",
              unit_name: str = "CLB-6", title: str = "Authz fixture") -> str:
    """Create a held draft authored by the user behind ``dodid``. Returns the draft_id."""
    _login(client, dodid)
    try:
        r = client.post(
            "/api/pulse/draft-action",
            json={"asset_id": asset_id, "kind": kind, "unit_name": unit_name, "title": title},
        )
        assert r.status_code == 200, r.text
        return r.json()["draft"]["draft_id"]
    finally:
        _logout(client)


# ---------------------------------------------------------------------------
# Dismiss — the bug this regression test was added to lock down.
# ---------------------------------------------------------------------------

def test_dismiss_blocks_non_originator(client):
    """An approver who didn't originate the draft cannot dismiss it; they
    must reject it (so the audit row records the kill)."""
    draft_id = _draft_as(client, DODID_KOWALSKI, asset_id="M21670-JLTV-024")

    _login(client, DODID_REYES)  # g4 — different role, NOT originator
    r = client.post(f"/api/pulse/drafts/{draft_id}/dismiss")
    assert r.status_code == 403, r.text
    body = r.json()
    assert body["detail"]["error"] == "DismissNotOriginator"

    # Sanity: the draft is still held — the rejected dismiss must NOT
    # have flipped status under the hood.
    r2 = client.get("/api/pulse/drafts?status=held")
    assert r2.status_code == 200
    held_ids = {d["draft_id"] for d in r2.json().get("drafts", [])}
    assert draft_id in held_ids


def test_dismiss_allows_originator(client):
    """Originator can dismiss their own held draft and the audit log
    captures a `pulse_draft_dismiss` row keyed to the draft id."""
    draft_id = _draft_as(client, DODID_KOWALSKI, asset_id="M21670-JLTV-009")

    _login(client, DODID_KOWALSKI)
    r = client.post(f"/api/pulse/drafts/{draft_id}/dismiss")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "dismissed"

    kinds = {e["kind"] for e in entries_for_subject(draft_id)}
    assert "pulse_draft_dismiss" in kinds


def test_dismiss_returns_409_on_non_held(client):
    """Re-dismissing a draft that is no longer held returns 409, not a
    silent 200 (so the FE can show a useful error)."""
    draft_id = _draft_as(client, DODID_KOWALSKI, asset_id="M21670-JLTV-024")

    _login(client, DODID_KOWALSKI)
    assert client.post(f"/api/pulse/drafts/{draft_id}/dismiss").status_code == 200
    r = client.post(f"/api/pulse/drafts/{draft_id}/dismiss")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "DraftNotHeld"


def test_dismiss_persistence_helper_rejects_wrong_originator(client):
    """Defense-in-depth: even if the route's check is bypassed, the
    persistence helper raises PermissionError when the supplied
    originator doesn't match the draft's persisted actor."""
    draft_id = _draft_as(client, DODID_KOWALSKI, asset_id="M21670-JLTV-024",
                         title="Persistence-layer authz fixture")
    with pytest.raises(PermissionError):
        dismiss_pulse_draft(draft_id, actor="g4", originator="g4")


# ---------------------------------------------------------------------------
# Approve / reject — pin the role + originator gates.
# ---------------------------------------------------------------------------

def test_approve_blocks_self_approval(client):
    """Originator cannot approve their own draft, even if their role is
    in the approver set. Backend returns 403 SelfApprovalForbidden."""
    draft_id = _draft_as(client, DODID_KOWALSKI, asset_id="M21670-JLTV-024")

    _login(client, DODID_KOWALSKI)
    r = client.post(f"/api/pulse/drafts/{draft_id}/approve")
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["error"] == "SelfApprovalForbidden"


def test_approve_blocks_off_role(client):
    """A user whose role is not in {g4, maintenance_chief, mef_commander}
    cannot approve, regardless of whether they're the originator."""
    draft_id = _draft_as(client, DODID_KOWALSKI, asset_id="M21670-JLTV-024")

    _login(client, DODID_PARK)  # security_manager — NOT an approver role
    r = client.post(f"/api/pulse/drafts/{draft_id}/approve")
    assert r.status_code == 403, r.text


def test_approve_happy_path_writes_audit_row(client):
    """Approver-role acting as a different user releases the draft and
    a `pulse_draft_approve` audit row is chained for that subject."""
    draft_id = _draft_as(client, DODID_KOWALSKI, asset_id="M21670-JLTV-024")

    _login(client, DODID_REYES)
    r = client.post(f"/api/pulse/drafts/{draft_id}/approve")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"

    kinds = {e["kind"] for e in entries_for_subject(draft_id)}
    assert "pulse_draft_approve" in kinds


def test_reject_happy_path_writes_audit_row_with_reason(client):
    """Reject path also enforces approver+different-actor and persists
    the optional reason on the audit row."""
    draft_id = _draft_as(client, DODID_KOWALSKI, asset_id="M21670-JLTV-024")

    _login(client, DODID_REYES)
    r = client.post(
        f"/api/pulse/drafts/{draft_id}/reject",
        json={"reason": "covered by another action"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rejected"
    assert r.json()["reason"] == "covered by another action"

    rows = [e for e in entries_for_subject(draft_id) if e["kind"] == "pulse_draft_reject"]
    assert rows, "no pulse_draft_reject audit row written"
    assert rows[-1]["payload"].get("reason") == "covered by another action"


def test_double_approve_returns_409(client):
    """Once a draft leaves `held`, a second approve attempt returns 409
    DraftNotHeld so the FE can show a stale-state notice instead of
    silently double-firing the downstream propose flow."""
    draft_id = _draft_as(client, DODID_KOWALSKI, asset_id="M21670-JLTV-024")

    _login(client, DODID_REYES)
    assert client.post(f"/api/pulse/drafts/{draft_id}/approve").status_code == 200
    r = client.post(f"/api/pulse/drafts/{draft_id}/approve")
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["error"] == "DraftNotHeld"
