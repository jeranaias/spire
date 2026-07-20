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

Backing store is SQLite. When SPIRE_DB_PASSPHRASE is set the whole DB file
is encrypted at rest with AES-256-GCM: the file is decrypted to DB_PATH while
a connection is open and re-encrypted (and the plaintext removed) on lock, so
no cleartext DB lingers on disk between operations. The key is PBKDF2-HMAC-SHA256 (200k
iterations) over a per-install random salt persisted beside the DB. Legacy
Fernet files (pre-GCM installs) are read transparently and migrated to GCM
on the next write.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from .timeutil import utcnow

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Database location + encryption
# ---------------------------------------------------------------------------

DATA_DIR = Path(__file__).resolve().parent.parent / "runtime"
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "spire.db"
DB_ENCRYPTED_PATH = DATA_DIR / "spire.db.enc"
DB_SALT_PATH = DATA_DIR / "spire.db.salt"

_LOCK = threading.RLock()
_DB_PASSPHRASE = os.environ.get("SPIRE_DB_PASSPHRASE")  # None == plain mode for local dev

# At-rest file format: MAGIC || nonce(12) || AES-256-GCM(ciphertext+tag).
# The key is derived from the passphrase + a per-install random salt held in
# DB_SALT_PATH (not secret, but unique per install so identical passphrases
# never collapse to the same key). Anything not starting with MAGIC is a
# legacy Fernet blob and is decrypted via the migration path below.
_GCM_MAGIC = b"SPIREg1\x00"
_KDF_ITERATIONS = 200_000

# Legacy fixed salt — only used to read pre-GCM Fernet files for one-time
# migration. Never used to write new data.
_LEGACY_KDF_SALT = b"spire-v0-at-rest-salt-7b3d4f61"


def _install_salt() -> bytes:
    """Return the per-install KDF salt, creating it on first use."""
    if DB_SALT_PATH.exists():
        salt = DB_SALT_PATH.read_bytes()
        if len(salt) == 16:
            return salt
    salt = os.urandom(16)
    DB_SALT_PATH.write_bytes(salt)
    return salt


# Re-running 200k-iteration PBKDF2 on every conn() (unlock + lock) added
# seconds per DB touch on the shared-CPU cloud box. The derived key is a
# secret held only in this process's memory (same trust boundary as the
# passphrase env var), so memoizing by (passphrase, salt) is safe.
_DERIVED_KEY_CACHE: dict[tuple[str, bytes], bytes] = {}


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    """Derive a raw 32-byte AES-256 key from passphrase + salt."""
    cached = _DERIVED_KEY_CACHE.get((passphrase, salt))
    if cached is not None:
        return cached
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=_KDF_ITERATIONS)
    key = kdf.derive(passphrase.encode("utf-8"))
    _DERIVED_KEY_CACHE[(passphrase, salt)] = key
    return key


def _decrypt_blob(blob: bytes, passphrase: str) -> bytes:
    """Decrypt an at-rest blob. Handles both the AES-256-GCM format (salt in
    the header, so the blob is self-contained and portable across installs)
    and legacy Fernet files, which are migrated to GCM on the next write."""
    if blob[: len(_GCM_MAGIC)] == _GCM_MAGIC:
        body = blob[len(_GCM_MAGIC):]
        salt, nonce, ciphertext = body[:16], body[16:28], body[28:]
        key = _derive_key(passphrase, salt)
        return AESGCM(key).decrypt(nonce, ciphertext, None)
    # Legacy Fernet path — read-only, for one-time migration.
    import base64
    from cryptography.fernet import Fernet, InvalidToken
    legacy_key = base64.urlsafe_b64encode(_derive_key(passphrase, _LEGACY_KDF_SALT))
    try:
        return Fernet(legacy_key).decrypt(blob)
    except InvalidToken as e:
        raise RuntimeError("passphrase does not match existing encrypted data") from e


def _encrypt_blob(plaintext: bytes, passphrase: str) -> bytes:
    """Encrypt with AES-256-GCM under a fresh random nonce. The per-install
    salt is embedded in the header so the blob decrypts on any install."""
    salt = _install_salt()
    key = _derive_key(passphrase, salt)
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, None)
    return _GCM_MAGIC + salt + nonce + ciphertext


def _unlock_db() -> None:
    """If an encrypted DB exists and a passphrase is set, decrypt it to
    DB_PATH. The working copy is re-encrypted to DB_ENCRYPTED_PATH on lock."""
    if not _DB_PASSPHRASE or not DB_ENCRYPTED_PATH.exists():
        return
    try:
        plaintext = _decrypt_blob(DB_ENCRYPTED_PATH.read_bytes(), _DB_PASSPHRASE)
    except (InvalidTag, ValueError) as e:
        raise RuntimeError("SPIRE_DB_PASSPHRASE does not match existing encrypted DB") from e
    DB_PATH.write_bytes(plaintext)


