"""Repo-wide pytest configuration.

CSRF (P1-3): the API enforces a double-submit CSRF token on state-changing
requests — a readable `spire_csrf` cookie must be echoed in the `X-CSRF-Token`
header, exactly as the browser SPA does. Tests drive the API with
`fastapi.testclient.TestClient`, which isn't a browser, so this autouse fixture
makes every TestClient echo the cookie on mutating requests. Without it, CSRF
enforcement would 403 every POST in the suite.

A test can still exercise the negative path by passing an explicit
`X-CSRF-Token` header (e.g. a wrong value) — `setdefault` won't override it.
"""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

# Cookies default to Secure (TLS-only). The TestClient speaks http://testserver,
# which drops Secure cookies, so run the suite with it off.
os.environ.setdefault("SPIRE_SESSION_SECURE", "0")

_SAFE = {"GET", "HEAD", "OPTIONS", "TRACE"}


@pytest.fixture(autouse=True)
def _reset_server_state():
    """Clear in-process rate-limit + session-revocation state between tests so
    the login-heavy suite doesn't trip the throttle and revocations don't leak."""
    from backend import auth, ratelimit
    ratelimit.reset()
    auth._REVOKED_JTI.clear()
    auth._JTI_LAST_SEEN.clear()
    yield


@pytest.fixture(autouse=True)
def _csrf_aware_testclient(monkeypatch):
    original = TestClient.request

    def request(self, method, url, *args, **kwargs):
        if str(method).upper() not in _SAFE:
            token = self.cookies.get("spire_csrf")
            if token:
                headers = dict(kwargs.get("headers") or {})
                headers.setdefault("X-CSRF-Token", token)
                kwargs["headers"] = headers
        return original(self, method, url, *args, **kwargs)

    monkeypatch.setattr(TestClient, "request", request)
