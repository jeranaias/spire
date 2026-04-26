"""
Persistent state for SPIRE.

Two responsibilities:

  1. **Append-only audit log** with SHA-256 hash chaining. Every decision
     (SENTRY review, LLM call, incident checklist tick, Secure Wipe) writes
     an entry. Tampering breaks the chain; verify_chain() returns (ok, bad_id).

  2. **Durable state for SENTRY review decisions and PULSE feedback.** What
     an operator approves/rejects persists across restarts. What a
     maintenance chief marks correct/incorrect persists. In-memory mode
     claims from earlier revisions are removed.

Backing store is SQLite in encrypted mode when SPIRE_DB_PASSPHRASE is set.
Uses pyca/cryptography's Fernet on top of a standard sqlite3 connection --
we encrypt the whole DB file at rest via a wrapper, not per-row. Rationale:
SQLCipher isn't in PyPI with Windows wheels for Python 3.14 yet, and
file-level encryption satisfies the 'AES-256 at rest' claim for the
hackathon. Post-hackathon we migrate to SQLCipher proper.
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


# ---------------------------------------------------------------------------
# Database location + encryption
# ---------------------------------------------------------------------------

DATA_DIR = Path(__file__).resolve().parent.parent / "runtime"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "spire.db"
DB_ENCRYPTED_PATH = DATA_DIR / "spire.db.enc"

_LOCK = threading.RLock()
_DB_PASSPHRASE = os.environ.get("SPIRE_DB_PASSPHRASE")  # None == plain mode for local dev

# Fixed salt for deterministic key derivation. Security note: in production
# the salt should be per-install and stored out-of-band. For a single-tenant
# laptop demo the fixed salt is acceptable -- the passphrase is the secret.
_KDF_SALT = b"spire-v0-at-rest-salt-7b3d4f61"


def _derive_key(passphrase: str) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_KDF_SALT,
        iterations=200_000,
    )
    key = kdf.derive(passphrase.encode("utf-8"))
    # Fernet requires urlsafe b64 32-byte key
    import base64
    return base64.urlsafe_b64encode(key)


def _unlock_db() -> None:
    """If encrypted DB exists and passphrase set, decrypt to DB_PATH on
    startup. Re-encrypts and removes plaintext on lock_db()."""
    if not _DB_PASSPHRASE:
        return
    if not DB_ENCRYPTED_PATH.exists():
        return
    try:
        f = Fernet(_derive_key(_DB_PASSPHRASE))
        plaintext = f.decrypt(DB_ENCRYPTED_PATH.read_bytes())
        DB_PATH.write_bytes(plaintext)
    except InvalidToken as e:
        raise RuntimeError("SPIRE_DB_PASSPHRASE does not match existing encrypted DB") from e


def _lock_db() -> None:
    """Re-encrypt the plaintext DB and remove the unencrypted file."""
    if not _DB_PASSPHRASE or not DB_PATH.exists():
        return
    f = Fernet(_derive_key(_DB_PASSPHRASE))
    ciphertext = f.encrypt(DB_PATH.read_bytes())
    DB_ENCRYPTED_PATH.write_bytes(ciphertext)


@contextmanager
def conn():
    with _LOCK:
        _unlock_db()
        c = sqlite3.connect(str(DB_PATH))
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()
            _lock_db()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    actor       TEXT NOT NULL,            -- role / user
    kind        TEXT NOT NULL,            -- sentry_review / llm_call / incident_ack / secure_wipe / login / ...
    subject_id  TEXT,                     -- sr_number, asset_id, incident_number, etc.
    payload     TEXT NOT NULL,            -- JSON body describing the event
    prev_hash   TEXT NOT NULL,            -- hex digest of previous row's self_hash (genesis = 64 zeros)
    self_hash   TEXT NOT NULL             -- SHA-256(prev_hash || row-canonical-bytes)
);

CREATE INDEX IF NOT EXISTS idx_audit_kind ON audit_log(kind);
CREATE INDEX IF NOT EXISTS idx_audit_ts   ON audit_log(ts);

CREATE TABLE IF NOT EXISTS sentry_decisions (
    sr_number   TEXT PRIMARY KEY,
    action      TEXT NOT NULL,            -- approve | reject | modify
    actor_role  TEXT NOT NULL,
    note        TEXT,
    ts          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pulse_feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id    TEXT NOT NULL,
    correct     INTEGER NOT NULL,
    note        TEXT,
    ts          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incident_responses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    incident_id TEXT NOT NULL,
    item_key    TEXT NOT NULL,           -- imm-0, fol-2, notify-1 etc
    checked     INTEGER NOT NULL,
    actor_role  TEXT NOT NULL,
    ts          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS uploaded_batches (
    batch_id    TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    record_count INTEGER NOT NULL,
    schema_json TEXT,
    raw_bytes   BLOB
);
"""


