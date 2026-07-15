"""Disaster-recovery / backup primitives (UIS-P6.6).

Last hardening item in the UIS-P6 series. Gives operators an
auditable way to:

  1. **Snapshot** the SPIRE state — main SQLite (audit chain,
     SENTRY decisions, PULSE drafts, mapping profiles, channel
     configs, schema-migration tracker) plus the optional audit
     pin file — into a single content-addressed archive.
  2. **Verify** an archive end-to-end without restoring it: the
     manifest's recorded hashes must match the embedded files,
     and the embedded audit chain must still verify.
  3. **Restore** an archive to ``runtime/`` atomically. A
     pre-restore snapshot of the current state is captured first
     so a failed restore can be rolled back.

What's IN the archive
---------------------
* ``manifest.json`` — canonical-JSON manifest with format
  version, source SPIRE git rev (best-effort), schema-migration
  inventory, audit-chain head hash + entry count, embedded-file
  SHA-256s, and a ``manifest_self_hash`` (SHA-256 over the
  manifest with the self-hash field zeroed).
* ``spire.db`` (or ``spire.db.enc`` when ``SPIRE_DB_PASSPHRASE``
  is set at backup time) — produced via SQLite's Online Backup
  API for a hot, transactionally-consistent snapshot.
* ``audit_pin.jsonl`` — present only if ``SPIRE_AUDIT_PIN_PATH``
  is set and the file exists.

What is NOT in the archive
--------------------------
* **Signing keys.** Operator-managed via env / KMS. Restoring
  to a different host with no signing key configured will leave
  the audit chain hash-verified but unsigned — that's a degraded
  but recoverable state, not data loss.
* **OS-level secrets** (env vars, `SPIRE_DB_PASSPHRASE`).
* **Misc runtime caches** that aren't part of the canonical
  state.

Atomicity
---------
``create_backup`` writes to a temp file in the same directory
as the target, then renames into place. ``restore_backup``
extracts to a temp directory, validates, then moves files into
``runtime/`` only if validation passes. If anything fails
mid-restore the previous state archive (auto-captured at the
start of restore) is the recovery path.

NIST 800-53 alignment
---------------------
* CP-9 (Information System Backup): scheduled snapshot capability.
* CP-10 (Information System Recovery and Reconstitution): restore
  with integrity verification before reconstitution.
* AU-9 (Protection of Audit Information): audit chain integrity
  is verified pre- and post-restore.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


log = logging.getLogger(__name__)


ARCHIVE_FORMAT_VERSION = "1"
MANIFEST_FILENAME = "manifest.json"
DB_FILENAME = "spire.db"
DB_ENC_FILENAME = "spire.db.enc"
PIN_FILENAME = "audit_pin.jsonl"


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


@dataclass
class BackupManifest:
    """Self-describing manifest for a SPIRE backup archive.

    All fields are JSON-serializable. ``manifest_self_hash`` is
    computed over the canonical-JSON form of the manifest with
    that field set to ``""`` — verifiers recompute and compare,
    so any byte mutation in the manifest itself is detected.
    """

    archive_format_version: str = ARCHIVE_FORMAT_VERSION
    spire_git_rev: str = ""
    label: str = ""
    created_at: str = ""
    db_filename: str = DB_FILENAME
    db_sha256: str = ""
    db_byte_count: int = 0
    db_encrypted: bool = False
    pin_filename: Optional[str] = None
    pin_sha256: Optional[str] = None
    pin_byte_count: int = 0
    schema_versions: Dict[str, List[int]] = field(default_factory=dict)
    audit_entry_count: int = 0
    audit_head_hash: Optional[str] = None
    audit_chain_ok_at_backup: bool = False
    audit_signing_enabled: bool = False
    audit_head_signature: Optional[str] = None
    manifest_self_hash: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, raw: Dict[str, Any]) -> "BackupManifest":
        # Tolerate forward-compat fields silently; an older verifier
        # encountering a newer manifest still validates the fields it
        # knows about.
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in raw.items() if k in known})


def _canonical_json(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _compute_manifest_self_hash(manifest: BackupManifest) -> str:
    """SHA-256 of the canonical manifest with ``manifest_self_hash``
    blanked. Recomputed on verify to detect any byte mutation."""
    raw = manifest.to_dict()
    raw["manifest_self_hash"] = ""
    return hashlib.sha256(_canonical_json(raw)).hexdigest()


def _file_sha256(path: Path) -> Tuple[str, int]:
    """Stream the file through SHA-256 — works for multi-GB DBs
    without loading into RAM. Returns (hex_digest, byte_count)."""
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
            n += len(chunk)
    return h.hexdigest(), n


# ---------------------------------------------------------------------------
# Snapshot helpers
# ---------------------------------------------------------------------------


def _git_rev_safely(repo_dir: Path) -> str:
    """Best-effort `git rev-parse HEAD`. Returns '' on failure —
    backup must work in environments without git installed."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(repo_dir), capture_output=True, text=True,
            timeout=2,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except (FileNotFoundError, subprocess.SubprocessError):
        pass
    return ""


