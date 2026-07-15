"""Auth endpoints are rate-limited against brute force (P2-2)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app

MAINT_CHIEF = "2345678901"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_login_is_rate_limited(client):
    # 10 attempts/min per IP are allowed; the 11th is throttled — regardless of
    # whether the credentials are valid (this fires before the cert lookup).
    codes = [
        client.post("/api/auth/login", json={"dodid": MAINT_CHIEF, "pin": "000000"}).status_code
        for _ in range(11)
    ]
    assert codes[-1] == 429
    assert 429 not in codes[:10]  # the first 10 were let through


def test_limiter_window_is_per_key():
    from backend import ratelimit
    ratelimit.reset()
    assert all(ratelimit.allow("k1", 3, 60) for _ in range(3))
    assert ratelimit.allow("k1", 3, 60) is False   # k1 over
    assert ratelimit.allow("k2", 3, 60) is True    # k2 independent
