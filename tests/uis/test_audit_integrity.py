"""Audit chain tamper-evidence tests (UIS-P6.3)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

cryptography = pytest.importorskip("cryptography")
from cryptography.hazmat.primitives.asymmetric import ed25519


@pytest.fixture
def isolated_db(monkeypatch, tmp_path):
    """Fresh SQLite DB + reset signing-key state for each test."""
    db_file = tmp_path / "audit.sqlite"
    from backend import persistence
    monkeypatch.setattr(persistence, "DB_PATH", db_file)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", None)
    persistence.init_db()
    # Reset cached audit-integrity key state — the module caches it
    from backend.uis import audit_integrity
    monkeypatch.setattr(audit_integrity, "_PRIVATE_KEY", None)
    monkeypatch.setattr(audit_integrity, "_PUBLIC_KEY", None)
    monkeypatch.setattr(audit_integrity, "_KEY_LOADED", False)
    return db_file


@pytest.fixture
def with_signing_key(monkeypatch, isolated_db):
    """Configure a fresh Ed25519 seed for signing tests."""
    seed = b"\x42" * 32
    monkeypatch.setenv("SPIRE_AUDIT_SIGNING_KEY_HEX", seed.hex())
    return seed


# ---------------------------------------------------------------------------
# Sign / verify round-trip
# ---------------------------------------------------------------------------


def test_signing_disabled_when_no_key(isolated_db, monkeypatch):
    monkeypatch.delenv("SPIRE_AUDIT_SIGNING_KEY_HEX", raising=False)
    monkeypatch.delenv("SPIRE_AUDIT_SIGNING_KEY_PATH", raising=False)
    from backend.uis.audit_integrity import signing_enabled, sign_entry_hash
    assert signing_enabled() is False
    # sign returns None when disabled — caller handles gracefully
    assert sign_entry_hash("a" * 64) is None


def test_signing_enabled_round_trip(with_signing_key):
    from backend.uis.audit_integrity import (
        signing_enabled,
        sign_entry_hash,
        verify_entry_signature,
    )
    assert signing_enabled() is True
    sig = sign_entry_hash("0" * 64)
    assert sig is not None
    assert verify_entry_signature("0" * 64, sig) is True
    # Tampered hash → sig invalid
    assert verify_entry_signature("1" * 64, sig) is False


def test_public_key_pem_returned_when_signing_enabled(with_signing_key):
    from backend.uis.audit_integrity import public_key_pem
    pem = public_key_pem()
    assert pem is not None
    assert b"-----BEGIN PUBLIC KEY-----" in pem


def test_public_key_pem_none_when_disabled(isolated_db, monkeypatch):
    monkeypatch.delenv("SPIRE_AUDIT_SIGNING_KEY_HEX", raising=False)
    monkeypatch.delenv("SPIRE_AUDIT_SIGNING_KEY_PATH", raising=False)
    from backend.uis.audit_integrity import public_key_pem
    assert public_key_pem() is None


# ---------------------------------------------------------------------------
# audit_log integration — high-value entries get signed
# ---------------------------------------------------------------------------


def test_audit_log_signs_ingest_entries(with_signing_key):
    from backend import persistence
    entry = persistence.log(
        kind="ingest.ecp.apply.commit",
        actor="u",
        subject_id="tok123",
        payload={"counts": {"new": 1}},
    )
    assert entry["signature"] is not None
    # Verify signature against the recorded self_hash
    from backend.uis.audit_integrity import verify_entry_signature
    assert verify_entry_signature(entry["self_hash"], entry["signature"])


def test_audit_log_does_not_sign_low_value_entries(with_signing_key):
    from backend import persistence
    entry = persistence.log(
        kind="login.success",  # not in SIGN_PREFIXES
        actor="u",
        payload={"dodid": "1234"},
    )
    assert entry["signature"] is None


def test_audit_log_works_when_signing_disabled(isolated_db, monkeypatch):
    monkeypatch.delenv("SPIRE_AUDIT_SIGNING_KEY_HEX", raising=False)
    monkeypatch.delenv("SPIRE_AUDIT_SIGNING_KEY_PATH", raising=False)
    from backend import persistence
    entry = persistence.log(
        kind="ingest.ecp.apply.commit",
        actor="u",
        payload={"x": 1},
    )
    # Chain still records the entry; just no signature
    assert entry["signature"] is None
    assert entry["self_hash"]


# ---------------------------------------------------------------------------
# Chain head pinning
# ---------------------------------------------------------------------------


def test_pin_chain_head_writes_record(isolated_db, monkeypatch, tmp_path):
    pin_file = tmp_path / "audit-pin.jsonl"
    monkeypatch.setenv("SPIRE_AUDIT_PIN_PATH", str(pin_file))
    from backend.uis.audit_integrity import pin_chain_head, read_pin_file
    rec = pin_chain_head(entry_count=42, head_hash="deadbeef" * 8)
    assert rec["entry_count"] == 42
    assert pin_file.exists()
    records = read_pin_file()
    assert len(records) == 1
    assert records[0]["head_hash"] == "deadbeef" * 8


def test_pin_chain_head_no_op_when_disabled(isolated_db, monkeypatch):
    monkeypatch.delenv("SPIRE_AUDIT_PIN_PATH", raising=False)
    from backend.uis.audit_integrity import pin_chain_head
    rec = pin_chain_head(entry_count=1, head_hash="a" * 64)
    assert rec == {}


def test_pin_chain_head_signs_when_signing_enabled(with_signing_key, monkeypatch, tmp_path):
    pin_file = tmp_path / "pin.jsonl"
    monkeypatch.setenv("SPIRE_AUDIT_PIN_PATH", str(pin_file))
    from backend.uis.audit_integrity import pin_chain_head
    rec = pin_chain_head(entry_count=10, head_hash="b" * 64)
    assert rec.get("signature") is not None


# ---------------------------------------------------------------------------
# Integrity status — end-to-end
# ---------------------------------------------------------------------------


def test_integrity_status_clean_chain(isolated_db):
    from backend import persistence
    persistence.log(kind="x", actor="u", payload={"a": 1})
    persistence.log(kind="y", actor="u", payload={"b": 2})
    from backend.uis.audit_integrity import audit_integrity_status
    status = audit_integrity_status()
    assert status.chain_ok is True
    assert status.entries == 2


def test_integrity_status_detects_pin_inconsistency(isolated_db, monkeypatch, tmp_path):
    """Pin file recorded count=10; chain has only 2. Tampering."""
    pin_file = tmp_path / "pin.jsonl"
    monkeypatch.setenv("SPIRE_AUDIT_PIN_PATH", str(pin_file))
    from backend import persistence
    from backend.uis.audit_integrity import (
        audit_integrity_status,
        pin_chain_head,
    )

    persistence.log(kind="x", actor="u", payload={})
    persistence.log(kind="y", actor="u", payload={})
    # Forge a pin claiming 10 entries
    pin_chain_head(entry_count=10, head_hash="forged")

    status = audit_integrity_status()
    assert status.chain_ok is True       # in-DB chain itself is fine
    assert status.pin_consistent is False  # but the pin says we lost rows
    assert "shrunk" in (status.pin_error or "")


def test_integrity_status_chain_break_via_direct_db_mutation(isolated_db):
    """Tampered DB row → chain_ok=False + broken_at_id surfaces."""
    from backend import persistence
    persistence.log(kind="x", actor="u", payload={"orig": 1})
    persistence.log(kind="y", actor="u", payload={"orig": 2})

    # Direct UPDATE bypasses log() so the self_hash no longer
    # matches the row contents
    with persistence.conn() as c:
        c.execute(
            "UPDATE audit_log SET payload = ? WHERE id = 1",
            (json.dumps({"tampered": "true"}),),
        )

    from backend.uis.audit_integrity import audit_integrity_status
    status = audit_integrity_status()
    assert status.chain_ok is False
    assert status.broken_at_id == 1


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------


@pytest.fixture
def sm_client(monkeypatch, isolated_db):
    from fastapi.testclient import TestClient
    from backend.main import app
    c = TestClient(app)
    r = c.post("/api/auth/login", json={"dodid": "3456789012", "pin": "000000"})
    assert r.status_code == 200, r.text
    return c


def test_rest_integrity_endpoint_returns_status(sm_client):
    r = sm_client.get("/api/system/audit/integrity")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "chain_ok" in body
    assert "entries" in body
    assert "signing_enabled" in body


def test_rest_public_key_endpoint_404_when_signing_disabled(sm_client, monkeypatch):
    monkeypatch.delenv("SPIRE_AUDIT_SIGNING_KEY_HEX", raising=False)
    monkeypatch.delenv("SPIRE_AUDIT_SIGNING_KEY_PATH", raising=False)
    # Reset cached state on the audit_integrity module
    from backend.uis import audit_integrity
    monkeypatch.setattr(audit_integrity, "_PRIVATE_KEY", None)
    monkeypatch.setattr(audit_integrity, "_PUBLIC_KEY", None)
    monkeypatch.setattr(audit_integrity, "_KEY_LOADED", False)
    r = sm_client.get("/api/system/audit/public-key")
    assert r.status_code == 404
    assert "signing is disabled" in r.text.lower()


def test_rest_public_key_endpoint_returns_pem_when_enabled(sm_client, monkeypatch):
    seed = b"\x99" * 32
    monkeypatch.setenv("SPIRE_AUDIT_SIGNING_KEY_HEX", seed.hex())
    from backend.uis import audit_integrity
    monkeypatch.setattr(audit_integrity, "_PRIVATE_KEY", None)
    monkeypatch.setattr(audit_integrity, "_PUBLIC_KEY", None)
    monkeypatch.setattr(audit_integrity, "_KEY_LOADED", False)
    r = sm_client.get("/api/system/audit/public-key")
    assert r.status_code == 200, r.text
    body = r.json()
    assert "BEGIN PUBLIC KEY" in body["public_key_pem"]
