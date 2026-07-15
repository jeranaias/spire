"""Audit signing works with ECDSA/RSA keys, not just Ed25519 (P2-9)."""
from __future__ import annotations

import pytest

cryptography = pytest.importorskip("cryptography")
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa


def _reset_keys(monkeypatch):
    from backend.uis import audit_integrity as ai
    monkeypatch.setattr(ai, "_PRIVATE_KEY", None)
    monkeypatch.setattr(ai, "_PUBLIC_KEY", None)
    monkeypatch.setattr(ai, "_KEY_LOADED", False)
    return ai


def _install_pem(monkeypatch, tmp_path, key):
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    p = tmp_path / "signing.pem"
    p.write_bytes(pem)
    monkeypatch.setenv("SPIRE_AUDIT_SIGNING_KEY_PATH", str(p))
    monkeypatch.delenv("SPIRE_AUDIT_SIGNING_KEY_HEX", raising=False)
    return _reset_keys(monkeypatch)


@pytest.mark.parametrize("make_key", [
    lambda: ec.generate_private_key(ec.SECP384R1()),
    lambda: rsa.generate_private_key(public_exponent=65537, key_size=2048),
])
def test_pem_key_signs_and_verifies(monkeypatch, tmp_path, make_key):
    ai = _install_pem(monkeypatch, tmp_path, make_key())
    h = "a" * 64
    sig = ai.sign_entry_hash(h)
    assert sig is not None
    assert ai.verify_entry_signature(h, sig) is True
    # Tampered hash → invalid.
    assert ai.verify_entry_signature("b" * 64, sig) is False