def _lock_db() -> None:
    """Re-encrypt the plaintext working copy to DB_ENCRYPTED_PATH (AES-256-GCM)
    and remove the plaintext so no cleartext DB lingers on disk at rest. Only
    runs in encrypted mode; plain-mode (no passphrase) keeps spire.db as the
    durable store."""
    if not _DB_PASSPHRASE or not DB_PATH.exists():
        return
    DB_ENCRYPTED_PATH.write_bytes(_encrypt_blob(DB_PATH.read_bytes(), _DB_PASSPHRASE))
    # Delete the plaintext copy + any transient SQLite sidecars. dr.py already
    # decrypts the .enc when the plaintext is absent, so backups still work.
    for suffix in ("", "-journal", "-wal", "-shm"):
        try:
            (DB_PATH.parent / (DB_PATH.name + suffix)).unlink()
        except OSError:
            pass


# conn() nesting depth. Re-entrant per thread via _LOCK (RLock); decrypt on the
# outermost enter and re-encrypt+wipe on the outermost exit only, so a nested
# conn() never re-encrypts or unlinks a DB an outer connection still holds.
_CONN_DEPTH = 0


@contextmanager
def conn():
    global _CONN_DEPTH
    with _LOCK:
        if _CONN_DEPTH == 0:
            _unlock_db()
        _CONN_DEPTH += 1
        c = sqlite3.connect(str(DB_PATH))
        c.row_factory = sqlite3.Row
        try:
            yield c
            c.commit()
        finally:
            c.close()
            _CONN_DEPTH -= 1
            if _CONN_DEPTH == 0:
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
    self_hash   TEXT NOT NULL,            -- SHA-256(prev_hash || row-canonical-bytes)
    signature   TEXT                      -- P6.3 — Ed25519(self_hash) hex; NULL when signing disabled or low-value entry
);

CREATE INDEX IF NOT EXISTS idx_audit_kind  ON audit_log(kind);
CREATE INDEX IF NOT EXISTS idx_audit_ts    ON audit_log(ts);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);

