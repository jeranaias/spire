"""CSRF double-submit enforcement (P1-3)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app

MAINT_CHIEF = "2345678901"  # in PULSE_VIEW_ROLES, so pulse routes reach the handler


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _login(c, dodid):
    assert c.post("/api/auth/login", json={"dodid": dodid, "pin": "000000"}).status_code == 200


def test_login_sets_csrf_cookie(client):
    _login(client, MAINT_CHIEF)
    assert client.cookies.get("spire_csrf")


def test_mutating_request_without_token_is_403(client):
    _login(client, MAINT_CHIEF)
    # Explicit wrong token — the conftest auto-injector uses setdefault, so this
    # value stands and the double-submit check fails.
    r = client.post("/api/pulse/feedback/x", headers={"X-CSRF-Token": "wrong"})
    assert r.status_code == 403
    assert r.json().get("error") == "csrf_failed"


def test_mutating_request_with_token_passes_csrf(client):
    _login(client, MAINT_CHIEF)
    # Valid token auto-attached by the conftest fixture; CSRF must not be the
    # reason for any failure (handler may 404/422 the bogus asset, that's fine).
    r = client.post("/api/pulse/feedback/x")
    assert not (r.status_code == 403 and r.json().get("error") == "csrf_failed")


def test_get_requests_need_no_token(client):
    _login(client, MAINT_CHIEF)
    # A safe method is never CSRF-gated.
    r = client.get("/api/decision-bridge/mission")
    assert r.status_code == 200


def test_login_is_csrf_exempt(client):
    # The login POST establishes the session; it can't require a prior token.
    r = client.post("/api/auth/login", json={"dodid": MAINT_CHIEF, "pin": "000000"})
    assert r.status_code == 200
