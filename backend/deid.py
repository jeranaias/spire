"""Keyed de-identification digests (P2-7).

Sensitive identifiers (EDIPI, serial, UIC, SR number) are pseudonymized with a
**keyed HMAC**, not a bare SHA-256. A plain hash of a low-entropy identifier —
a 10-digit EDIPI has only 10^10 values — is reversible by brute force in
seconds. HMAC under a per-install secret key defeats that: without the key an
attacker can't precompute the mapping.

The key is stable per install (so the same value pseudonymizes identically
across exports, preserving joins) and secret:

  1. SPIRE_DEID_KEY (env) if set, else
  2. a random 32-byte key persisted to runtime/spire.deid.key on first use.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from pathlib import Path
from typing import Optional

_KEY_PATH = Path(__file__).resolve().parent.parent / "runtime" / "spire.deid.key"
_key_cache: Optional[bytes] = None


def deid_key() -> bytes:
    """Return the stable per-install de-id key, creating it on first use."""
    global _key_cache
    if _key_cache is not None:
        return _key_cache
    env = os.environ.get("SPIRE_DEID_KEY", "").strip()
    if env:
        _key_cache = env.encode("utf-8")
        return _key_cache
    try:
        if _KEY_PATH.exists():
            _key_cache = _KEY_PATH.read_bytes()
            return _key_cache
    except OSError:
        pass
    key = secrets.token_bytes(32)
    try:
        _KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
        _KEY_PATH.write_bytes(key)
    except OSError:
        pass  # read-only fs → ephemeral key for this process
    _key_cache = key
    return key


def _mac(value: str) -> bytes:
    return hmac.new(deid_key(), value.encode("utf-8"), hashlib.sha256).digest()


def digest_hex20(value: str) -> str:
    """20 hex chars of the keyed MAC (SPIRE uppercase-prefix export shape)."""
    return _mac(value).hex()[:20]


def digest_b64url20(value: str) -> str:
    """20 base64url chars of the keyed MAC (real GCSS-MC lowercase-prefix shape)."""
    return base64.urlsafe_b64encode(_mac(value)[:15]).decode("ascii").rstrip("=")
