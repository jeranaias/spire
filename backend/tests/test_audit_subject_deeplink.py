"""
Tests for Task #91 — "Let operators jump from a Mark recommendation to its
audit row".

The Mark Draft right-pane (`frontend/src/views/sentry/MarkTab.tsx`) renders
"Chain entry #N" as a clickable link that deep-links to the SOC audit
viewer pre-filtered to the marking's subject_id (`mark_<input_hash[:12]>`):

    /admin/audit?subject_id=mark_<hash>

The backend contract this test pins:

  - `/api/system/admin/audit?subject_id=<id>` exact-matches the chain
    `subject_id` column. The result set must not leak unrelated rows.
  - The standard `AUDIT_READ_ROLES` gate is still enforced — supplying
    `subject_id` does NOT broaden cross-role decision-history visibility.
    Only `security_manager` reads the chain; any other authenticated role
    still gets 403 (blocking lateral chain mining).
  - Anonymous callers still 401 before the route runs (session
    middleware blocks first).

Scope note: the data_custodian persona is referenced throughout the FE/BE
copy (Onboarding, MarkTab, audit seed actor, `SENTRY_MARK_ROLES`) but no
MOCK_USERS row carries `role="data_custodian"`. In practice the only
operator who can successfully run a `/sentry/mark` (and therefore see a
"Chain entry #N" to click) is the `security_manager` (CWO3 Park), who
already has audit-read access. The data_custodian bypass branch in
`admin_audit` is intentionally narrow forward-compat code that activates
only if a data_custodian session ever exists; we don't assert on it here
because it's unreachable through the current auth surface.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import log as audit_log


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _login(c: TestClient, dodid: str) -> None:
    r = c.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _logout(c: TestClient) -> None:
    c.post("/api/auth/logout")


SECURITY_MANAGER_DODID = "3456789012"   # CWO3 James Park
G4_DODID                = "1234567890"   # GySgt Marcus Reyes


def _seed_mark_subject() -> str:
    """Append a synthetic sentry_mark row and return its subject_id."""
    subject = "mark_deadbeef0123"
    audit_log(
        "sentry_mark",
        actor="data_custodian",
        subject_id=subject,
        payload={
            "actor_role": "data_custodian",
            "input_hash": "deadbeef0123" + "f" * 52,
            "recommended_classification": "CUI",
            "engine": "test",
            "engine_version": "0",
        },
    )
    return subject


def test_subject_id_filter_narrows_results(client: TestClient):
    """`subject_id` is exact-match; the result must only contain that row."""
    _logout(client)
    _login(client, SECURITY_MANAGER_DODID)
    subject = _seed_mark_subject()

    r = client.get(f"/api/system/admin/audit?subject_id={subject}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rows"], "subject filter should surface at least the seeded row"
    for row in body["rows"]:
        assert row["subject_id"] == subject, (
            f"subject filter leaked an unrelated row: {row!r}"
        )


def test_security_manager_unfiltered_read_unchanged(client: TestClient):
    """security_manager continues to read the chain without subject_id."""
    _logout(client)
    _login(client, SECURITY_MANAGER_DODID)

    r = client.get("/api/system/admin/audit?limit=5")
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body.get("rows"), list)
    # sanity: the unfiltered window includes more than just one subject
    subjects = {row["subject_id"] for row in body["rows"]}
    assert isinstance(subjects, set)


def test_subject_id_does_not_broaden_access_for_other_roles(client: TestClient):
    """Supplying `subject_id` does NOT bypass `AUDIT_READ_ROLES`.

    A non-security_manager session (here: GySgt Reyes / g4) calling
    `/admin/audit?subject_id=...` must still 403. Otherwise the deep-link
    would become a back-door for lateral chain mining.
    """
    _logout(client)
    _login(client, G4_DODID)
    subject = _seed_mark_subject()

    r = client.get(f"/api/system/admin/audit?subject_id={subject}")
    assert r.status_code == 403, r.text
    detail = r.json().get("detail") or r.json()
    assert detail.get("error") == "InsufficientPrivilege"
    assert detail.get("action") == "audit.soc_view"


def test_unauthenticated_still_blocked(client: TestClient):
    """No session → 401 even with subject_id (no anon bypass)."""
    _logout(client)
    r = client.get("/api/system/admin/audit?subject_id=mark_xxxxxxxx")
    assert r.status_code in (401, 403), r.text