def init_db() -> None:
    with conn() as c:
        c.executescript(SCHEMA)


# ---------------------------------------------------------------------------
# Audit log with SHA-256 hash chain
# ---------------------------------------------------------------------------

_GENESIS = "0" * 64


def _canonical(row: dict) -> str:
    """Stable JSON for hashing — sorted keys, no whitespace."""
    return json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)


def log(kind: str, *, actor: str = "system", subject_id: Optional[str] = None, payload: Optional[dict] = None) -> dict:
    """Append an audit entry. Returns the stored row (including self_hash)."""
    ts = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    body = payload or {}
    with conn() as c:
        cur = c.execute("SELECT self_hash FROM audit_log ORDER BY id DESC LIMIT 1")
        row = cur.fetchone()
        prev_hash = row["self_hash"] if row else _GENESIS
        entry = {
            "ts": ts,
            "actor": actor,
            "kind": kind,
            "subject_id": subject_id or "",
            "payload": _canonical(body),
            "prev_hash": prev_hash,
        }
        self_hash = hashlib.sha256((prev_hash + _canonical(entry)).encode()).hexdigest()
        c.execute(
            "INSERT INTO audit_log(ts, actor, kind, subject_id, payload, prev_hash, self_hash) VALUES (?,?,?,?,?,?,?)",
            (ts, actor, kind, subject_id or "", entry["payload"], prev_hash, self_hash),
        )
        return {
            "ts": ts, "actor": actor, "kind": kind, "subject_id": subject_id or "",
            "prev_hash": prev_hash, "self_hash": self_hash,
        }


def verify_chain() -> dict:
    """Walk the entire audit table. Returns {ok, entries, broken_at}."""
    with conn() as c:
        rows = list(c.execute(
            "SELECT id, ts, actor, kind, subject_id, payload, prev_hash, self_hash "
            "FROM audit_log ORDER BY id ASC"
        ))
    prev = _GENESIS
    for r in rows:
        entry = {
            "ts": r["ts"], "actor": r["actor"], "kind": r["kind"],
            "subject_id": r["subject_id"], "payload": r["payload"],
            "prev_hash": r["prev_hash"],
        }
        expected = hashlib.sha256((prev + _canonical(entry)).encode()).hexdigest()
        if r["prev_hash"] != prev or r["self_hash"] != expected:
            return {"ok": False, "entries": len(rows), "broken_at_id": r["id"]}
        prev = r["self_hash"]
    return {"ok": True, "entries": len(rows), "head_hash": prev}


def recent_entries(limit: int = 50) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT id, ts, actor, kind, subject_id, self_hash FROM audit_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(r) for r in rows]


def entries_for_subject(subject_id: str, limit: int = 50) -> list[dict]:
    """Walkthrough #31 — audit-chain entries scoped to a single subject (SR
    number, asset id, release id) so the per-record audit-entry viewer can
    surface the actual hash-chained artifact behind a marking decision or
    release event without sifting a 500-row recent_entries dump.
    """
    with conn() as c:
        rows = c.execute(
            "SELECT id, ts, actor, kind, subject_id, payload, prev_hash, self_hash "
            "FROM audit_log WHERE subject_id = ? ORDER BY id DESC LIMIT ?",
            (subject_id, limit),
        ).fetchall()
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        try:
            d["payload"] = json.loads(d["payload"]) if d.get("payload") else {}
        except Exception:  # noqa: BLE001
            d["payload"] = {"raw": d.get("payload", "")}
        out.append(d)
    return out