CREATE TABLE IF NOT EXISTS sentry_decisions (
    sr_number          TEXT PRIMARY KEY,
    action             TEXT NOT NULL,            -- approve | reject | modify
    actor_role         TEXT NOT NULL,
    actor_dodid        TEXT NOT NULL DEFAULT '',
    actor_name         TEXT NOT NULL DEFAULT '',
    actor_unit         TEXT NOT NULL DEFAULT '',
    actor_cert_serial  TEXT NOT NULL DEFAULT '',
    note               TEXT,
    ts                 TEXT NOT NULL
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

-- Task #67: persist the in-memory `_BATCHES` dict so a uvicorn restart
-- mid-demo doesn't strand the operator on a 404 between Upload and
-- Processing. Stores the full batch payload (records + jobs + results)
-- as a JSON blob keyed by batch_id. Hydrated on demand by the SENTRY
-- routes; small enough (<1MB per 500-record batch) that JSON-in-SQLite
-- beats threading another schema migration through.
CREATE TABLE IF NOT EXISTS sentry_batches (
    batch_id    TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    payload     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sentry_batches_updated ON sentry_batches(updated_at);

CREATE TABLE IF NOT EXISTS user_prefs (
    dodid       TEXT NOT NULL,
    pref_key    TEXT NOT NULL,
    pref_value  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (dodid, pref_key)
);

-- Risk Board "Draft Action" submissions. Persisting these turned the
-- Draft button from a toast-only no-op into a real artifact a judge
-- can drill into ("where did that go?" → here, plus an audit_log row).
-- status is held|dismissed; the demo doesn't ship a full approval
-- workflow, so the badge surfaces every held draft until an operator
-- dismisses it.
CREATE TABLE IF NOT EXISTS pulse_drafts (
    draft_id    TEXT PRIMARY KEY,
    asset_id    TEXT NOT NULL,
    unit_name   TEXT,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT,
    cost_usd    REAL,
    mc_delta_pct REAL,
    time_to_effect_hours REAL,
    artifact_json TEXT,
    actor       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'held',
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pulse_drafts_status ON pulse_drafts(status);
CREATE INDEX IF NOT EXISTS idx_pulse_drafts_created ON pulse_drafts(created_at);

-- UIS MappingProfile (UIS-12). One row per (source_id × unit ×
-- source_version) profile the operator has confirmed. Looked up at
-- ingest time so the second drop of the same shape skips the
-- mapping-review UI entirely.
CREATE TABLE IF NOT EXISTS uis_mapping_profiles (
    profile_id      TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL,
    unit            TEXT,
    source_version  TEXT,
    column_map_json TEXT NOT NULL,
    cell_transforms_json TEXT NOT NULL DEFAULT '{}',
    operator_notes  TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    confirmed_at    TEXT,
    confidence      REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_uis_profiles_source ON uis_mapping_profiles(source_id);
CREATE INDEX IF NOT EXISTS idx_uis_profiles_unit ON uis_mapping_profiles(unit);
"""


def init_db() -> None:
    with conn() as c:
        c.executescript(SCHEMA)
        # In-place migration: add operator-identity columns to existing
        # sentry_decisions tables that predate task #25. SQLite's ALTER
        # TABLE ADD COLUMN is cheap and idempotent-by-try; we swallow
        # the duplicate-column error on subsequent boots.
        for col in (
            "actor_dodid",
            "actor_name",
            "actor_unit",
            "actor_cert_serial",
        ):
            try:
                c.execute(
                    f"ALTER TABLE sentry_decisions ADD COLUMN {col} TEXT NOT NULL DEFAULT ''"
                )
            except sqlite3.OperationalError:
                pass
        # P6.3 — `signature` column on audit_log for Ed25519 sign of
        # high-value entries. Same idempotent ALTER pattern.
        try:
            c.execute("ALTER TABLE audit_log ADD COLUMN signature TEXT")
        except sqlite3.OperationalError:
            pass


# ---------------------------------------------------------------------------
# Audit log with SHA-256 hash chain
# ---------------------------------------------------------------------------

_GENESIS = "0" * 64


def _canonical(row: dict) -> str:
    """Stable JSON for hashing — sorted keys, no whitespace."""
    return json.dumps(row, sort_keys=True, separators=(",", ":"), default=str)


class AuditWriteFailure(RuntimeError):
    """An audit entry could not be written. Raised only under the event
    profile, where auditability is a hard requirement rather than a
    best-effort one."""


# Counter for audit writes that were attempted and failed. Several call sites
# guard the write so an audit outage cannot mask the 403 or 503 they are in the
# middle of returning. That is the right call - but a silent counter of zero is
# indistinguishable from a broken audit layer, so the count is surfaced in
# /api/system/status.
_AUDIT_FAILURES: dict = {"count": 0, "last_kind": None, "last_error": None, "last_at": None}


def audit_failures() -> dict:
    """Snapshot of audit-write failures since process start."""
    return dict(_AUDIT_FAILURES)


def reset_audit_failures() -> None:
    """Test hook - clears the counter."""
    _AUDIT_FAILURES.update(count=0, last_kind=None, last_error=None, last_at=None)


def log_or_flag(kind: str, **kwargs) -> Optional[dict]:
    """:func:`log`, but a failure is recorded rather than swallowed.

    Use at call sites that must not let an audit outage mask the response they
    are already returning (a 403, a blocked downgrade). The failure still gets
    logged loudly and counted, and under SPIRE_PROFILE=event it raises: an
    action nobody can prove happened is not an action the enforcing build is
    willing to take.
    """
    try:
        return log(kind, **kwargs)
    except Exception as exc:  # noqa: BLE001 - the point is to catch everything
        _AUDIT_FAILURES["count"] += 1
        _AUDIT_FAILURES["last_kind"] = kind
        _AUDIT_FAILURES["last_error"] = f"{type(exc).__name__}: {exc}"
        _AUDIT_FAILURES["last_at"] = utcnow().isoformat(timespec="seconds") + "Z"
        _log.error("audit write failed for kind=%s: %s", kind, exc, exc_info=True)
        from .security_posture import event_profile
        if event_profile():
            raise AuditWriteFailure(f"audit write failed for {kind}: {exc}") from exc
        return None


def log(kind: str, *, actor: str = "system", subject_id: Optional[str] = None, payload: Optional[dict] = None) -> dict:
    """Append an audit entry. Returns the stored row (including self_hash).

    P6.3 — high-value entries (matching SIGN_PREFIXES from
    backend.uis.audit_integrity) are signed with the operator's
    Ed25519 private key when one is configured. Signature is
    stored alongside in the ``signature`` column and survives an
    SQLite-file rewrite (signature can be verified offline against
    the public key).
    """
    ts = utcnow().isoformat(timespec="seconds") + "Z"
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
        # P6.3 — sign high-value entries (Ed25519). Best-effort:
        # signing failures don't crash the audit_log call — chain
        # still records the entry; missing signature is recoverable.
        signature: Optional[str] = None
        try:
            from .uis.audit_integrity import should_sign, sign_entry_hash
            if should_sign(kind):
                signature = sign_entry_hash(self_hash)
        except Exception:  # noqa: BLE001
            signature = None
        cur = c.execute(
            "INSERT INTO audit_log(ts, actor, kind, subject_id, payload, prev_hash, self_hash, signature) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (ts, actor, kind, subject_id or "", entry["payload"], prev_hash, self_hash, signature),
        )
        # `id` is the chain index — the position of this entry in the
        # append-only audit table. Surfaces in returned dicts so callers can
        # show "chain entry #N" to operators without a follow-up query.
        return {
            "id": cur.lastrowid, "ts": ts, "actor": actor, "kind": kind,
            "subject_id": subject_id or "",
            "prev_hash": prev_hash, "self_hash": self_hash,
            "signature": signature,
        }


def verify_chain(*, verify_signatures: bool = True) -> dict:
    """Walk the entire audit table and check tamper-evidence.

    Two layers:
      1. **Hash chain** — each row's ``self_hash`` must equal
         ``SHA-256(prev_hash || canonical(entry))`` and link to the prior row.
      2. **Ed25519 signatures** — when signing is enabled, every row that
         carries a signature must verify against the audit public key. This
         is what makes the chain tamper-evident even against an attacker with
         full DB write access: they can recompute the hash chain (all inputs
         are in the row), but they cannot re-sign ``self_hash`` without the
         private key, so any altered signed entry fails here.

    Returns ``{ok, entries, head_hash}`` on success (plus ``signed_entries`` /
    ``unsigned_signable`` when signature checking ran), or
    ``{ok: False, entries, broken_at_id, reason}`` on the first violation.
    """
    with conn() as c:
        rows = list(c.execute(
            "SELECT id, ts, actor, kind, subject_id, payload, prev_hash, self_hash, signature "
            "FROM audit_log ORDER BY id ASC"
        ))

    verify_sig = None
    should_sign = None
    if verify_signatures:
        try:
            from .uis.audit_integrity import (
                should_sign as _should_sign,
                signing_enabled,
                verify_entry_signature,
            )
            if signing_enabled():
                verify_sig, should_sign = verify_entry_signature, _should_sign
        except Exception:  # noqa: BLE001 — signature layer is best-effort
            verify_sig = None

    prev = _GENESIS
    signed_entries = 0
    unsigned_signable = 0
    for r in rows:
        entry = {
            "ts": r["ts"], "actor": r["actor"], "kind": r["kind"],
            "subject_id": r["subject_id"], "payload": r["payload"],
            "prev_hash": r["prev_hash"],
        }
        expected = hashlib.sha256((prev + _canonical(entry)).encode()).hexdigest()
        if r["prev_hash"] != prev or r["self_hash"] != expected:
            return {"ok": False, "entries": len(rows), "broken_at_id": r["id"], "reason": "hash_mismatch"}
        if verify_sig is not None:
            sig = r["signature"]
            if sig:
                if not verify_sig(r["self_hash"], sig):
                    return {"ok": False, "entries": len(rows), "broken_at_id": r["id"], "reason": "bad_signature"}
                signed_entries += 1
            elif should_sign(r["kind"]):
                # Signable entry with no signature — reported (not failed) so a
                # chain that predates signing doesn't false-positive.
                unsigned_signable += 1
        prev = r["self_hash"]

    result = {"ok": True, "entries": len(rows), "head_hash": prev}
    if verify_sig is not None:
        result["signed_entries"] = signed_entries
        result["unsigned_signable"] = unsigned_signable
    return result


def recent_entries(limit: int = 50, *, include_payload: bool = False) -> list[dict]:
    """Return the N most recent audit entries.

    When ``include_payload=True``, each row also carries the original
    ``payload`` dict (parsed from the canonical JSON stored at write time)
    so a downstream verifier can reconstruct what each row meant — not just
    that the chain hash lines up. Defaults to ``False`` to preserve the
    light-weight summary used by status panels and tests.
    """
    cols = "id, ts, actor, kind, subject_id, self_hash"
    if include_payload:
        cols += ", payload"
    with conn() as c:
        rows = c.execute(
            f"SELECT {cols} FROM audit_log ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        if include_payload:
            raw = d.get("payload")
            if isinstance(raw, str) and raw:
                try:
                    d["payload"] = json.loads(raw)
                except (ValueError, TypeError):
                    # Keep the raw string if it isn't valid JSON — the chain
                    # is still verifiable; we just couldn't parse the body.
                    d["payload"] = {"_raw": raw}
            else:
                d["payload"] = {}
        out.append(d)
    return out


def query_audit(
    *,
    actors: Optional[list[str]] = None,
    kinds: Optional[list[str]] = None,
    resource_prefixes: Optional[list[str]] = None,
    classification: Optional[str] = None,
    after_ts: Optional[str] = None,
    before_ts: Optional[str] = None,
    q: Optional[str] = None,
    only_anomalies: bool = False,
    limit: int = 100,
    offset: int = 0,
) -> dict:
    """Filter the audit chain for the SOC view.

    Indexed columns (actor, kind, ts) are filtered in SQL. Payload-derived
    filters (classification substring, free-text q) are applied in Python on
    the SQL-narrowed candidate set; the chain itself is small enough for a
    hackathon-grade demo (<10k rows) that this is fine.

    Returns:
      {
        rows:            [...]   # parsed payload + chain_ok per row
        total:           N       # total rows matching the filter set
        head_hash:       str     # current chain head
        broken_at_id:    int|None
        anomaly_count:   N       # broken_chain + spillage + downgrade across the matched set
        kinds_in_view:   [...]   # distinct kinds present (for chip refresh)
        actors_in_view:  [...]
      }
    """
    sql_clauses: list[str] = []
    sql_params: list[Any] = []
    if actors:
        placeholders = ",".join("?" for _ in actors)
        sql_clauses.append(f"actor IN ({placeholders})")
        sql_params.extend(actors)
    if kinds:
        placeholders = ",".join("?" for _ in kinds)
        sql_clauses.append(f"kind IN ({placeholders})")
        sql_params.extend(kinds)
    if resource_prefixes:
        # Each prefix becomes a kind LIKE 'prefix_%' clause, OR'd together.
        ors = " OR ".join("kind LIKE ?" for _ in resource_prefixes)
        sql_clauses.append(f"({ors})")
        for p in resource_prefixes:
            sql_params.append(f"{p}%")
    if after_ts:
        sql_clauses.append("ts >= ?")
        sql_params.append(after_ts)
    if before_ts:
        sql_clauses.append("ts <= ?")
        sql_params.append(before_ts)
    if q:
        # Free-text scan across actor / kind / subject / payload.
        sql_clauses.append("(actor LIKE ? OR kind LIKE ? OR subject_id LIKE ? OR payload LIKE ?)")
        like = f"%{q}%"
        sql_params.extend([like, like, like, like])

    where = ("WHERE " + " AND ".join(sql_clauses)) if sql_clauses else ""
    select = (
        "SELECT id, ts, actor, kind, subject_id, payload, prev_hash, self_hash "
        f"FROM audit_log {where} ORDER BY id DESC"
    )

    # We also need a single chain walk so we know broken_at_id (per-row chain_ok).
    # The walk is on the FULL table, not the filtered set, so a tampered row
    # earlier in history is still flagged here.
    with conn() as c:
        rows = list(c.execute(select, tuple(sql_params)))
        chain_rows = list(c.execute(
            "SELECT id, ts, actor, kind, subject_id, payload, prev_hash, self_hash "
            "FROM audit_log ORDER BY id ASC"
        ))

    broken_at_id: Optional[int] = None
    head_hash = _GENESIS
    prev = _GENESIS
    for r in chain_rows:
        entry = {
            "ts": r["ts"], "actor": r["actor"], "kind": r["kind"],
            "subject_id": r["subject_id"], "payload": r["payload"],
            "prev_hash": r["prev_hash"],
        }
        expected = hashlib.sha256((prev + _canonical(entry)).encode()).hexdigest()
        if r["prev_hash"] != prev or r["self_hash"] != expected:
            if broken_at_id is None:
                broken_at_id = r["id"]
            # Don't break — still walk to compute the head and mark every
            # downstream row as suspect (a tamper invalidates everything
            # after it).
        prev = r["self_hash"]
    head_hash = prev

    enriched: list[dict] = []
    actors_in_view: set[str] = set()
    kinds_in_view: set[str] = set()
    anomaly_count = 0

    SPILLAGE_KINDS = {"spillage_prevented", "downgrade_blocked"}

    for r in rows:
        try:
            payload_obj = json.loads(r["payload"]) if r["payload"] else {}
        except Exception:
            payload_obj = {"raw": r["payload"]}
        if not isinstance(payload_obj, dict):
            payload_obj = {"value": payload_obj}

        actors_in_view.add(r["actor"])
        kinds_in_view.add(r["kind"])

        # Post-fetch classification filter (payload-side).
        cls_in_payload = (
            payload_obj.get("classification")
            or payload_obj.get("required_classification")
            or payload_obj.get("_classification")
            or ""
        )
        if classification and (str(cls_in_payload).upper() != classification.upper()):
            continue

        chain_ok = (broken_at_id is None) or (r["id"] < broken_at_id)
        anomaly_tag: Optional[str] = None
        if not chain_ok:
            anomaly_tag = "broken_chain"
        elif r["kind"] == "spillage_prevented":
            anomaly_tag = "spillage_prevented"
        elif r["kind"] == "downgrade_blocked":
            anomaly_tag = "downgrade_blocked"
        elif r["kind"].endswith("_blocked") or r["kind"].endswith("_error"):
            anomaly_tag = "blocked_or_error"

        if only_anomalies and anomaly_tag is None:
            continue
        if anomaly_tag is not None:
            anomaly_count += 1

        enriched.append({
            "id": r["id"],
            "ts": r["ts"],
            "actor": r["actor"],
            "kind": r["kind"],
            "subject_id": r["subject_id"] or "",
            "payload": payload_obj,
            "prev_hash": r["prev_hash"],
            "self_hash": r["self_hash"],
            "chain_ok": chain_ok,
            "anomaly_tag": anomaly_tag,
            "classification": str(cls_in_payload) if cls_in_payload else "",
            "model_invoked": payload_obj.get("model") or payload_obj.get("model_id") or "",
            "source_ip": payload_obj.get("source_ip", ""),
            "outcome": _derive_outcome(r["kind"], payload_obj),
        })

    total = len(enriched)
    page = enriched[offset : offset + limit]
    return {
        "rows": page,
        "total": total,
        "head_hash": head_hash,
        "broken_at_id": broken_at_id,
        "anomaly_count": anomaly_count,
        "kinds_in_view": sorted(kinds_in_view),
        "actors_in_view": sorted(actors_in_view),
        "limit": limit,
        "offset": offset,
    }


def _derive_outcome(kind: str, payload: dict) -> str:
    """Return success | blocked | error from kind + payload."""
    explicit = payload.get("decision") or payload.get("outcome") or payload.get("result")
    if isinstance(explicit, str):
        s = explicit.lower()
        if s in ("blocked", "denied", "deny"):
            return "blocked"
        if s in ("error", "failed", "failure"):
            return "error"
        if s in ("ok", "success", "applied", "approved"):
            return "success"
    if "spillage" in kind or kind.endswith("_blocked"):
        return "blocked"
    if kind.endswith("_error") or "error" in payload:
        return "error"
    return "success"


def distinct_audit_facets(limit_actors: int = 50, limit_kinds: int = 80) -> dict:
    """Distinct kind / actor lists for filter chips. Cheap — scans the
    audit table once with a GROUP BY (indexed)."""
    with conn() as c:
        actor_rows = c.execute(
            "SELECT actor, COUNT(*) AS n FROM audit_log GROUP BY actor "
            "ORDER BY n DESC LIMIT ?",
            (limit_actors,),
        ).fetchall()
        kind_rows = c.execute(
            "SELECT kind, COUNT(*) AS n FROM audit_log GROUP BY kind "
            "ORDER BY n DESC LIMIT ?",
            (limit_kinds,),
        ).fetchall()
    return {
        "actors": [{"actor": r["actor"], "count": r["n"]} for r in actor_rows],
        "kinds":  [{"kind":  r["kind"],  "count": r["n"]} for r in kind_rows],
    }


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

def record_sentry_decision(
    sr_number: str,
    action: str,
    *,
    actor_role: str,
    actor_dodid: str = "",
    actor_name: str = "",
    actor_unit: str = "",
    actor_cert_serial: str = "",
    note: str = "",
) -> None:
    """Persist a SENTRY review decision and emit the matching audit-chain row.

    The actor_* fields anchor the decision to a specific Marine (DODID +
    name + unit + CAC cert serial) so the hash-chained audit trail can
    answer "who" — not just "which role" — for any held SR. This is the
    backbone the inspector's audit-chain modal surfaces in the UI.
    """
    ts = utcnow().isoformat(timespec="seconds") + "Z"
    with conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO sentry_decisions("
            "sr_number, action, actor_role, actor_dodid, actor_name, "
            "actor_unit, actor_cert_serial, note, ts) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                sr_number,
                action,
                actor_role,
                actor_dodid,
                actor_name,
                actor_unit,
                actor_cert_serial,
                note,
                ts,
            ),
        )
    log(
        "sentry_review",
        actor=actor_role,
        subject_id=sr_number,
        payload={
            "action": action,
            "note": note,
            "actor_role": actor_role,
            "actor_dodid": actor_dodid,
            "actor_name": actor_name,
            "actor_unit": actor_unit,
            "actor_cert_serial": actor_cert_serial,
        },
    )


def record_sentry_bulk_decision(
    sr_numbers: list[str],
    action: str,
    *,
    actor_role: str,
    column: str = "",
    note: str = "",
) -> dict:
    """Persist N review decisions and write **one** chained audit entry.

    The previous flow looped `record_sentry_decision` per SR which produced
    N independent audit rows for a single operator click — making "Approve
    all 357" indistinguishable from 357 deliberate one-by-one approvals
    in the chain. This helper writes one `sentry_bulk_review` entry that
    names every SR it touched, so a judge or IG can audit the bulk action
    as a single intent.
    """
    ts = utcnow().isoformat(timespec="seconds") + "Z"
    if not sr_numbers:
        return {"count": 0}
    with conn() as c:
        c.executemany(
            "INSERT OR REPLACE INTO sentry_decisions(sr_number, action, actor_role, note, ts) VALUES (?,?,?,?,?)",
            [(sr, action, actor_role, note, ts) for sr in sr_numbers],
        )
    entry = log(
        "sentry_bulk_review",
        actor=actor_role,
        subject_id=f"bulk:{action}:{len(sr_numbers)}",
        payload={
            "action": action,
            "column": column,
            "count": len(sr_numbers),
            "sr_numbers": list(sr_numbers),
            "note": note,
        },
    )
    return {"count": len(sr_numbers), "entry": entry}


def record_pulse_feedback(asset_id: str, correct: bool, note: str = "") -> None:
    ts = utcnow().isoformat(timespec="seconds") + "Z"
    with conn() as c:
        c.execute(
            "INSERT INTO pulse_feedback(asset_id, correct, note, ts) VALUES (?,?,?,?)",
            (asset_id, 1 if correct else 0, note, ts),
        )
    log("pulse_feedback", subject_id=asset_id, payload={"correct": correct, "note": note})


def record_incident_response(incident_id: str, item_key: str, checked: bool, *, actor_role: str) -> None:
    ts = utcnow().isoformat(timespec="seconds") + "Z"
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
            "SELECT sr_number, action, actor_role, actor_dodid, actor_name, "
            "actor_unit, actor_cert_serial, note, ts "
            f"FROM sentry_decisions WHERE sr_number IN ({placeholders})",
            tuple(sr_numbers),
        ).fetchall()
    return {r["sr_number"]: dict(r) for r in rows}


def feedback_summary() -> dict:
    with conn() as c:
        total = c.execute("SELECT COUNT(*) AS n FROM pulse_feedback").fetchone()["n"]
        correct = c.execute("SELECT COUNT(*) AS n FROM pulse_feedback WHERE correct = 1").fetchone()["n"]
    return {"total": total, "correct": correct, "correct_rate": (correct / total) if total else 0.0}


def store_sentry_batch(batch_id: str, batch: dict) -> None:
    """Task #67 — persist (or upsert) a SENTRY batch's full state.

    The blob includes the records list, schema, jobs map, and any per-job
    results. Re-stored on every state-mutating endpoint (start_processing
    completion, etc.) so a uvicorn restart recovers the same batch the
    operator was in the middle of.
    """
    ts = utcnow().isoformat(timespec="seconds") + "Z"
    try:
        payload = json.dumps(batch, default=str)
    except Exception:
        # Defence in depth — if anything in the batch is non-serializable
        # we should still surface a useful failure rather than crash the
        # processing endpoint. Caller logs the noise.
        raise
    with conn() as c:
        c.execute(
            "INSERT INTO sentry_batches(batch_id, created_at, updated_at, payload) "
            "VALUES (?,?,?,?) "
            "ON CONFLICT(batch_id) DO UPDATE SET "
            "updated_at = excluded.updated_at, payload = excluded.payload",
            (batch_id, ts, ts, payload),
        )


def load_sentry_batch(batch_id: str) -> Optional[dict]:
    """Task #67 — hydrate a previously-persisted batch by id, or None."""
    with conn() as c:
        row = c.execute(
            "SELECT payload FROM sentry_batches WHERE batch_id = ?",
            (batch_id,),
        ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row["payload"])
    except Exception:
        return None


def find_sentry_batch_id_for_job(job_id: str) -> Optional[str]:
    """Task #67 — locate the batch that owns a given job_id by scanning the
    50 most-recently-updated persisted batches. Used after a uvicorn
    restart when /sentry/jobs/{job_id} comes in cold and the in-memory
    `_BATCHES` dict has been wiped.
    """
    with conn() as c:
        rows = c.execute(
            "SELECT batch_id, payload FROM sentry_batches "
            "ORDER BY updated_at DESC LIMIT 50"
        ).fetchall()
    for r in rows:
        try:
            payload = json.loads(r["payload"])
        except Exception:
            continue
        if isinstance(payload, dict) and job_id in (payload.get("jobs") or {}):
            return r["batch_id"]
    return None


def record_pulse_draft(
    *,
    asset_id: str,
    kind: str,
    title: str,
    actor: str,
    unit_name: Optional[str] = None,
    description: Optional[str] = None,
    cost_usd: Optional[float] = None,
    mc_delta_pct: Optional[float] = None,
    time_to_effect_hours: Optional[float] = None,
    artifact: Optional[dict] = None,
) -> dict:
    """Persist a Risk Board "Draft Action" so it survives a refresh and
    shows up in the TopBar drafts badge. Also writes an audit_log row so
    the chain has the artifact (subject_id is the draft_id, payload
    captures the action specifics)."""
    ts = utcnow().isoformat(timespec="seconds") + "Z"
    # draft_id pattern matches PROP-/expedite-style ids elsewhere in PULSE.
    rand_hex = hashlib.sha256(f"{asset_id}{kind}{ts}{actor}".encode()).hexdigest()[:6].upper()
    draft_id = f"DRAFT-{utcnow().strftime('%Y%m%d-%H%M%S')}-{rand_hex}"
    artifact_json = json.dumps(artifact or {}, sort_keys=True, default=str)
    with conn() as c:
        c.execute(
            "INSERT INTO pulse_drafts(draft_id, asset_id, unit_name, kind, title, "
            "description, cost_usd, mc_delta_pct, time_to_effect_hours, artifact_json, "
            "actor, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                draft_id, asset_id, unit_name or "", kind, title,
                description or "", cost_usd, mc_delta_pct, time_to_effect_hours,
                artifact_json, actor, "held", ts,
            ),
        )
    log(
        "pulse_draft_action",
        actor=actor,
        subject_id=draft_id,
        payload={
            "asset_id": asset_id,
            "unit_name": unit_name or "",
            "kind": kind,
            "title": title,
            "description": description or "",
            "cost_usd": cost_usd,
            "mc_delta_pct": mc_delta_pct,
            "time_to_effect_hours": time_to_effect_hours,
            "artifact": artifact or {},
            "status": "held",
        },
    )
    return {
        "draft_id": draft_id,
        "asset_id": asset_id,
        "unit_name": unit_name or "",
        "kind": kind,
        "title": title,
        "description": description or "",
        "cost_usd": cost_usd,
        "mc_delta_pct": mc_delta_pct,
        "time_to_effect_hours": time_to_effect_hours,
        "artifact": artifact or {},
        "actor": actor,
        "status": "held",
        "created_at": ts,
    }


def list_pulse_drafts(*, status: str = "held", limit: int = 50) -> list[dict]:
    """Return drafts ordered newest-first. Default scope is held drafts so
    the TopBar badge only counts the active queue."""
    with conn() as c:
        rows = c.execute(
            "SELECT draft_id, asset_id, unit_name, kind, title, description, "
            "cost_usd, mc_delta_pct, time_to_effect_hours, artifact_json, "
            "actor, status, created_at FROM pulse_drafts "
            "WHERE status = ? ORDER BY created_at DESC LIMIT ?",
            (status, limit),
        ).fetchall()
    out: list[dict] = []
    for r in rows:
        d = dict(r)
        try:
            d["artifact"] = json.loads(d.pop("artifact_json") or "{}")
        except Exception:  # noqa: BLE001
            d["artifact"] = {}
        out.append(d)
    return out


def dismiss_pulse_draft(draft_id: str, *, actor: str) -> Optional[dict]:
    """Mark a draft as dismissed and audit-log the dismissal. Returns the
    updated row or None if the draft wasn't found / already dismissed."""
    ts = utcnow().isoformat(timespec="seconds") + "Z"
    with conn() as c:
        row = c.execute(
            "SELECT draft_id, asset_id, kind, status FROM pulse_drafts WHERE draft_id = ?",
            (draft_id,),
        ).fetchone()
        if row is None:
            return None
        if row["status"] != "held":
            return dict(row)
        c.execute(
            "UPDATE pulse_drafts SET status = 'dismissed' WHERE draft_id = ?",
            (draft_id,),
        )
    log(
        "pulse_draft_dismiss",
        actor=actor,
        subject_id=draft_id,
        payload={"asset_id": row["asset_id"], "kind": row["kind"], "ts": ts},
    )
    return {**dict(row), "status": "dismissed"}


def store_uploaded_batch(batch_id: str, source: str, record_count: int, schema: dict, raw: bytes) -> None:
    ts = utcnow().isoformat(timespec="seconds") + "Z"
    with conn() as c:
        c.execute(
            "INSERT OR REPLACE INTO uploaded_batches(batch_id, source, created_at, record_count, schema_json, raw_bytes) VALUES (?,?,?,?,?,?)",
            (batch_id, source, ts, record_count, json.dumps(schema), raw),
        )
    log("batch_upload", subject_id=batch_id, payload={"source": source, "record_count": record_count})


# ---------------------------------------------------------------------------
# Per-identity preferences (lightweight key/value, scoped by DODID)
# ---------------------------------------------------------------------------

def get_user_pref(dodid: str, key: str, default: Optional[str] = None) -> Optional[str]:
    """Return the stored value for (dodid, key) or `default` if unset."""
    with conn() as c:
        row = c.execute(
            "SELECT pref_value FROM user_prefs WHERE dodid = ? AND pref_key = ?",
            (dodid, key),
        ).fetchone()
    return row["pref_value"] if row else default


def set_user_pref(dodid: str, key: str, value: str) -> None:
    """Upsert a per-identity preference. Values are TEXT — JSON-encode at the
    call site if storing structured data."""
    ts = utcnow().isoformat(timespec="seconds") + "Z"
    with conn() as c:
        c.execute(
            "INSERT INTO user_prefs(dodid, pref_key, pref_value, updated_at) "
            "VALUES (?,?,?,?) "
            "ON CONFLICT(dodid, pref_key) DO UPDATE SET "
            "pref_value = excluded.pref_value, updated_at = excluded.updated_at",
            (dodid, key, value, ts),
        )


# ---------------------------------------------------------------------------
# Secure Wipe
# ---------------------------------------------------------------------------

def secure_wipe(actor: str = "security_manager") -> dict:
    """Overwrite and delete persistent state. Logs the wipe to a fresh chain
    so the action itself is recorded (can't wipe without evidence)."""
    with _LOCK:
        for path in (DB_PATH, DB_ENCRYPTED_PATH, DB_SALT_PATH):
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
    return {"ok": True, "wiped_at": utcnow().isoformat(timespec="seconds") + "Z"}


# ---------------------------------------------------------------------------
# Init at import time
# ---------------------------------------------------------------------------

init_db()

# Walkthrough audit: every backend boot logged a system_boot entry, and
# Fly.io rolls machines on every deploy + autosuspend, so the operator
# audit chain was dominated by boot noise (46/50 entries were boots).
# Only log a boot if the previous entry isn't ALSO a recent boot — once
# per cold start, not once per warm restart.
def _maybe_log_boot() -> None:
    try:
        with conn() as c:
            row = c.execute(
                "SELECT kind, ts FROM audit_log ORDER BY id DESC LIMIT 1"
            ).fetchone()
        if row and row["kind"] == "system_boot":
            try:
                last = datetime.fromisoformat(row["ts"].replace("Z", "+00:00"))
                age = (datetime.now(last.tzinfo) - last).total_seconds()
                if age < 600:  # 10 min — same machine flapping
                    return
            except Exception:
                pass
        log("system_boot", actor="system", payload={"version": "0.1.0"})
    except Exception:
        # Best-effort; if the boot log fails we still serve.
        pass

_maybe_log_boot()
