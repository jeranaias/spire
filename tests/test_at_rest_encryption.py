"""At-rest DB encryption tests — AES-256-GCM, per-install salt, legacy migration."""
from __future__ import annotations

import base64

import pytest

cryptography = pytest.importorskip("cryptography")
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from backend import persistence


@pytest.fixture
def crypto_paths(monkeypatch, tmp_path):
    """Isolate the salt sidecar + clear the derived-key cache per test."""
    monkeypatch.setattr(persistence, "DB_SALT_PATH", tmp_path / "spire.db.salt")
    monkeypatch.setattr(persistence, "_DERIVED_KEY_CACHE", {})
    return tmp_path


def test_gcm_roundtrip(crypto_paths):
    data = b"canonical audit rows and readiness snapshots" * 100
    blob = persistence._encrypt_blob(data, "correct horse battery staple")
    assert blob[: len(persistence._GCM_MAGIC)] == persistence._GCM_MAGIC
    assert data not in blob  # not plaintext-adjacent
    assert persistence._decrypt_blob(blob, "correct horse battery staple") == data


def test_wrong_passphrase_rejected(crypto_paths):
    blob = persistence._encrypt_blob(b"secret", "right")
    with pytest.raises(Exception):  # InvalidTag under the hood
        persistence._decrypt_blob(blob, "wrong")


def test_nonce_is_unique_per_encryption(crypto_paths):
    a = persistence._encrypt_blob(b"same", "pw")
    b = persistence._encrypt_blob(b"same", "pw")
    assert a != b  # random nonce → distinct ciphertexts for identical input


def test_salt_is_embedded_and_portable(crypto_paths, tmp_path, monkeypatch):
    """A blob encrypted under one install decrypts on another (different
    sidecar salt), because the salt travels in the header."""
    blob = persistence._encrypt_blob(b"portable", "pw")
    # Simulate a different install: new empty salt sidecar.
    monkeypatch.setattr(persistence, "DB_SALT_PATH", tmp_path / "other.salt")
    monkeypatch.setattr(persistence, "_DERIVED_KEY_CACHE", {})
    assert persistence._decrypt_blob(blob, "pw") == b"portable"


def test_per_install_salt_is_stable_and_random(crypto_paths):
    first = persistence._install_salt()
    assert len(first) == 16
    assert persistence._install_salt() == first  # stable once created


def test_legacy_fernet_blob_migrates(crypto_paths):
    """A pre-GCM Fernet blob (legacy fixed salt) is still readable, so an
    existing encrypted DB isn't bricked by the upgrade."""
    from cryptography.fernet import Fernet

    passphrase = "legacy-pass"
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=persistence._LEGACY_KDF_SALT,
        iterations=persistence._KDF_ITERATIONS,
    )
    legacy_key = base64.urlsafe_b64encode(kdf.derive(passphrase.encode()))
    legacy_blob = Fernet(legacy_key).encrypt(b"old data")

    assert legacy_blob[: len(persistence._GCM_MAGIC)] != persistence._GCM_MAGIC
    assert persistence._decrypt_blob(legacy_blob, passphrase) == b"old data"


def test_full_lock_unlock_cycle(crypto_paths, tmp_path, monkeypatch):
    """Encrypt the DB on lock, decrypt it back on unlock."""
    db = tmp_path / "spire.db"
    enc = tmp_path / "spire.db.enc"
    monkeypatch.setattr(persistence, "DB_PATH", db)
    monkeypatch.setattr(persistence, "DB_ENCRYPTED_PATH", enc)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", "pw")

    db.write_bytes(b"sqlite payload")
    persistence._lock_db()
    assert enc.exists()
    assert enc.read_bytes()[: len(persistence._GCM_MAGIC)] == persistence._GCM_MAGIC

    db.unlink()
    persistence._unlock_db()
    assert db.read_bytes() == b"sqlite payload"
