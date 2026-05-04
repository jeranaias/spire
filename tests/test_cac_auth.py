"""Tests for CAC/PIV cert-based auth scaffolding (UIS-P6.1).

Cardinal property the suite enforces:

* The mock PIN demo flow must keep working when ``SPIRE_AUTH_MODE`` is
  unset or ``"mock"``. Toggling to ``"cac"`` or ``"hybrid"`` is the only
  way the cert path goes live.

The fixture CAs are generated in-process via ``cryptography.hazmat`` so
the suite never needs a real DoD PKI bundle on disk.
"""
from __future__ import annotations

import os
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from backend import cac_auth


# ---------------------------------------------------------------------------
# Fixture CA + leaf cert helpers
# ---------------------------------------------------------------------------


def _build_ca(common_name: str) -> Tuple[x509.Certificate, rsa.RSAPrivateKey]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "U.S. Government"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "DoD"),
        x509.NameAttribute(NameOID.COMMON_NAME, common_name),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(timezone.utc) - timedelta(days=1))
        .not_valid_after(datetime.now(timezone.utc) + timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    return cert, key


def _build_leaf(
    *,
    issuer_cert: x509.Certificate,
    issuer_key: rsa.RSAPrivateKey,
    subject_cn: str,
    not_before: Optional[datetime] = None,
    not_after: Optional[datetime] = None,
) -> Tuple[x509.Certificate, rsa.RSAPrivateKey]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    nb = not_before or (datetime.now(timezone.utc) - timedelta(days=1))
    na = not_after or (datetime.now(timezone.utc) + timedelta(days=180))
    subject = x509.Name([
        x509.NameAttribute(NameOID.COUNTRY_NAME, "US"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "U.S. Government"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "DoD"),
        x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, "USMC"),
        x509.NameAttribute(NameOID.COMMON_NAME, subject_cn),
    ])
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer_cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(nb)
        .not_valid_after(na)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(issuer_key, hashes.SHA256())
    )
    return cert, key


def _pem(cert: x509.Certificate) -> bytes:
    return cert.public_bytes(serialization.Encoding.PEM)


# ---------------------------------------------------------------------------
# Module-level fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def isolated_env(monkeypatch):
    """Strip every CAC-related env var so each test starts at defaults."""
    for var in (
        "SPIRE_AUTH_MODE",
        "SPIRE_CAC_TRUST_DIR",
        "SPIRE_CAC_REVOCATION_MODE",
    ):
        monkeypatch.delenv(var, raising=False)
    cac_auth.reset_trust_anchor_cache()
    yield
    cac_auth.reset_trust_anchor_cache()


@pytest.fixture
def reyes_chain(isolated_env, monkeypatch):
    """Build a fixture trust anchor + leaf cert with a CN that matches
    GySgt Reyes' EDIPI in MOCK_USERS (1234567890)."""
    ca_cert, ca_key = _build_ca("Test DoD Root CA")
    leaf_cert, leaf_key = _build_leaf(
        issuer_cert=ca_cert,
        issuer_key=ca_key,
        subject_cn="REYES.MARCUS.X.1234567890",
    )
    cac_auth.set_trust_anchors_for_testing([ca_cert])
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "skip")
    return {
        "ca_cert": ca_cert,
        "ca_key": ca_key,
        "leaf_cert": leaf_cert,
        "leaf_key": leaf_key,
        "leaf_pem": _pem(leaf_cert),
    }


# ---------------------------------------------------------------------------
# Mode selector
# ---------------------------------------------------------------------------


def test_mode_defaults_to_mock(isolated_env):
    assert cac_auth.auth_mode() == "mock"
    assert cac_auth.cac_required() is False
    assert cac_auth.pin_path_disabled() is False