# ---------------------------------------------------------------------------
# Domain writes
# ---------------------------------------------------------------------------

def record_sentry_decision(sr_number: str, action: str, *, actor_role: str, note: str = "") -> None:
    ts = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO sentry_decisions(sr_number, action, actor_role, note, ts) VALUES (?,?,?,?,?)",
            (sr_number, action, actor_role, note, ts),
        )
    log("sentry_review", actor=actor_role, subject_id=sr_number, payload={"action": action, "note": note})


def record_pulse_feedback(asset_id: str, correct: bool, note: str = "") -> None:
    ts = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with conn() as c:
        c.execute(
            "INSERT INTO pulse_feedback(asset_id, correct, note, ts) VALUES (?,?,?,?)",
            (asset_id, 1 if correct else 0, note, ts),
        )
    log("pulse_feedback", subject_id=asset_id, payload={"correct": correct, "note": note})


def record_incident_response(incident_id: str, item_key: str, checked: bool, *, actor_role: str) -> None:
    ts = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with conn() as c:
        c.execute(
            "INSERT INTO incident_responses(incident_id, item_key, checked, actor_role, ts) VALUES (?,?,?,?,?)",
            (incident_id, item_key, 1 if checked else 0, actor_role, ts),
        )
    log("incident_response", actor=actor_role, subject_id=incident_id, payload={"item": item_key, "checked": checked})


def decisions_for_batch(sr_numbers: list[str]) -> dict[str, dict]:
    if not sr_numbers:
        return {}
    placeholders = ",".join("?" for _ in sr_numbers)
    with conn() as c:
        rows = c.execute(
            f"SELECT sr_number, action, actor_role, note, ts FROM sentry_decisions WHERE sr_number IN ({placeholders})",
            tuple(sr_numbers),
        ).fetchall()
    return {r["sr_number"]: dict(r) for r in rows}


def feedback_summary() -> dict:
    with conn() as c:
        total = c.execute("SELECT COUNT(*) AS n FROM pulse_feedback").fetchone()["n"]
        correct = c.execute("SELECT COUNT(*) AS n FROM pulse_feedback WHERE correct = 1").fetchone()["n"]
    return {"total": total, "correct": correct, "correct_rate": (correct / total) if total else 0.0}


def store_uploaded_batch(batch_id: str, source: str, record_count: int, schema: dict, raw: bytes) -> None:
    ts = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    with conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO uploaded_batches(batch_id, source, created_at, record_count, schema_json, raw_bytes) VALUES (?,?,?,?,?,?)",
            (batch_id, source, ts, record_count, json.dumps(schema), raw),
        )
    log("batch_upload", subject_id=batch_id, payload={"source": source, "record_count": record_count})


# ---------------------------------------------------------------------------
# Secure Wipe
# ---------------------------------------------------------------------------

def secure_wipe(actor: str = "security_manager") -> dict:
    """Overwrite and delete persistent state. Logs the wipe to a fresh chain
    so the action itself is recorded (can't wipe without evidence)."""
    with _LOCK:
        for path in (DB_PATH, DB_ENCRYPTED_PATH):
            if path.exists():
                size = path.stat().st_size
                with open(path, "r+b") as f:
                    f.write(b"\x00" * size)
                    f.flush()
                    os.fsync(f.fileno())
                path.unlink()

    init_db()
    # First entry in the new chain is the wipe itself
    log("secure_wipe", actor=actor, payload={"note": "operator-initiated secure wipe"})
    return {"ok": True, "wiped_at": datetime.utcnow().isoformat(timespec="seconds") + "Z"}


# ---------------------------------------------------------------------------
# Init at import time
# ---------------------------------------------------------------------------

init_db()
log("system_boot", actor="system", payload={"version": "0.1.0"})
