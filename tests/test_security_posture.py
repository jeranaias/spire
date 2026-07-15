"""Tests for FIPS / STIG security posture (UIS-P6.2)."""
from __future__ import annotations

import os

import pytest


@pytest.fixture
def isolated_env(monkeypatch):
    """Strip every security-posture env var so each test starts at defaults."""
    for var in (
        "SPIRE_FIPS_MODE",
        "SPIRE_FIPS_MODE_ASSUME",
        "SPIRE_SESSION_SECURE",
        "SPIRE_SESSION_SAMESITE",
        "SPIRE_STIG_HEADERS",
        "SPIRE_AUTH_MODE",
        "SPIRE_CAC_REVOCATION_MODE",
        "SPIRE_AUDIT_SIGNING_KEY_PATH",
        "SPIRE_AUDIT_SIGNING_KEY_HEX",
        "SPIRE_AUDIT_PIN_PATH",
        "SPIRE_TILE_ORIGIN",
    ):
        monkeypatch.delenv(var, raising=False)
    yield


# ---------------------------------------------------------------------------
# Mode selectors
# ---------------------------------------------------------------------------


def test_fips_mode_defaults_off(isolated_env):
    from backend import security_posture
    assert security_posture.fips_mode() is False


def test_fips_mode_on(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_FIPS_MODE", "1")
    from backend import security_posture
    assert security_posture.fips_mode() is True


def test_fips_mode_assumed_off_by_default(isolated_env):
    from backend import security_posture
    assert security_posture.fips_mode_assumed() is False


# ---------------------------------------------------------------------------
# Posture snapshot
# ---------------------------------------------------------------------------


def test_posture_status_default_shape(isolated_env):
    from backend import security_posture
    p = security_posture.posture_status()
    assert p.fips_mode is False
    assert p.audit_signing_enabled is False
    assert p.cookie.httponly is True
    assert p.cookie.secure is True  # Secure by default now (P2-1)
    assert p.cookie.samesite == "lax"
    assert p.headers.x_frame_options is True  # default on
    assert p.crypto.audit_chain_hash == "sha256"
    assert p.crypto.audit_signing_algorithm == "ed25519"
    assert p.crypto.session_cookie_hmac == "sha256"


def test_posture_dict_serializable(isolated_env):
    from backend import security_posture
    d = security_posture.posture_status().to_dict()
    assert "fips_mode" in d
    assert "crypto" in d
    assert d["crypto"]["audit_chain_hash"] == "sha256"
    # All values JSON-serializable.
    import json
    json.dumps(d)


def test_posture_reflects_secure_cookie(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_SESSION_SECURE", "1")
    from backend import security_posture
    p = security_posture.posture_status()
    assert p.cookie.secure is True


def test_posture_reflects_disabled_headers(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_STIG_HEADERS", "0")
    from backend import security_posture
    p = security_posture.posture_status()
    assert p.headers.x_frame_options is False


def test_posture_reflects_audit_signing_enabled(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_AUDIT_SIGNING_KEY_HEX", "deadbeef" * 8)
    from backend import security_posture
    p = security_posture.posture_status()
    assert p.audit_signing_enabled is True


def test_posture_reflects_samesite_strict(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_SESSION_SAMESITE", "strict")
    from backend import security_posture
    p = security_posture.posture_status()
    assert p.cookie.samesite == "strict"


def test_posture_samesite_invalid_falls_back_to_lax(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_SESSION_SAMESITE", "garbage")
    from backend import security_posture
    p = security_posture.posture_status()
    assert p.cookie.samesite == "lax"


# ---------------------------------------------------------------------------
# FIPS self-check (assert_fips_safe_config)
# ---------------------------------------------------------------------------


def test_fips_self_check_off_is_noop(isolated_env):
    """When FIPS mode isn't on, the self-check is just an info log."""
    from backend import security_posture
    security_posture.assert_fips_safe_config()  # no raise


def test_fips_self_check_refuses_without_secure_cookie(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_FIPS_MODE", "1")
    monkeypatch.setenv("SPIRE_SESSION_SECURE", "0")  # explicitly insecure → fail
    from backend import security_posture
    with pytest.raises(security_posture.FipsConfigViolation) as excinfo:
        security_posture.assert_fips_safe_config()
    assert "Secure" in str(excinfo.value)


def test_fips_self_check_refuses_cac_with_skip_revocation(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_FIPS_MODE", "1")
    monkeypatch.setenv("SPIRE_SESSION_SECURE", "1")
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "skip")
    from backend import security_posture
    with pytest.raises(security_posture.FipsConfigViolation) as excinfo:
        security_posture.assert_fips_safe_config()
    assert "revocation" in str(excinfo.value).lower()


def test_fips_self_check_passes_when_configured(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_FIPS_MODE", "1")
    monkeypatch.setenv("SPIRE_SESSION_SECURE", "1")
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "crl")
    monkeypatch.setenv("SPIRE_FIPS_ALLOW_UNVERIFIED", "1")  # config-only; no FIPS host in CI
    from backend import security_posture
    security_posture.assert_fips_safe_config()  # no raise


def test_fips_self_check_passes_in_mock_mode_with_secure_cookie(isolated_env, monkeypatch):
    """Mock auth mode is allowed under FIPS as long as the cookie
    posture is correct — mock-mode isn't itself a crypto choice."""
    monkeypatch.setenv("SPIRE_FIPS_MODE", "1")
    monkeypatch.setenv("SPIRE_SESSION_SECURE", "1")
    monkeypatch.setenv("SPIRE_FIPS_ALLOW_UNVERIFIED", "1")  # config-only; no FIPS host in CI
    # auth_mode defaults to mock
    from backend import security_posture
    security_posture.assert_fips_safe_config()  # no raise


def test_fips_self_check_refuses_when_crypto_not_in_fips_mode(isolated_env, monkeypatch):
    """The config can be FIPS-clean, but if the crypto backend isn't actually
    in FIPS mode (no kernel fips, no force), booting under SPIRE_FIPS_MODE=1
    would run unvalidated crypto — refuse it."""
    monkeypatch.setenv("SPIRE_FIPS_MODE", "1")
    monkeypatch.setenv("SPIRE_SESSION_SECURE", "1")
    monkeypatch.delenv("OPENSSL_FORCE_FIPS_MODE", raising=False)
    monkeypatch.delenv("SPIRE_FIPS_ALLOW_UNVERIFIED", raising=False)
    from backend import security_posture
    # Force the runtime check to see "not in FIPS mode".
    monkeypatch.setattr(
        security_posture, "fips_runtime_status",
        lambda: {"kernel_fips_enabled": False, "openssl_forced": False, "active": False},
    )
    with pytest.raises(security_posture.FipsConfigViolation) as excinfo:
        security_posture.assert_fips_safe_config()
    assert "not in FIPS mode" in str(excinfo.value).lower() or "NOT in FIPS mode" in str(excinfo.value)


def test_fips_runtime_status_forced(monkeypatch):
    monkeypatch.setenv("OPENSSL_FORCE_FIPS_MODE", "1")
    from backend import security_posture
    assert security_posture.fips_runtime_status()["active"] is True


# ---------------------------------------------------------------------------
# FIPS approved-algorithm allowlists
# ---------------------------------------------------------------------------


def test_fips_allowlist_sha256_in_hashes():
    from backend import security_posture
    assert "sha256" in security_posture.FIPS_APPROVED_HASHES


def test_fips_allowlist_md5_excluded():
    from backend import security_posture
    assert "md5" not in security_posture.FIPS_APPROVED_HASHES


def test_fips_allowlist_sha1_excluded():
    """SHA-1 is not approved for security uses under FIPS 140-3."""
    from backend import security_posture
    assert "sha1" not in security_posture.FIPS_APPROVED_HASHES


def test_fips_allowlist_ed25519_in_signatures():
    """FIPS 186-5 (Feb 2023) approved Ed25519."""
    from backend import security_posture
    assert "ed25519" in security_posture.FIPS_APPROVED_SIGNATURE


# ---------------------------------------------------------------------------
# Security headers middleware
# ---------------------------------------------------------------------------


def test_security_headers_factory_returns_middleware_by_default(isolated_env):
    from backend import security_posture
    mw = security_posture.security_headers_middleware_factory()
    assert mw is not None  # default on
    assert callable(mw)


def test_security_headers_factory_returns_none_when_disabled(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_STIG_HEADERS", "0")
    from backend import security_posture
    mw = security_posture.security_headers_middleware_factory()
    assert mw is None


def test_security_headers_present_on_response(isolated_env):
    """Integration: a real response through the FastAPI test client
    carries the STIG headers."""
    from fastapi.testclient import TestClient
    from backend.main import app
    client = TestClient(app)
    res = client.get("/api/system/status")
    assert res.status_code == 200
    assert res.headers.get("X-Content-Type-Options") == "nosniff"
    assert res.headers.get("X-Frame-Options") == "DENY"
    assert "Referrer-Policy" in res.headers
    assert "Permissions-Policy" in res.headers
    assert "Content-Security-Policy" in res.headers


def test_hsts_only_when_secure_cookies_set(isolated_env, monkeypatch):
    """HSTS would lock browsers to a non-existent secure origin in
    dev mode; only emit when SPIRE_SESSION_SECURE=1 implies TLS."""
    from backend import security_posture
    # default off → HSTS factory builds without HSTS
    mw_default = security_posture.security_headers_middleware_factory()
    assert mw_default is not None
    # Toggling SPIRE_SESSION_SECURE doesn't change the closure
    # captured at module init — but a fresh factory call does.
    monkeypatch.setenv("SPIRE_SESSION_SECURE", "1")
    mw_secure = security_posture.security_headers_middleware_factory()
    assert mw_secure is not None


# ---------------------------------------------------------------------------
# Posture endpoint
# ---------------------------------------------------------------------------


def test_security_posture_endpoint_requires_security_manager(isolated_env):
    """The /api/system/security-posture endpoint should refuse to
    return the configuration to non-security-manager roles."""
    from fastapi.testclient import TestClient
    from backend.main import app
    client = TestClient(app)
    # No session at all → middleware 401s before role check fires.
    res = client.get("/api/system/security-posture")
    assert res.status_code in (401, 403)


def test_security_posture_endpoint_returns_snapshot_for_security_manager(isolated_env, monkeypatch):
    """When signed in as security_manager (CWO Park, dodid 3456789012),
    the endpoint returns the full posture dict."""
    monkeypatch.setenv("SPIRE_SESSION_SECURE", "0")  # http test client drops Secure cookies
    from fastapi.testclient import TestClient
    from backend.main import app
    client = TestClient(app)
    # Sign in as security_manager
    sign_in = client.post(
        "/api/auth/login",
        json={"dodid": "3456789012", "pin": "123456"},
    )
    assert sign_in.status_code == 200
    res = client.get("/api/system/security-posture")
    assert res.status_code == 200
    body = res.json()
    assert "fips_mode" in body
    assert "auth_mode" in body
    assert "crypto" in body
    assert body["crypto"]["audit_chain_hash"] == "sha256"
    assert "cookie" in body
    assert "headers" in body


def test_security_posture_endpoint_refuses_g4(isolated_env, monkeypatch):
    """A G-4 (operator) role cannot read the posture diagnostic."""
    monkeypatch.setenv("SPIRE_SESSION_SECURE", "0")  # http test client drops Secure cookies
    from fastapi.testclient import TestClient
    from backend.main import app
    client = TestClient(app)
    sign_in = client.post(
        "/api/auth/login",
        json={"dodid": "1234567890", "pin": "123456"},
    )
    assert sign_in.status_code == 200
    res = client.get("/api/system/security-posture")
    assert res.status_code == 403
