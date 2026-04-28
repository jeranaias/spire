"""
Task-68 — role-gate test for the SENTRY Export endpoints.

The Export tab's React `<InsufficientPrivilege>` panel is UX, not security.
Until this task, the only backend gate on `/api/sentry/export` and
`/api/sentry/download/{export_id}` was `require_clearance`, which a SECRET
G-4 NCO (Reyes) or maintenance chief (Kowalski) trivially passed because
the canonical batch's bundle is at most SECRET. They could `curl` past the
hidden FE panel and walk away with a 2,306-record sanitized release bundle.

This test pins the four mock CACs to the right verdict on both endpoints:

  Park (security_manager, TS//SCI)  → 200 on /export AND /download
  Reyes (g4, SECRET)                → 403 InsufficientRole on both
                                       (in /sentry view, off-role for export)
  Kowalski (maintenance_chief)      → 403 InsufficientRole on both
                                       (in /sentry view, off-role for export)
  Hayes (mef_commander, TS//SCI)    → 403 OutOfScope on both
                                       (Task #111: the SENTRY view-scope
                                       gate fires first because mef_commander
                                       isn't in `SENTRY_VIEW_ROLES`; the
                                       per-route `InsufficientRole` gate is
                                       never reached. Both responses still
                                       403, just with the router-level
                                       `OutOfScope` signature.)

It also asserts the gate writes a `role_denied` audit row distinct from
`spillage_prevented`, so the SOC view can split "tried to act outside
their role" from "tried to read over their clearance". For mef_commander
the audit row is `view_scope_denied` rather than `role_denied` — same
403 wire status, different audit kind so SOC tooling can tell "wrong tab
entirely" from "right tab, wrong action".
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import entries_for_subject
from backend.scoping import (
    SENTRY_EXPORT_ROLES,
    require_user_role,
)


# --- Mock CAC roster (mirrors backend/auth.py MOCK_USERS by DoDID) ---------
DODID_REYES    = "1234567890"  # GySgt Reyes — g4, SECRET
DODID_KOWALSKI = "2345678901"  # MSgt Kowalski — maintenance_chief, SECRET
DODID_PARK     = "3456789012"  # CWO3 Park — security_manager, TS//SCI
DODID_HAYES    = "4567890123"  # MajGen Hayes — mef_commander, TS//SCI


@pytest.fixture()
def client():
    # Context-manager form runs the lifespan handler so the canonical
    # dataset is loaded before any /sentry/* call lands.
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _logout(client: TestClient) -> None:
    client.post("/api/auth/logout")


# ---------------------------------------------------------------------------
# Unit-level: helper raises InsufficientRole + writes role_denied audit.
# ---------------------------------------------------------------------------

def test_require_user_role_blocks_off_role_with_structured_detail():
    """Direct unit test of the new gate — same shape the routes use."""
    from fastapi import HTTPException

    g4_user = {
        "dodid": DODID_REYES,
        "role": "g4",
        "clearance": "SECRET",
    }

    with pytest.raises(HTTPException) as exc_info:
        require_user_role(
            g4_user,
            SENTRY_EXPORT_ROLES,
            action="sentry.export",
            audit_subject="EXP-ROLEGATE-001",
        )

    assert exc_info.value.status_code == 403
    detail = exc_info.value.detail
    assert isinstance(detail, dict), "detail must be a dict so FE can branch on it"
    assert detail["error"] == "InsufficientRole"
    assert detail["action"] == "sentry.export"
    assert detail["user_role"] == "g4"
    # Sorted list so the FE can render a stable explanation string.
    assert detail["roles_allowed"] == sorted(SENTRY_EXPORT_ROLES)

    # role_denied row must reach the persistent audit chain so the SOC
    # view can chase it back to the cert by DoDID.
    rows = entries_for_subject("EXP-ROLEGATE-001", limit=10)
    denials = [
        r for r in rows
        if r.get("kind") == "role_denied"
        and r["payload"].get("user_dodid") == DODID_REYES
        and r["payload"].get("action") == "sentry.export"
    ]
    assert len(denials) >= 1, (
        f"expected a role_denied row in audit chain; got: {rows!r}"
    )
    payload = denials[0]["payload"]
    assert payload["user_role"] == "g4"
    assert payload["roles_allowed"] == sorted(SENTRY_EXPORT_ROLES)
    assert payload["decision"] == "blocked"
    assert payload["surface"] == "backend"


def test_require_user_role_allows_in_role():
    """Positive control: the helper is silent for an in-role user."""
    custodian_user = {
        "dodid": DODID_PARK,
        "role": "security_manager",
        "clearance": "TS//SCI",
    }
    # No exception should be raised; returns the role on success.
    out = require_user_role(custodian_user, SENTRY_EXPORT_ROLES, action="sentry.export")
    assert out == "security_manager"


# ---------------------------------------------------------------------------
# End-to-end: each of the four mock CACs hits /export AND /download with
# the right verdict. Park = 200, the other three = 403 InsufficientRole.
# ---------------------------------------------------------------------------

def _post_export(client: TestClient):
    return client.post(
        "/api/sentry/export",
        json={
            "release_authority": "US_ONLY",
            "format": "xlsx",
            "include_audit": True,
            "batch_id": None,
        },
    )


def test_export_security_manager_park_returns_200(client):
    """CWO3 Park (security_manager / TS//SCI) is the canonical custodian."""
    _login(client, DODID_PARK)
    r = _post_export(client)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["download_url"].startswith("/api/sentry/download/")

    # Same CAC on /download should stream the bytes back.
    dl = client.get(body["download_url"])
    assert dl.status_code == 200, dl.text
    assert dl.headers.get("content-type", "").startswith("application/zip")
    _logout(client)


@pytest.mark.parametrize(
    "dodid,role_label",
    [
        # In /sentry view-scope, off-role for export → per-route gate fires
        # → wire error `InsufficientRole`.
        (DODID_REYES,    "g4"),
        (DODID_KOWALSKI, "maintenance_chief"),
    ],
)
def test_export_off_role_users_get_403_insufficient_role(client, dodid, role_label):
    """In-scope, off-role users must be blocked — they reach SENTRY (so
    the view-scope gate passes) but the per-route role gate fires before
    require_clearance, so the wire error is `InsufficientRole`, not
    `InsufficientClearance`.
    """
    _login(client, dodid)
    r = _post_export(client)
    assert r.status_code == 403, r.text
    detail = r.json().get("detail")
    assert isinstance(detail, dict)
    assert detail["error"] == "InsufficientRole"
    assert detail["action"] == "sentry.export"
    assert detail["user_role"] == role_label
    assert detail["roles_allowed"] == sorted(SENTRY_EXPORT_ROLES)
    _logout(client)


def test_export_out_of_scope_user_gets_403_outofscope(client):
    """Hayes (mef_commander) is outside `SENTRY_VIEW_ROLES`, so the
    Task-#111 router-level view-scope gate fires *before* the per-route
    `InsufficientRole` gate. The wire still 403s — that is the
    security-relevant invariant — but the error shape is `OutOfScope`
    and the audit kind is `view_scope_denied`. SOC tooling can split
    "wrong tab entirely" from "right tab, wrong action" cleanly.
    """
    _login(client, DODID_HAYES)
    r = _post_export(client)
    assert r.status_code == 403, r.text
    detail = r.json().get("detail")
    assert isinstance(detail, dict)
    assert detail["error"] == "OutOfScope"
    assert detail["view"] == "/sentry"
    assert detail["user_role"] == "mef_commander"
    _logout(client)


@pytest.mark.parametrize(
    "dodid,role_label",
    [
        (DODID_REYES,    "g4"),
        (DODID_KOWALSKI, "maintenance_chief"),
    ],
)
def test_download_off_role_users_get_403_even_with_leaked_export_id(client, dodid, role_label):
    """Park builds a bundle, then an in-scope, off-role CAC tries to
    redeem the EXP-ID. The download gate must block the same way as
    /export — a leaked or guessed ID can't be used to bypass the role
    check. Mef_commander is covered separately because the SENTRY
    view-scope gate gives them an OutOfScope shape, not InsufficientRole.
    """
    # Park builds the bundle so we have a real EXP-... to attempt.
    _login(client, DODID_PARK)
    built = _post_export(client)
    assert built.status_code == 200, built.text
    download_url = built.json()["download_url"]
    _logout(client)

    # Now sign in as the off-role CAC and try to redeem.
    _login(client, dodid)
    r = client.get(download_url)
    assert r.status_code == 403, r.text
    detail = r.json().get("detail")
    assert isinstance(detail, dict)
    assert detail["error"] == "InsufficientRole"
    assert detail["action"] == "sentry.download"
    assert detail["user_role"] == role_label
    _logout(client)


def test_download_out_of_scope_user_gets_403_outofscope(client):
    """Out-of-scope mef_commander redeeming a leaked EXP-ID hits the
    /sentry view-scope gate first — same 403, different signature.
    The fabricated-ID enumeration test is preserved by
    `test_download_off_role_user_cannot_enumerate_export_ids` below
    (using an in-scope role); here we only need to verify the
    view-scope gate is the one firing for an out-of-scope role.
    """
    # Park builds the bundle so we have a real EXP-... to redeem.
    _login(client, DODID_PARK)
    built = _post_export(client)
    assert built.status_code == 200, built.text
    download_url = built.json()["download_url"]
    _logout(client)

    _login(client, DODID_HAYES)
    r = client.get(download_url)
    assert r.status_code == 403, r.text
    detail = r.json().get("detail")
    assert isinstance(detail, dict)
    assert detail["error"] == "OutOfScope"
    assert detail["view"] == "/sentry"
    assert detail["user_role"] == "mef_commander"
    _logout(client)


def test_download_off_role_user_cannot_enumerate_export_ids(client):
    """Authz must run BEFORE the existence check on /download. An
    off-role CAC probing for valid EXP-IDs should see a uniform 403
    whether the ID is real, expired, or fabricated — otherwise a 404
    leaks "this ID exists, you just can't have it" to an enumerator.
    """
    fabricated_id = "EXP-19700101-000000-deadbe"
    _login(client, DODID_REYES)  # off-role g4
    r = client.get(f"/api/sentry/download/{fabricated_id}")
    # Must be 403 (role gate), NOT 404 (existence leak).
    assert r.status_code == 403, r.text
    detail = r.json().get("detail")
    assert isinstance(detail, dict)
    assert detail["error"] == "InsufficientRole"
    assert detail["action"] == "sentry.download"
    _logout(client)