def test_mode_cac_disables_pin(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    assert cac_auth.auth_mode() == "cac"
    assert cac_auth.cac_required() is True
    assert cac_auth.pin_path_disabled() is True


def test_mode_hybrid_keeps_pin_open(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_AUTH_MODE", "hybrid")
    assert cac_auth.auth_mode() == "hybrid"
    assert cac_auth.cac_required() is False
    assert cac_auth.pin_path_disabled() is False


def test_mode_unknown_falls_back_to_mock(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_AUTH_MODE", "garbage-value")
    assert cac_auth.auth_mode() == "mock"


# ---------------------------------------------------------------------------
# EDIPI extraction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "cn, expected",
    [
        ("REYES.MARCUS.X.1234567890", "1234567890"),
        ("KOWALSKI.DIANA.2345678901", "2345678901"),
        ("PARK.JAMES.Y.3456789012", "3456789012"),
        ("HAYES.ROBERT.Z.4567890123", "4567890123"),
        ("VAN-DER-BERG.PIETER.A.9999999999", "9999999999"),
        ("OBRIEN.SEAN.OFLAHERTY.0000000001", "0000000001"),
    ],
)
def test_extract_edipi_happy(cn, expected):
    assert cac_auth.extract_edipi_from_cn(cn) == expected


@pytest.mark.parametrize(
    "cn",
    [
        "REYES.MARCUS.X",                # no digits at all
        "REYES.MARCUS.X.123456789",      # 9 digits, not 10
        "REYES.MARCUS.X.12345678901",    # 11 digits
        "1234567890.REYES.MARCUS.X",     # digits but not at end
        "",
        "Test DoD Root CA",
    ],
)
def test_extract_edipi_rejects_bad_shapes(cn):
    assert cac_auth.extract_edipi_from_cn(cn) is None


# ---------------------------------------------------------------------------
# Cert parse
# ---------------------------------------------------------------------------


def test_parse_client_cert_extracts_fields(reyes_chain):
    info = cac_auth.parse_client_cert(reyes_chain["leaf_pem"])
    assert info is not None
    assert info.edipi == "1234567890"
    assert info.subject_cn == "REYES.MARCUS.X.1234567890"
    assert info.issuer_cn == "Test DoD Root CA"
    assert info.serial_hex  # non-empty
    assert info.not_after > datetime.now(timezone.utc)


def test_parse_client_cert_rejects_garbage():
    assert cac_auth.parse_client_cert(b"definitely not a PEM") is None
    assert cac_auth.parse_client_cert(b"") is None


# ---------------------------------------------------------------------------
# Forwarded cert extraction
# ---------------------------------------------------------------------------


def test_extract_from_x_client_cert_url_encoded(reyes_chain):
    encoded = urllib.parse.quote(reyes_chain["leaf_pem"].decode("utf-8"))
    headers = {"X-Client-Cert": encoded}
    pem = cac_auth.extract_forwarded_cert(headers)
    assert pem is not None
    assert b"BEGIN CERTIFICATE" in pem


def test_extract_from_x_ssl_client_cert_raw(reyes_chain):
    # Apache mod_ssl forwards with newlines collapsed to spaces.
    raw = reyes_chain["leaf_pem"].decode("utf-8").replace("\n", " ")
    headers = {"X-SSL-Client-Cert": raw}
    pem = cac_auth.extract_forwarded_cert(headers)
    assert pem is not None
    info = cac_auth.parse_client_cert(pem)
    assert info is not None
    assert info.edipi == "1234567890"


def test_extract_from_asgi_scope(reyes_chain):
    headers: dict = {}
    scope_ext = {"tls": {"client_cert": reyes_chain["leaf_pem"]}}
    pem = cac_auth.extract_forwarded_cert(headers, scope_extensions=scope_ext)
    assert pem == reyes_chain["leaf_pem"]


def test_extract_returns_none_when_no_cert(isolated_env):
    assert cac_auth.extract_forwarded_cert({}) is None


# ---------------------------------------------------------------------------
# Chain validation
# ---------------------------------------------------------------------------


def test_chain_valid_against_anchor(reyes_chain):
    cert = x509.load_pem_x509_certificate(reyes_chain["leaf_pem"])
    ok, reason = cac_auth.validate_chain(cert, [reyes_chain["ca_cert"]])
    assert ok is True
    assert reason == "ok"


def test_chain_rejects_when_anchor_set_empty(reyes_chain):
    cert = x509.load_pem_x509_certificate(reyes_chain["leaf_pem"])
    ok, reason = cac_auth.validate_chain(cert, [])
    assert ok is False
    assert reason == "no_trust_anchors"


def test_chain_rejects_unrelated_anchor(reyes_chain):
    other_ca, _ = _build_ca("Some Other CA")
    cert = x509.load_pem_x509_certificate(reyes_chain["leaf_pem"])
    ok, reason = cac_auth.validate_chain(cert, [other_ca])
    assert ok is False
    assert reason == "untrusted"


# ---------------------------------------------------------------------------
# End-to-end authenticate_cac
# ---------------------------------------------------------------------------


def test_authenticate_cac_happy_path_resolves_user(reyes_chain):
    result = cac_auth.authenticate_cac(reyes_chain["leaf_pem"])
    assert result.ok is True, result.message
    assert result.reason == "ok"
    assert result.user is not None
    assert result.user["dodid"] == "1234567890"
    assert result.user["role"] == "g4"


def test_authenticate_cac_rejects_in_mock_mode(reyes_chain, monkeypatch):
    # Override back to mock.
    monkeypatch.setenv("SPIRE_AUTH_MODE", "mock")
    result = cac_auth.authenticate_cac(reyes_chain["leaf_pem"])
    assert result.ok is False
    assert result.reason == "mode_disabled"


def test_authenticate_cac_expired_cert_rejected(isolated_env, monkeypatch):
    ca_cert, ca_key = _build_ca("Test DoD Root CA")
    expired_cert, _ = _build_leaf(
        issuer_cert=ca_cert,
        issuer_key=ca_key,
        subject_cn="REYES.MARCUS.X.1234567890",
        not_before=datetime.now(timezone.utc) - timedelta(days=400),
        not_after=datetime.now(timezone.utc) - timedelta(days=1),
    )
    cac_auth.set_trust_anchors_for_testing([ca_cert])
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "skip")
    result = cac_auth.authenticate_cac(_pem(expired_cert))
    assert result.ok is False
    assert result.reason == "expired"


def test_authenticate_cac_not_yet_valid_rejected(isolated_env, monkeypatch):
    ca_cert, ca_key = _build_ca("Test DoD Root CA")
    future_cert, _ = _build_leaf(
        issuer_cert=ca_cert,
        issuer_key=ca_key,
        subject_cn="REYES.MARCUS.X.1234567890",
        not_before=datetime.now(timezone.utc) + timedelta(days=10),
        not_after=datetime.now(timezone.utc) + timedelta(days=200),
    )
    cac_auth.set_trust_anchors_for_testing([ca_cert])
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "skip")
    result = cac_auth.authenticate_cac(_pem(future_cert))
    assert result.ok is False
    assert result.reason == "not_yet_valid"


