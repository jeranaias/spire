"""Server-side session revocation + idle timeout (P2-3)."""
from __future__ import annotations

from time import time

import pytest
from fastapi.testclient import TestClient

from backend import auth
from backend.main import app

MAINT_CHIEF = "2345678901"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def _clear_registry():
    auth._REVOKED_JTI.clear()
    auth._JTI_LAST_SEEN.clear()
    yield
    auth._REVOKED_JTI.clear()
    auth._JTI_LAST_SEEN.clear()


def _login(c, dodid):
    assert c.post("/api/auth/login", json={"dodid": dodid, "pin": "000000"}).status_code == 200


def test_logout_revokes_session_server_side(client):
    _login(client, MAINT_CHIEF)
    cookie = client.cookies.get("spire_session")
    assert client.get("/api/auth/me").status_code == 200
    client.post("/api/auth/logout")
    # Re-present the captured cookie — server-side revocation still rejects it,
    # even though the client-side cookie was cleared.
    r = client.get("/api/auth/me", cookies={"spire_session": cookie})
    assert r.status_code == 401


def test_idle_session_is_revoked(client):
    _login(client, MAINT_CHIEF)
    cookie = client.cookies.get("spire_session")
    assert client.get("/api/auth/me").status_code == 200
    jti = auth.verify_session(cookie)["jti"]
    # Simulate no activity past the idle window.
    auth._JTI_LAST_SEEN[jti] = time() - (auth.SESSION_IDLE_SECONDS + 5)
    assert client.get("/api/auth/me").status_code == 401


def test_active_session_stays_valid(client):
    _login(client, MAINT_CHIEF)
    # Several requests within the window all succeed.
    for _ in range(3):
        assert client.get("/api/auth/me").status_code == 200