def _schema_inventory(db_path: Path) -> Dict[str, List[int]]:
    """Read the ``uis_schema_migrations`` table from a snapshot DB
    and return {table_name: [versions]}. Empty dict if the table
    doesn't exist (older DB before P4.11)."""
    out: Dict[str, List[int]] = {}
    try:
        c = sqlite3.connect(str(db_path))
        c.row_factory = sqlite3.Row
        try:
            rows = c.execute(
                "SELECT table_name, version FROM uis_schema_migrations "
                "ORDER BY table_name, version"
            ).fetchall()
            for r in rows:
                out.setdefault(r["table_name"], []).append(r["version"])
        except sqlite3.OperationalError:
            # Table missing — pre-migrations DB. Not an error.
            pass
        finally:
            c.close()
    except sqlite3.Error as e:
        log.warning("schema inventory failed: %s", e)
    return out


def _audit_chain_walk(db_path: Path) -> Dict[str, Any]:
    """Standalone audit chain walk against a snapshot DB.

    Mirrors :func:`backend.persistence.verify_chain` but operates
    on an arbitrary file path so a verifier can validate an
    archive's embedded DB without touching the live SPIRE state.
    """
    GENESIS = "0" * 64

    def _row_canonical(row: sqlite3.Row) -> str:
        entry = {
            "ts": row["ts"], "actor": row["actor"], "kind": row["kind"],
            "subject_id": row["subject_id"], "payload": row["payload"],
            "prev_hash": row["prev_hash"],
        }
        return json.dumps(entry, sort_keys=True, separators=(",", ":"), default=str)

    try:
        c = sqlite3.connect(str(db_path))
    except sqlite3.Error as e:
        return {"ok": False, "entries": 0, "head_hash": None, "error": str(e)}
    c.row_factory = sqlite3.Row
    try:
        # Tolerate DBs that don't have audit_log yet (a fresh DB
        # before init_db has run). Tolerate completely corrupt
        # files (the verifier already flagged the SHA mismatch
        # earlier — we just don't want to crash on a read).
        try:
            rows = list(c.execute(
                "SELECT id, ts, actor, kind, subject_id, payload, prev_hash, self_hash "
                "FROM audit_log ORDER BY id ASC"
            ))
        except sqlite3.OperationalError:
            return {"ok": True, "entries": 0, "head_hash": None}
        except sqlite3.DatabaseError as e:
            return {"ok": False, "entries": 0, "head_hash": None, "error": str(e)}
        prev = GENESIS
        for r in rows:
            expected = hashlib.sha256(
                (prev + _row_canonical(r)).encode()
            ).hexdigest()
            if r["prev_hash"] != prev or r["self_hash"] != expected:
                return {
                    "ok": False, "entries": len(rows),
                    "broken_at_id": r["id"], "head_hash": prev,
                }
            prev = r["self_hash"]
        return {"ok": True, "entries": len(rows), "head_hash": prev if rows else None}
    finally:
        c.close()


def _hot_backup_sqlite(source_db: Path, dest_db: Path) -> None:
    """SQLite's Online Backup API — copies a live DB to a target
    transactionally. Safe to run while the source has open
    connections; the target is a clean, complete snapshot."""
    src = sqlite3.connect(str(source_db))
    try:
        dst = sqlite3.connect(str(dest_db))
        try:
            with dst:
                src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()


def _passphrase_from_env() -> Optional[str]:
    """Resolve the at-rest passphrase. Mirrors persistence._DB_PASSPHRASE
    but reads at call time so a CLI tool can override via env."""
    raw = os.environ.get("SPIRE_DB_PASSPHRASE", "")
    return raw if raw else None


def _encrypt_file(plaintext: Path, ciphertext: Path, passphrase: str) -> None:
    """Encrypt ``plaintext`` to ``ciphertext`` with the same AES-256-GCM
    primitive the live DB uses (single source of truth in
    :mod:`backend.persistence`). Reads the source whole-file — fine for
    pilot-scale DBs (low-GB); large-DB streaming is a future task."""
    from ..persistence import _encrypt_blob
    ciphertext.write_bytes(_encrypt_blob(plaintext.read_bytes(), passphrase))