def test_authenticate_cac_untrusted_chain_rejected(isolated_env, monkeypatch):
    real_ca, real_ca_key = _build_ca("Test DoD Root CA")
    attacker_ca, attacker_key = _build_ca("Attacker CA")
    leaf, _ = _build_leaf(
        issuer_cert=attacker_ca,
        issuer_key=attacker_key,
        subject_cn="REYES.MARCUS.X.1234567890",
    )
    cac_auth.set_trust_anchors_for_testing([real_ca])
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "skip")
    result = cac_auth.authenticate_cac(_pem(leaf))
    assert result.ok is False
    assert result.reason == "untrusted"


def test_authenticate_cac_no_edipi_rejected(isolated_env, monkeypatch):
    ca_cert, ca_key = _build_ca("Test DoD Root CA")
    leaf, _ = _build_leaf(
        issuer_cert=ca_cert,
        issuer_key=ca_key,
        subject_cn="John Smith",  # no EDIPI suffix
    )
    cac_auth.set_trust_anchors_for_testing([ca_cert])
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "skip")
    result = cac_auth.authenticate_cac(_pem(leaf))
    assert result.ok is False
    assert result.reason == "no_edipi"


def test_authenticate_cac_unknown_edipi_rejected(isolated_env, monkeypatch):
    ca_cert, ca_key = _build_ca("Test DoD Root CA")
    leaf, _ = _build_leaf(
        issuer_cert=ca_cert,
        issuer_key=ca_key,
        subject_cn="GHOST.OPERATOR.X.9999999999",  # not in MOCK_USERS
    )
    cac_auth.set_trust_anchors_for_testing([ca_cert])
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "skip")
    result = cac_auth.authenticate_cac(_pem(leaf))
    assert result.ok is False
    assert result.reason == "edipi_unknown"


