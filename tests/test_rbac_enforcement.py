"""HTTP-level RBAC enforcement (Wave 2 security hardening).

Two invariants the IL5 access-control story depends on:

1. A client cannot escalate scope with a ``?role=`` query param — the
   session middleware (auth._override_query_role) forces the
   authenticated session role onto every /api/* request, so handlers
   that read ``role`` from the query string get server-truth, never
   client input. (Recon flagged this as a bypass; it is not — this
   test locks that in.)

2. SENTRY ingest/processing endpoints are custodian-class. A role
   outside SENTRY_MARK_ROLES (e.g. maintenance_chief) gets 403, not a
   silent ingest into the canonical store.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


MAINT_CHIEF_DODID = "2345678901"   # in no SENTRY role set
SECURITY_MANAGER_DODID = "3456789012"  # in SENTRY_MARK_ROLES
COMMANDER_DODID = "4567890123"     # mef_commander, fleet-wide scope


@pytest.fixture
def app_client():
    """Booted client (lifespan loads seed-42 dataset). Caller logs in."""
    from backend.main import app
    with TestClient(app) as c:
        yield c


def _login(c: TestClient, dodid: str) -> None:
    r = c.post("/api/auth/login", json={"dodid": dodid, "pin": "000000"})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# H2 — ?role= cannot escalate scope
# ---------------------------------------------------------------------------


def test_query_role_override_blocks_escalation(app_client):
    _login(app_client, MAINT_CHIEF_DODID)

    # Baseline: maintenance_chief is scoped to a single unit.
    base = app_client.get("/api/pulse/fleet-overview").json()
    assert base["role"] == "maintenance_chief"
    scoped_units = base["scope"]["units_visible"]
    assert base["scope"]["filter_applied"] is True

    # Escalation attempt: ?role=mef_commander must be ignored.
    spoof = app_client.get("/api/pulse/fleet-overview?role=mef_commander").json()
    assert spoof["role"] == "maintenance_chief"
    assert spoof["scope"]["units_visible"] == scoped_units


def test_commander_sees_more_than_maint_chief(app_client):
    """Sanity anchor: the escalation test above is meaningful only if the
    two roles genuinely differ in scope."""
    _login(app_client, MAINT_CHIEF_DODID)
    mc = app_client.get("/api/pulse/fleet-overview").json()["scope"]["units_visible"]

    app_client.post("/api/auth/logout")
    _login(app_client, COMMANDER_DODID)
    cdr = app_client.get("/api/pulse/fleet-overview").json()["scope"]["units_visible"]

    assert len(cdr) > len(mc)
    assert set(mc).issubset(set(cdr))


# ---------------------------------------------------------------------------
# H3 — ingest is custodian-class
# ---------------------------------------------------------------------------


def test_ingest_rejects_non_custodian(app_client):
    _login(app_client, MAINT_CHIEF_DODID)
    assert app_client.get("/api/sentry/demo-batch?limit=20").status_code == 403
    # upload likewise — send a trivial CSV part.
    r = app_client.post(
        "/api/sentry/upload",
        files={"file": ("x.csv", b"a,b\n1,2\n", "text/csv")},
    )
    assert r.status_code == 403, r.text


def test_ingest_allows_custodian(app_client):
    _login(app_client, SECURITY_MANAGER_DODID)
    r = app_client.get("/api/sentry/demo-batch?limit=20")
    assert r.status_code == 200, r.text
    batch_id = r.json()["batch_id"]
    r = app_client.post(f"/api/sentry/process/{batch_id}")
    assert r.status_code == 200, r.text


def test_process_rejects_non_custodian(app_client):
    # Custodian seeds a batch...
    _login(app_client, SECURITY_MANAGER_DODID)
    batch_id = app_client.get("/api/sentry/demo-batch?limit=20").json()["batch_id"]
    # ...then a non-custodian tries to process it.
    app_client.post("/api/auth/logout")
    _login(app_client, MAINT_CHIEF_DODID)
    r = app_client.post(f"/api/sentry/process/{batch_id}")
    assert r.status_code == 403, r.text