def _decrypt_file(ciphertext: Path, plaintext: Path, passphrase: str) -> None:
    """Decrypt a backup. Transparently reads both the AES-256-GCM format and
    legacy Fernet backups taken before the migration."""
    from ..persistence import _decrypt_blob
    plaintext.write_bytes(_decrypt_blob(ciphertext.read_bytes(), passphrase))


# ---------------------------------------------------------------------------
# Backup creation
# ---------------------------------------------------------------------------


def _runtime_dir() -> Path:
    """Live runtime directory — same as backend.persistence.DATA_DIR.
    Read fresh each call so test-mode env override works."""
    override = os.environ.get("SPIRE_RUNTIME_DIR", "").strip()
    if override:
        return Path(override)
    # Module sits at backend/uis/dr.py — runtime/ is two parents up.
    return Path(__file__).resolve().parent.parent.parent / "runtime"


def _repo_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def create_backup(
    out_path: Path,
    *,
    label: str = "",
    include_pin: bool = True,
) -> BackupManifest:
    """Write a SPIRE backup archive to ``out_path``.

    The archive is content-addressed — the manifest records
    SHA-256 of every embedded file plus a self-hash over the
    manifest itself. Verifiers recompute and compare; any byte
    mutation in the archive is detected.

    On success returns the populated manifest. On failure raises
    and leaves no partial archive at ``out_path``.

    Hot backup: uses SQLite's Online Backup API so the live SPIRE
    process can keep serving requests while the archive is being
    written.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    runtime = _runtime_dir()
    if not runtime.exists():
        raise FileNotFoundError(f"runtime directory missing: {runtime}")

    # Resolve which DB file to snapshot. Live SPIRE keeps the
    # plaintext spire.db open during the request that triggered
    # the backup, so the Online Backup API works against it. If
    # the encrypted variant is the only on-disk artifact (process
    # not running, .db re-locked), we copy the .enc file as-is —
    # it's already at-rest-encrypted and verifiable byte-for-byte.
    plain_db = runtime / "spire.db"
    enc_db = runtime / "spire.db.enc"

    passphrase = _passphrase_from_env()

    with tempfile.TemporaryDirectory(prefix="spire-dr-") as tmpdir:
        tmp = Path(tmpdir)
        archive_db_name = DB_FILENAME
        db_encrypted = False

        # Step 1: produce a plaintext snapshot we can walk for
        # the manifest (audit chain, schema versions). We do
        # this regardless of whether the final archive will be
        # encrypted — the operator's manifest must reflect the
        # plaintext content's integrity.
        snapshot_plain = tmp / "_snapshot.db"
        if plain_db.exists():
            _hot_backup_sqlite(plain_db, snapshot_plain)
        elif enc_db.exists():
            # Process is locked. Decrypt the at-rest artifact to
            # produce the same plaintext snapshot. Requires the
            # passphrase (must match what produced the .enc).
            if not passphrase:
                raise RuntimeError(
                    "spire.db.enc exists but SPIRE_DB_PASSPHRASE is "
                    "not set; cannot snapshot an encrypted DB without "
                    "the passphrase."
                )
            _decrypt_file(enc_db, snapshot_plain, passphrase)
        else:
            raise FileNotFoundError(
                f"no SPIRE database found in {runtime} "
                f"(expected spire.db or spire.db.enc)"
            )

        # Walk the plaintext snapshot for chain + schema. Done
        # before any encryption so the manifest's audit fields
        # are populated.
        schema_versions = _schema_inventory(snapshot_plain)
        chain = _audit_chain_walk(snapshot_plain)

        # Step 2: produce the archive payload. With a passphrase
        # set, encrypt the snapshot so the archive matches the
        # at-rest privacy posture of the live DB. Without a
        # passphrase, the archive carries plaintext SQLite — which
        # is fine for an unencrypted deployment.
        if passphrase:
            tmp_db = tmp / DB_ENC_FILENAME
            archive_db_name = DB_ENC_FILENAME
            db_encrypted = True
            _encrypt_file(snapshot_plain, tmp_db, passphrase)
            # Wipe the plaintext snapshot before the temp dir is
            # cleaned up — defense-in-depth so the OS doesn't keep
            # the bytes in any transient cache after Python exits.
            try:
                snapshot_plain.unlink()
            except OSError:
                pass
        else:
            tmp_db = tmp / DB_FILENAME
            os.replace(snapshot_plain, tmp_db)

        db_sha, db_bytes = _file_sha256(tmp_db)

        # Optional pin file
        pin_filename: Optional[str] = None
        pin_sha: Optional[str] = None
        pin_bytes = 0
        if include_pin:
            pin_env = os.environ.get("SPIRE_AUDIT_PIN_PATH", "").strip()
            if pin_env:
                pin_path = Path(pin_env)
                if pin_path.exists():
                    tmp_pin = tmp / PIN_FILENAME
                    shutil.copy2(pin_path, tmp_pin)
                    pin_sha, pin_bytes = _file_sha256(tmp_pin)
                    pin_filename = PIN_FILENAME

        # Audit signing posture (best-effort import — DR module
        # must be standalone enough that a CLI tool without the
        # full backend can still produce backups)
        signing_enabled = False
        head_signature: Optional[str] = None
        try:
            from .audit_integrity import signing_enabled as _se, sign_entry_hash
            signing_enabled = bool(_se())
            if signing_enabled and chain.get("head_hash"):
                head_signature = sign_entry_hash(chain["head_hash"])
        except Exception:  # noqa: BLE001
            pass

        # Build manifest, then compute self-hash, then re-write
        # with the self-hash filled in.
        manifest = BackupManifest(
            archive_format_version=ARCHIVE_FORMAT_VERSION,
            spire_git_rev=_git_rev_safely(_repo_root()),
            label=label,
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            db_filename=archive_db_name,
            db_sha256=db_sha,
            db_byte_count=db_bytes,
            db_encrypted=db_encrypted,
            pin_filename=pin_filename,
            pin_sha256=pin_sha,
            pin_byte_count=pin_bytes,
            schema_versions=schema_versions,
            audit_entry_count=int(chain.get("entries", 0)),
            audit_head_hash=chain.get("head_hash"),
            audit_chain_ok_at_backup=bool(chain.get("ok")),
            audit_signing_enabled=signing_enabled,
            audit_head_signature=head_signature,
            manifest_self_hash="",
        )
        manifest.manifest_self_hash = _compute_manifest_self_hash(manifest)

        manifest_path = tmp / MANIFEST_FILENAME
        manifest_path.write_bytes(_canonical_json(manifest.to_dict()))

        # Atomic write — tar to a sibling temp file, then rename
        # into place. Failures leave no partial archive at out_path.
        tmp_tar = out_path.with_suffix(out_path.suffix + ".inprogress")
        try:
            with tarfile.open(tmp_tar, "w:gz") as tar:
                tar.add(manifest_path, arcname=MANIFEST_FILENAME)
                tar.add(tmp_db, arcname=archive_db_name)
                if pin_filename:
                    tar.add(tmp / pin_filename, arcname=pin_filename)
            os.replace(tmp_tar, out_path)
        except Exception:
            if tmp_tar.exists():
                try:
                    tmp_tar.unlink()
                except OSError:
                    pass
            raise

        log.info(
            "DR backup written: %s (db_sha=%s..%s, %d audit entries)",
            out_path, db_sha[:8], db_sha[-8:], manifest.audit_entry_count,
        )
        return manifest


# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------


@dataclass
class VerifyResult:
    ok: bool
    issues: List[str] = field(default_factory=list)
    manifest: Optional[BackupManifest] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "issues": list(self.issues),
            "manifest": self.manifest.to_dict() if self.manifest else None,
        }


MAX_EXTRACT_BYTES = 4 * 1024 ** 3  # 4 GB — reject decompression bombs (CWE-409)


def _safe_extract(tar: tarfile.TarFile, dest: Path, allowed: List[str]) -> None:
    """Extract only ``allowed`` member names; reject any path
    that escapes ``dest`` (`..` traversal, absolute paths,
    symlinks). Defends against malicious archive content per
    CWE-22.
    """
    dest = dest.resolve()
    total = 0
    for member in tar.getmembers():
        if member.name not in allowed:
            raise ValueError(f"unexpected archive member: {member.name!r}")
        if member.issym() or member.islnk():
            raise ValueError(f"archive contains link member: {member.name!r}")
        target = (dest / member.name).resolve()
        if dest not in target.parents and target != dest:
            raise ValueError(f"archive escapes dest: {member.name!r}")
        total += max(0, member.size)
        if total > MAX_EXTRACT_BYTES:
            raise ValueError(f"archive exceeds {MAX_EXTRACT_BYTES}-byte extract cap")
    tar.extractall(dest)  # noqa: S202 — guarded above


def _read_manifest(extracted_dir: Path) -> Tuple[BackupManifest, Dict[str, Any]]:
    """Load and parse manifest.json, returning both the dataclass
    and the original dict (the dict is needed to detect forward-
    compat fields the verifier doesn't know about — those are
    preserved across the self-hash recomputation)."""
    raw = json.loads((extracted_dir / MANIFEST_FILENAME).read_text(encoding="utf-8"))
    return BackupManifest.from_dict(raw), raw


def verify_backup(archive_path: Path) -> VerifyResult:
    """End-to-end verify of a backup archive without restoring.

    Checks performed:

      * Manifest file present and well-formed JSON
      * Manifest self-hash matches recomputation
      * Embedded DB file present, SHA-256 matches manifest
      * Embedded DB byte-count matches manifest
      * Pin file (if any) SHA-256 matches manifest
      * Embedded audit chain still verifies end-to-end (when DB
        is plaintext)
      * Embedded audit chain head matches manifest's recorded head

    Pure read-only: nothing on disk is modified; the live SPIRE
    runtime is untouched.
    """
    archive_path = Path(archive_path)
    if not archive_path.exists():
        return VerifyResult(ok=False, issues=[f"archive not found: {archive_path}"])

    issues: List[str] = []
    with tempfile.TemporaryDirectory(prefix="spire-dr-verify-") as tmpdir:
        tmp = Path(tmpdir)
        try:
            with tarfile.open(archive_path, "r:gz") as tar:
                names = [m.name for m in tar.getmembers()]
                # Pin is optional, manifest + db required.
                if MANIFEST_FILENAME not in names:
                    return VerifyResult(
                        ok=False, issues=[f"missing {MANIFEST_FILENAME}"],
                    )
                # Compute allowed list lazily — read manifest first
                # to know which DB filename to expect.
                tar.extract(MANIFEST_FILENAME, tmp)
                manifest, raw_manifest_dict = _read_manifest(tmp)
                allowed = [MANIFEST_FILENAME, manifest.db_filename]
                if manifest.pin_filename:
                    allowed.append(manifest.pin_filename)
                # Now do the safe, full extraction with the proper
                # allowed list.
                tar_db_members = [m for m in tar.getmembers() if m.name != MANIFEST_FILENAME]
                # Re-extract everything (including pin) safely. The
                # earlier single-file extract is fine because we
                # already verified `archive_path` opened cleanly.
                with tarfile.open(archive_path, "r:gz") as tar2:
                    _safe_extract(tar2, tmp, allowed)
        except (tarfile.TarError, ValueError, OSError) as e:
            return VerifyResult(ok=False, issues=[f"archive read failed: {e}"])

        manifest, raw_manifest_dict = _read_manifest(tmp)

        # Manifest self-hash — the most important integrity check.
        # If this fails, every other field is suspect.
        recorded = manifest.manifest_self_hash
        recomputed = _compute_manifest_self_hash(manifest)
        if not recorded:
            issues.append("manifest_self_hash missing")
        elif recorded != recomputed:
            issues.append(
                f"manifest_self_hash mismatch: archive={recorded[:16]}.. "
                f"recomputed={recomputed[:16]}.."
            )

        # DB file integrity
        db_path = tmp / manifest.db_filename
        if not db_path.exists():
            issues.append(f"missing {manifest.db_filename}")
        else:
            db_sha, db_bytes = _file_sha256(db_path)
            if db_sha != manifest.db_sha256:
                issues.append(
                    f"db sha256 mismatch: file={db_sha[:16]}.. "
                    f"manifest={manifest.db_sha256[:16]}.."
                )
            if db_bytes != manifest.db_byte_count:
                issues.append(
                    f"db byte_count mismatch: file={db_bytes} "
                    f"manifest={manifest.db_byte_count}"
                )

            # Audit-chain walk — for encrypted archives we need
            # the passphrase to decrypt to a temp plaintext file
            # first. Without the passphrase the byte-hash check
            # above is the only integrity signal we can offer.
            walk_path: Optional[Path] = None
            if not manifest.db_encrypted and manifest.db_filename == DB_FILENAME:
                walk_path = db_path
            elif manifest.db_encrypted:
                pp = _passphrase_from_env()
                if pp:
                    walk_path = tmp / "_decrypted.db"
                    try:
                        _decrypt_file(db_path, walk_path, pp)
                    except Exception as e:  # noqa: BLE001
                        issues.append(
                            f"decrypt failed (passphrase mismatch?): {e}"
                        )
                        walk_path = None
                else:
                    # Not an error — operator may be verifying an
                    # encrypted archive on a host without the
                    # passphrase. Hash check + manifest self-hash
                    # are still meaningful integrity signals.
                    pass

            if walk_path is not None:
                chain = _audit_chain_walk(walk_path)
                if not chain.get("ok"):
                    issues.append(
                        f"embedded audit chain fails verification "
                        f"(broken_at_id={chain.get('broken_at_id')})"
                    )
                if chain.get("entries", 0) != manifest.audit_entry_count:
                    issues.append(
                        f"audit_entry_count mismatch: chain={chain.get('entries')} "
                        f"manifest={manifest.audit_entry_count}"
                    )
                if (
                    manifest.audit_head_hash
                    and chain.get("head_hash") != manifest.audit_head_hash
                ):
                    issues.append(
                        f"audit_head_hash mismatch: chain={(chain.get('head_hash') or '')[:16]}.. "
                        f"manifest={(manifest.audit_head_hash or '')[:16]}.."
                    )

        # Pin file integrity (optional)
        if manifest.pin_filename:
            pin_path = tmp / manifest.pin_filename
            if not pin_path.exists():
                issues.append(f"missing {manifest.pin_filename}")
            else:
                pin_sha, pin_bytes = _file_sha256(pin_path)
                if pin_sha != manifest.pin_sha256:
                    issues.append("pin sha256 mismatch")
                if pin_bytes != manifest.pin_byte_count:
                    issues.append("pin byte_count mismatch")

    return VerifyResult(ok=not issues, issues=issues, manifest=manifest)


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------


@dataclass
class RestoreResult:
    ok: bool
    issues: List[str] = field(default_factory=list)
    pre_state_archive: Optional[Path] = None
    post_state: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "ok": self.ok,
            "issues": list(self.issues),
            "pre_state_archive": str(self.pre_state_archive) if self.pre_state_archive else None,
            "post_state": self.post_state,
        }


def restore_backup(
    archive_path: Path,
    *,
    verify: bool = True,
    capture_prior_state: bool = True,
    dry_run: bool = False,
) -> RestoreResult:
    """Restore a backup archive into the live ``runtime/`` directory.

    Steps:

      1. Verify the archive (unless ``verify=False``).
      2. Capture a pre-restore archive of the current runtime
         state so the operator can roll back if the restore is
         later regretted (set ``capture_prior_state=False`` to
         skip — useful for tests / sandbox scenarios).
      3. Extract the archive to a temp dir.
      4. Move the embedded DB / pin into place atomically. The
         on-disk SPIRE process must NOT be holding open
         connections during this step — call only after
         draining requests.

    With ``dry_run=True`` everything except the final move-into-
    place happens. Useful for dress-rehearsal smoke checks.
    """
    archive_path = Path(archive_path)
    issues: List[str] = []

    if verify:
        v = verify_backup(archive_path)
        if not v.ok:
            return RestoreResult(ok=False, issues=v.issues)

    runtime = _runtime_dir()
    runtime.mkdir(parents=True, exist_ok=True)

    pre_archive: Optional[Path] = None
    if capture_prior_state and ((runtime / "spire.db").exists() or (runtime / "spire.db.enc").exists()):
        try:
            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            pre_archive = runtime / f"pre_restore_{ts}_{uuid.uuid4().hex[:8]}.tar.gz"
            create_backup(pre_archive, label=f"pre-restore snapshot ({archive_path.name})")
        except Exception as e:  # noqa: BLE001
            issues.append(f"pre-restore snapshot failed: {e}")
            return RestoreResult(ok=False, issues=issues)

    with tempfile.TemporaryDirectory(prefix="spire-dr-restore-") as tmpdir:
        tmp = Path(tmpdir)
        try:
            # Re-read the manifest to know the DB filename.
            with tarfile.open(archive_path, "r:gz") as tar:
                tar.extract(MANIFEST_FILENAME, tmp)
                manifest, _ = _read_manifest(tmp)
                allowed = [MANIFEST_FILENAME, manifest.db_filename]
                if manifest.pin_filename:
                    allowed.append(manifest.pin_filename)
                with tarfile.open(archive_path, "r:gz") as tar2:
                    _safe_extract(tar2, tmp, allowed)
        except (tarfile.TarError, ValueError, OSError) as e:
            return RestoreResult(
                ok=False,
                issues=[f"extract failed: {e}"],
                pre_state_archive=pre_archive,
            )

        if dry_run:
            return RestoreResult(
                ok=True, issues=issues, pre_state_archive=pre_archive,
                post_state={"dry_run": True, "manifest": manifest.to_dict()},
            )

        # Move into place. Use os.replace (atomic on same FS).
        # Remove the *other* DB filename if it was present —
        # restoring an encrypted backup over a plaintext install
        # (or vice versa) shouldn't leave the stale variant
        # behind to confuse persistence._unlock_db on next boot.
        try:
            src_db = tmp / manifest.db_filename
            dst_db = runtime / manifest.db_filename
            os.replace(src_db, dst_db)

            other = DB_ENC_FILENAME if manifest.db_filename == DB_FILENAME else DB_FILENAME
            other_path = runtime / other
            if other_path.exists():
                other_path.unlink()

            if manifest.pin_filename:
                pin_env = os.environ.get("SPIRE_AUDIT_PIN_PATH", "").strip()
                if pin_env:
                    target = Path(pin_env)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(tmp / manifest.pin_filename, target)
                else:
                    # Pin restoration depends on operator env — when
                    # SPIRE_AUDIT_PIN_PATH isn't set, drop the pin
                    # file in runtime/ so the operator can move it.
                    os.replace(
                        tmp / manifest.pin_filename,
                        runtime / manifest.pin_filename,
                    )
        except OSError as e:
            issues.append(f"move failed: {e}")
            return RestoreResult(
                ok=False, issues=issues, pre_state_archive=pre_archive,
            )

    # Post-restore re-verification: walk the chain on the now-
    # live DB to confirm the move didn't corrupt anything. For
    # encrypted backups we decrypt to a temp file, walk it, then
    # delete the temp — the live .enc stays in place for the
    # next process boot to unlock.
    post: Dict[str, Any] = {}
    db_now = runtime / manifest.db_filename
    walk_target: Optional[Path] = None
    walk_temp: Optional[Path] = None
    if db_now.exists():
        if not manifest.db_encrypted:
            walk_target = db_now
        else:
            pp = _passphrase_from_env()
            if pp:
                with tempfile.NamedTemporaryFile(
                    delete=False, suffix=".db", prefix="spire-dr-postv-",
                ) as tf:
                    walk_temp = Path(tf.name)
                try:
                    _decrypt_file(db_now, walk_temp, pp)
                    walk_target = walk_temp
                except Exception as e:  # noqa: BLE001
                    issues.append(
                        f"post-restore decrypt failed (passphrase mismatch?): {e}"
                    )
            else:
                post["audit_chain_walk_skipped"] = "no SPIRE_DB_PASSPHRASE"

    if walk_target is not None:
        chain_now = _audit_chain_walk(walk_target)
        post["audit_chain_ok"] = chain_now.get("ok")
        post["audit_entries"] = chain_now.get("entries")
        post["audit_head_hash"] = chain_now.get("head_hash")
        if not chain_now.get("ok"):
            issues.append(
                "post-restore audit chain verification failed "
                f"(broken_at_id={chain_now.get('broken_at_id')})"
            )

    if walk_temp is not None:
        try:
            walk_temp.unlink()
        except OSError:
            pass

    return RestoreResult(
        ok=not issues, issues=issues,
        pre_state_archive=pre_archive, post_state=post,
    )


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------


@dataclass
class BackupSummary:
    archive_path: Path
    archive_byte_count: int
    archive_sha256: str
    manifest: Optional[BackupManifest]
    readable: bool
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "archive_path": str(self.archive_path),
            "archive_byte_count": self.archive_byte_count,
            "archive_sha256": self.archive_sha256,
            "manifest": self.manifest.to_dict() if self.manifest else None,
            "readable": self.readable,
            "error": self.error,
        }


def list_backups(directory: Path) -> List[BackupSummary]:
    """Return summaries for every ``*.tar.gz`` in ``directory``.

    Best-effort: an unreadable archive yields ``readable=False``
    with the error attached, but doesn't abort the listing. Used
    by the admin UI to populate a backup inventory list.
    """
    directory = Path(directory)
    if not directory.exists():
        return []
    out: List[BackupSummary] = []
    for path in sorted(directory.glob("*.tar.gz")):
        try:
            sha, bytecount = _file_sha256(path)
        except OSError as e:
            out.append(BackupSummary(
                archive_path=path, archive_byte_count=0, archive_sha256="",
                manifest=None, readable=False, error=f"hash failed: {e}",
            ))
            continue
        manifest: Optional[BackupManifest] = None
        readable = True
        err: Optional[str] = None
        try:
            with tempfile.TemporaryDirectory(prefix="spire-dr-list-") as tmpdir:
                tmp = Path(tmpdir)
                with tarfile.open(path, "r:gz") as tar:
                    if MANIFEST_FILENAME not in [m.name for m in tar.getmembers()]:
                        readable = False
                        err = "manifest missing"
                    else:
                        tar.extract(MANIFEST_FILENAME, tmp)
                        manifest, _ = _read_manifest(tmp)
        except (tarfile.TarError, ValueError, OSError) as e:
            readable = False
            err = str(e)
        out.append(BackupSummary(
            archive_path=path,
            archive_byte_count=bytecount,
            archive_sha256=sha,
            manifest=manifest,
            readable=readable,
            error=err,
        ))
    return out


# ---------------------------------------------------------------------------
# Retention pruning
# ---------------------------------------------------------------------------


@dataclass
class PruneResult:
    pruned: List[Path] = field(default_factory=list)
    kept: List[Path] = field(default_factory=list)
    skipped_unreadable: List[Path] = field(default_factory=list)
    dry_run: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pruned": [str(p) for p in self.pruned],
            "kept": [str(p) for p in self.kept],
            "skipped_unreadable": [str(p) for p in self.skipped_unreadable],
            "dry_run": self.dry_run,
        }


def prune_backups(
    directory: Path,
    *,
    keep_count: Optional[int] = None,
    keep_days: Optional[int] = None,
    dry_run: bool = False,
) -> PruneResult:
    """Apply a retention policy to a backup directory.

    Either ``keep_count`` (preserve the N most recent archives)
    or ``keep_days`` (preserve archives whose ``created_at`` is
    within N days), or both. When both are provided an archive is
    kept if EITHER policy says keep — the union, not the
    intersection.

    Ordering is by manifest ``created_at`` (most recent first).
    Archives that are unreadable (corrupt, missing manifest) are
    NEVER pruned — they're surfaced separately in
    ``skipped_unreadable`` so an operator can decide.

    With ``dry_run=True`` nothing is deleted; the result reports
    what WOULD have been pruned.
    """
    if keep_count is None and keep_days is None:
        raise ValueError("at least one of keep_count or keep_days is required")
    if keep_count is not None and keep_count < 0:
        raise ValueError("keep_count must be >= 0")
    if keep_days is not None and keep_days < 0:
        raise ValueError("keep_days must be >= 0")

    summaries = list_backups(Path(directory))
    result = PruneResult(dry_run=dry_run)

    readable: List[BackupSummary] = []
    for s in summaries:
        if s.readable and s.manifest:
            readable.append(s)
        else:
            result.skipped_unreadable.append(s.archive_path)

    # Sort newest-first by manifest.created_at; ties broken by
    # filename so the order is deterministic across runs.
    def _sort_key(s: BackupSummary) -> Tuple[str, str]:
        ts = (s.manifest.created_at if s.manifest else "") or ""
        return (ts, str(s.archive_path))

    readable.sort(key=_sort_key, reverse=True)

    cutoff_iso: Optional[str] = None
    if keep_days is not None:
        # Use a string comparison on ISO-8601 timestamps — works
        # because the manifest writes ``isoformat(timespec="seconds")``
        # which is lex-comparable. Beats parsing each one.
        from datetime import timedelta
        cutoff = datetime.now(timezone.utc) - timedelta(days=keep_days)
        cutoff_iso = cutoff.isoformat(timespec="seconds")

    for idx, s in enumerate(readable):
        keep = False
        if keep_count is not None and idx < keep_count:
            keep = True
        if cutoff_iso is not None:
            ts = (s.manifest.created_at if s.manifest else "") or ""
            if ts >= cutoff_iso:
                keep = True
        if keep:
            result.kept.append(s.archive_path)
        else:
            if not dry_run:
                try:
                    s.archive_path.unlink()
                except OSError as e:
                    log.warning("prune unlink failed for %s: %s", s.archive_path, e)
                    # If the unlink fails, treat it as kept so the
                    # caller doesn't think we removed it.
                    result.kept.append(s.archive_path)
                    continue
            result.pruned.append(s.archive_path)

    log.info(
        "prune_backups: directory=%s pruned=%d kept=%d skipped_unreadable=%d "
        "dry_run=%s",
        directory, len(result.pruned), len(result.kept),
        len(result.skipped_unreadable), dry_run,
    )
    return result