def test_authenticate_cac_revocation_mode_unimplemented_rejects(reyes_chain, monkeypatch):
    # OCSP and CRL stubs are intentionally not wired up — they MUST
    # fail closed so a misconfigured deployment doesn't silently skip.
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "ocsp")
    result = cac_auth.authenticate_cac(reyes_chain["leaf_pem"])
    assert result.ok is False
    assert result.reason == "revoked"


def test_authenticate_cac_malformed_cert_rejected(isolated_env, monkeypatch):
    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    monkeypatch.setenv("SPIRE_CAC_REVOCATION_MODE", "skip")
    result = cac_auth.authenticate_cac(b"not a cert")
    assert result.ok is False
    assert result.reason == "malformed"


# ---------------------------------------------------------------------------
# Demo guarantee — the load-bearing user-facing assertion.
# ---------------------------------------------------------------------------


def test_demo_pin_flow_unaffected_by_default(isolated_env):
    """The PIN demo flow MUST stay open while SPIRE_AUTH_MODE is unset.
    This test would have caught it if I'd accidentally made the cert
    path mandatory."""
    assert cac_auth.auth_mode() == "mock"
    assert cac_auth.pin_path_disabled() is False


# ---------------------------------------------------------------------------
# /api/auth/mode capability probe + endpoint integration
# ---------------------------------------------------------------------------


def test_auth_mode_endpoint_default(isolated_env):
    from fastapi.testclient import TestClient
    from backend.main import app

    client = TestClient(app)
    res = client.get("/api/auth/mode")
    assert res.status_code == 200
    body = res.json()
    assert body["mode"] == "mock"
    assert body["pin_enabled"] is True
    assert body["cac_enabled"] is False


def test_pin_login_returns_410_when_cac_required(isolated_env, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import app

    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    client = TestClient(app)
    res = client.post(
        "/api/auth/login",
        json={"dodid": "1234567890", "pin": "123456"},
    )
    assert res.status_code == 410
    assert res.headers.get("X-Spire-Auth-Mode") == "cac"


def test_cac_endpoint_inert_in_mock_mode(isolated_env):
    from fastapi.testclient import TestClient
    from backend.main import app

    client = TestClient(app)
    res = client.post("/api/auth/cac")
    assert res.status_code == 410
    assert res.headers.get("X-Spire-Auth-Mode") == "mock"


def test_cac_endpoint_accepts_forwarded_cert(reyes_chain):
    from fastapi.testclient import TestClient
    from backend.main import app

    client = TestClient(app)
    encoded = urllib.parse.quote(reyes_chain["leaf_pem"].decode("utf-8"))
    res = client.post(
        "/api/auth/cac",
        headers={"X-Client-Cert": encoded},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True
    assert body["user"]["dodid"] == "1234567890"
    assert body["auth_path"] == "cac"
    assert body["cert"]["subject_cn"] == "REYES.MARCUS.X.1234567890"
    # session cookie set so subsequent calls authenticate normally
    assert "spire_session" in res.cookies


def test_cac_endpoint_rejects_no_cert(isolated_env, monkeypatch):
    from fastapi.testclient import TestClient
    from backend.main import app

    monkeypatch.setenv("SPIRE_AUTH_MODE", "cac")
    client = TestClient(app)
    res = client.post("/api/auth/cac")
    assert res.status_code == 401
    assert res.json()["detail"]["reason"] == "no_cert"
