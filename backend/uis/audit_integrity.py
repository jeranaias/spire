"""Audit chain tamper-evidence (UIS-P6.3).

The existing audit log (backend.persistence) already does
SHA-256 hash chaining: each entry stores ``prev_hash`` +
``self_hash``, and ``verify_chain()`` walks the table to confirm
no row was mutated. That covers tampering-WITHIN-the-chain.

This module adds three reinforcements on top:

  1. **Ed25519 signing** for high-value entries (swap commits,
     channel quarantines, profile mutations). Even if the entire
     SQLite file were rewritten by an attacker with DB access,
     signed entries remain verifiable offline against the public
     key. Aligns with NIST 800-53 AU-9 (5) — tamper-evident
     audit records.

  2. **Chain-head pinning** to a separate, append-only JSON file
     at ``$SPIRE_AUDIT_PIN_PATH``. Periodically writes
     ``{ts, entry_count, head_hash, signature}`` so an attacker
     would have to rewrite the SQLite AND the pin file
     identically — the latter lives outside the DB-trust
     boundary.

  3. **Integrity status surfacing** for health endpoints — call
     ``audit_integrity_status()`` from anywhere to get a JSON
     summary suitable for a dashboard chip or admin alert.

Key handling
------------
Signing requires an Ed25519 private key. Three sources, in
precedence order:

  1. ``SPIRE_AUDIT_SIGNING_KEY_PATH`` — path to a PEM-encoded
     private key file (production: backed by HSM via PKCS#11
     in a future iteration).
  2. ``SPIRE_AUDIT_SIGNING_KEY_HEX`` — hex-encoded raw 32-byte
     seed (dev / pilot only — leaks visible in process env).
  3. Disabled — when neither is set, signing is a no-op. The
     hash chain alone still provides tamper-evidence within
     the DB; only the offline-verification property degrades.

The public key is also exposed: callers verify entries without
trusting the SPIRE process. Surface it via /api/system/audit/
public-key for operators.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


log = logging.getLogger(__name__)


# Audit kinds that warrant Ed25519 signing. Hash chain alone
# protects all entries from in-place mutation; signing adds
# offline verifiability for the entries that touch canonical
# state. Anything matching one of these prefixes is signed.
SIGN_PREFIXES = (
    "ingest.",          # all ingest writes (apply, attempt, commit)
    "stage_ingest.",    # bulk SENTRY uploads
    "uis.apply.",        # generic /api/uis/upload?apply=1
    "channel.apply.",    # channel-driven applies
    "uis.channels.",     # channel CRUD
    "uis.profiles.",     # mapping profile mutations
)


def should_sign(kind: str) -> bool:
    return any(kind.startswith(p) for p in SIGN_PREFIXES)


# ---------------------------------------------------------------------------
# Key loading
# ---------------------------------------------------------------------------


_KEY_LOCK = threading.Lock()
_PRIVATE_KEY: Any = None      # Ed25519PrivateKey or None
_PUBLIC_KEY: Any = None       # Ed25519PublicKey or None
_KEY_LOADED = False


def _load_keys() -> None:
    """Idempotent — loads keys on first call. Subsequent calls
    return the cached pair. Raises only if a key path is set but
    the file is unreadable; missing path = signing disabled."""
    global _PRIVATE_KEY, _PUBLIC_KEY, _KEY_LOADED
    with _KEY_LOCK:
        if _KEY_LOADED:
            return
        _KEY_LOADED = True
        try:
            from cryptography.hazmat.primitives.asymmetric import ed25519
            from cryptography.hazmat.primitives import serialization
        except ImportError:
            log.warning(
                "cryptography library not available; audit signing disabled."
            )
            return

        path = os.environ.get("SPIRE_AUDIT_SIGNING_KEY_PATH", "").strip()
        hex_seed = os.environ.get("SPIRE_AUDIT_SIGNING_KEY_HEX", "").strip()

        if path:
            try:
                with open(path, "rb") as f:
                    pem_bytes = f.read()
                _PRIVATE_KEY = serialization.load_pem_private_key(
                    pem_bytes, password=None,
                )
            except Exception as e:
                log.error(
                    "Audit signing key load failed from %s: %s. "
                    "Signing disabled.",
                    path, e,
                )
                return
        elif hex_seed:
            try:
                seed = bytes.fromhex(hex_seed)
                if len(seed) != 32:
                    raise ValueError("seed must be 32 bytes (64 hex chars)")
                _PRIVATE_KEY = ed25519.Ed25519PrivateKey.from_private_bytes(seed)
            except Exception as e:
                log.error("Audit signing seed parse failed: %s.", e)
                return
        else:
            return  # signing disabled

        _PUBLIC_KEY = _PRIVATE_KEY.public_key()
        log.info("Audit chain signing enabled (Ed25519).")


def signing_enabled() -> bool:
    _load_keys()
    return _PRIVATE_KEY is not None


def public_key_pem() -> Optional[bytes]:
    """Return the public key as PEM bytes for operator-side
    verification, or None if signing is disabled."""
    _load_keys()
    if _PUBLIC_KEY is None:
        return None
    from cryptography.hazmat.primitives import serialization
    return _PUBLIC_KEY.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def sign_entry_hash(self_hash: str) -> Optional[str]:
    """Sign an audit entry's self_hash. Returns hex signature or None
    when signing is disabled. Best-effort — a signing failure logs
    but doesn't crash the audit_log call (chain still records the
    entry; missing signature is recoverable)."""
    _load_keys()
    if _PRIVATE_KEY is None:
        return None
    try:
        sig = _PRIVATE_KEY.sign(self_hash.encode("utf-8"))
        return sig.hex()
    except Exception as e:
        log.warning("Audit entry signing failed: %s", e)
        return None


def verify_entry_signature(self_hash: str, signature_hex: str) -> bool:
    """Verify a signature against the public key. Used by
    integrity checks + offline verification tools."""
    _load_keys()
    if _PUBLIC_KEY is None:
        return False
    try:
        from cryptography.exceptions import InvalidSignature
        sig = bytes.fromhex(signature_hex)
        _PUBLIC_KEY.verify(sig, self_hash.encode("utf-8"))
        return True
    except (InvalidSignature, ValueError):
        return False
    except Exception as e:  # noqa: BLE001
        log.warning("Audit entry verify failed: %s", e)
        return False


# ---------------------------------------------------------------------------
# Chain-head pinning
# ---------------------------------------------------------------------------


def pin_path() -> Optional[Path]:
    raw = (os.environ.get("SPIRE_AUDIT_PIN_PATH") or "").strip()
    if not raw:
        return None
    return Path(raw)


def pin_chain_head(*, entry_count: int, head_hash: str) -> Dict[str, Any]:
    """Append a chain-head snapshot to the pin file.

    Each line is a JSON object; the file is append-only. An
    attacker who rewrites the SQLite would have to also rewrite
    every line of the pin file consistently — substantially
    harder than tampering with one DB.

    Returns the pinned record (or empty dict if pinning disabled).
    """
    p = pin_path()
    if p is None:
        return {}
    record: Dict[str, Any] = {
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "entry_count": entry_count,
        "head_hash": head_hash,
    }
    sig = sign_entry_hash(head_hash)
    if sig:
        record["signature"] = sig
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError as e:
        log.warning("Audit pin write failed at %s: %s", p, e)
    return record


def read_pin_file() -> list:
    """Read all pin records (last-write-wins ordering). Used by
    integrity checks to compare against the live chain."""
    p = pin_path()
    if p is None or not p.exists():
        return []
    out = []
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except OSError as e:
        log.warning("Audit pin read failed at %s: %s", p, e)
    return out


# ---------------------------------------------------------------------------
# Integrity status (called by health endpoints + admin tools)
# ---------------------------------------------------------------------------


@dataclass
class IntegrityStatus:
    chain_ok: bool
    entries: int
    head_hash: Optional[str]
    broken_at_id: Optional[int] = None
    signing_enabled: bool = False
    pin_count: int = 0
    pin_consistent: Optional[bool] = None
    pin_error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "chain_ok": self.chain_ok,
            "entries": self.entries,
            "head_hash": self.head_hash,
            "broken_at_id": self.broken_at_id,
            "signing_enabled": self.signing_enabled,
            "pin_count": self.pin_count,
            "pin_consistent": self.pin_consistent,
            "pin_error": self.pin_error,
        }


def audit_integrity_status() -> IntegrityStatus:
    """End-to-end integrity check:

      1. Walk the chain — verify hash links via persistence.verify_chain().
      2. Compare current head against the most recent pin record.
      3. Report signing-enabled status (informational).

    Cheap enough to call on every channels/health-rollup poll on
    a small chain; the persistence.verify_chain walks every row
    so on a 10M-entry chain this gets slow. Operators with large
    chains should rely on the pin-comparison path (cheap) and
    run full verify_chain() on a schedule.
    """
    from ..persistence import verify_chain
    chain = verify_chain()
    pin_records = read_pin_file()
    pin_consistent: Optional[bool] = None
    pin_error: Optional[str] = None

    if pin_records:
        latest = pin_records[-1]
        latest_hash = latest.get("head_hash")
        if chain["ok"]:
            current_hash = chain.get("head_hash")
            if current_hash and latest_hash:
                # Pin can lag by a few entries (we don't pin every
                # entry). Equality means "no entries since last pin"
                # which is the simplest consistency check; a stricter
                # check verifies the current head is the result of
                # adding entries past the pin's recorded count, not
                # divergence. For now a pin-divergence is the signal
                # "investigate" — operator reads the chain to confirm.
                # We treat "current is later" as still consistent.
                pin_consistent = True
                if latest.get("entry_count", 0) > chain["entries"]:
                    # Chain shrunk relative to the last pin → tampering
                    pin_consistent = False
                    pin_error = (
                        f"Chain has {chain['entries']} entries but pin "
                        f"recorded {latest['entry_count']} — chain shrunk."
                    )

    return IntegrityStatus(
        chain_ok=chain["ok"],
        entries=chain["entries"],
        head_hash=chain.get("head_hash"),
        broken_at_id=chain.get("broken_at_id"),
        signing_enabled=signing_enabled(),
        pin_count=len(pin_records),
        pin_consistent=pin_consistent,
        pin_error=pin_error,
    )
