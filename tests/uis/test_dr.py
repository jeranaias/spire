"""DR / backup primitive tests (UIS-P6.6)."""
from __future__ import annotations

import gzip
import hashlib
import io
import json
import sqlite3
import tarfile
from datetime import datetime, timezone
from pathlib import Path

import pytest


@pytest.fixture
def isolated_runtime(monkeypatch, tmp_path):
    """Fresh runtime dir + isolated DB for DR testing.

    Mirrors the ``isolated_db`` fixture used by audit_integrity
    tests, but also points :func:`backend.uis.dr._runtime_dir` at
    the temp dir via ``SPIRE_RUNTIME_DIR`` so the DR module reads
    and writes only inside ``tmp_path``.
    """
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    db_file = runtime / "spire.db"
    enc_file = runtime / "spire.db.enc"

    monkeypatch.setenv("SPIRE_RUNTIME_DIR", str(runtime))

    from backend import persistence
    monkeypatch.setattr(persistence, "DATA_DIR", runtime)
    monkeypatch.setattr(persistence, "DB_PATH", db_file)
    monkeypatch.setattr(persistence, "DB_ENCRYPTED_PATH", enc_file)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", None)

    # Reset audit-integrity cache so signing-toggle tests work
    from backend.uis import audit_integrity
    monkeypatch.setattr(audit_integrity, "_PRIVATE_KEY", None)
    monkeypatch.setattr(audit_integrity, "_PUBLIC_KEY", None)
    monkeypatch.setattr(audit_integrity, "_KEY_LOADED", False)

    persistence.init_db()
    return runtime


def _seed_audit_entries(n: int = 3) -> None:
    """Append ``n`` audit entries so the chain has substance to back up."""
    from backend.persistence import log as audit_log
    for i in range(n):
        audit_log(
            kind=f"test.event_{i}",
            actor="test",
            subject_id=f"subj-{i}",
            payload={"i": i, "note": "hello"},
        )


# ---------------------------------------------------------------------------
# Manifest hashing
# ---------------------------------------------------------------------------


def test_manifest_self_hash_excludes_self_field():
    """The self-hash is computed with the field zeroed — so two
    manifests that differ only in their self-hash slot would
    produce the same content hash. Sanity check on the property
    that makes verify_backup work."""
    from backend.uis.dr import BackupManifest, _compute_manifest_self_hash

    a = BackupManifest(label="x", db_sha256="abc")
    a.manifest_self_hash = "deadbeef"
    h_a = _compute_manifest_self_hash(a)
    a.manifest_self_hash = "cafebabe"
    h_a2 = _compute_manifest_self_hash(a)
    assert h_a == h_a2


# ---------------------------------------------------------------------------
# Backup creation
# ---------------------------------------------------------------------------


def test_create_backup_writes_archive_and_returns_manifest(isolated_runtime, tmp_path):
    _seed_audit_entries(2)
    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup

    manifest = create_backup(out, label="smoke")

    assert out.exists()
    assert out.stat().st_size > 0
    assert manifest.label == "smoke"
    assert manifest.db_filename == "spire.db"
    assert manifest.db_byte_count > 0
    assert manifest.audit_entry_count == 2
    assert manifest.audit_chain_ok_at_backup is True
    assert manifest.manifest_self_hash != ""


def test_create_backup_archive_contains_expected_members(isolated_runtime, tmp_path):
    _seed_audit_entries(1)
    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup
    create_backup(out)

    with tarfile.open(out, "r:gz") as tar:
        names = sorted(m.name for m in tar.getmembers())
    assert names == ["manifest.json", "spire.db"]


def test_create_backup_with_pin_file(isolated_runtime, tmp_path, monkeypatch):
    pin = tmp_path / "pin.jsonl"
    pin.write_text('{"ts":"2026-05-05","entry_count":1,"head_hash":"abc"}\n', encoding="utf-8")
    monkeypatch.setenv("SPIRE_AUDIT_PIN_PATH", str(pin))

    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup
    manifest = create_backup(out)

    assert manifest.pin_filename == "audit_pin.jsonl"
    assert manifest.pin_byte_count > 0
    with tarfile.open(out, "r:gz") as tar:
        names = sorted(m.name for m in tar.getmembers())
    assert "audit_pin.jsonl" in names


def test_create_backup_skips_pin_when_not_configured(isolated_runtime, tmp_path, monkeypatch):
    monkeypatch.delenv("SPIRE_AUDIT_PIN_PATH", raising=False)
    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup
    manifest = create_backup(out)
    assert manifest.pin_filename is None
    assert manifest.pin_sha256 is None


def test_create_backup_atomic_no_partial_on_error(isolated_runtime, tmp_path, monkeypatch):
    out = tmp_path / "snap.tar.gz"
    from backend.uis import dr

    # Force tarfile.open to raise after the manifest is computed.
    real_open = dr.tarfile.open

    def boom(*a, **kw):
        if "w:gz" in (kw.get("mode") or "") or (len(a) > 1 and "w:gz" in a[1]):
            raise OSError("simulated disk full")
        return real_open(*a, **kw)

    monkeypatch.setattr(dr.tarfile, "open", boom)
    with pytest.raises(OSError, match="simulated disk full"):
        dr.create_backup(out)
    assert not out.exists()
    # No leftover .inprogress either.
    assert not list(out.parent.glob("*.inprogress"))


# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------


def test_verify_backup_clean_archive(isolated_runtime, tmp_path):
    _seed_audit_entries(3)
    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup, verify_backup
    create_backup(out)

    result = verify_backup(out)
    assert result.ok is True
    assert result.issues == []
    assert result.manifest is not None
    assert result.manifest.audit_entry_count == 3


def _rebuild_archive_with_replaced_member(
    src_path: Path, dest_path: Path, member_name: str, new_data: bytes
) -> None:
    """Helper — extracts ``src_path`` and rebuilds it identically
    except ``member_name`` is replaced with ``new_data``."""
    with tarfile.open(src_path, "r:gz") as src_tar:
        members = src_tar.getmembers()
        contents = {m.name: src_tar.extractfile(m).read() for m in members}  # type: ignore[union-attr]
    contents[member_name] = new_data
    with tarfile.open(dest_path, "w:gz") as dst_tar:
        for name, data in contents.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            dst_tar.addfile(info, io.BytesIO(data))


def test_verify_detects_db_mutation(isolated_runtime, tmp_path):
    _seed_audit_entries(2)
    src = tmp_path / "good.tar.gz"
    bad = tmp_path / "bad.tar.gz"
    from backend.uis.dr import create_backup, verify_backup
    create_backup(src)

    # Replace the DB with a single zero byte — completely
    # different SHA, also won't open as SQLite. verify must
    # catch the SHA mismatch first (it does so before walking
    # the chain).
    _rebuild_archive_with_replaced_member(src, bad, "spire.db", b"\x00")
    result = verify_backup(bad)
    assert result.ok is False
    assert any("sha256 mismatch" in i for i in result.issues)


def test_verify_detects_manifest_mutation(isolated_runtime, tmp_path):
    _seed_audit_entries(1)
    src = tmp_path / "good.tar.gz"
    bad = tmp_path / "bad.tar.gz"
    from backend.uis.dr import create_backup, verify_backup
    create_backup(src)

    # Tamper with the manifest's label field; recompute self-hash
    # if you wanted to forge — but the test asserts that simple
    # tampering (without re-signing the manifest) is caught.
    with tarfile.open(src, "r:gz") as tar:
        manifest_bytes = tar.extractfile("manifest.json").read()  # type: ignore[union-attr]
    manifest_obj = json.loads(manifest_bytes)
    manifest_obj["label"] = "tampered"
    new_manifest = json.dumps(manifest_obj, sort_keys=True, separators=(",", ":")).encode()
    _rebuild_archive_with_replaced_member(src, bad, "manifest.json", new_manifest)

    result = verify_backup(bad)
    assert result.ok is False
    assert any("manifest_self_hash mismatch" in i for i in result.issues)


def test_verify_missing_archive():
    from backend.uis.dr import verify_backup
    result = verify_backup(Path("/nonexistent/no-such-archive.tar.gz"))
    assert result.ok is False
    assert any("not found" in i for i in result.issues)


def test_verify_archive_without_manifest(tmp_path):
    bogus = tmp_path / "no-manifest.tar.gz"
    with tarfile.open(bogus, "w:gz") as tar:
        info = tarfile.TarInfo("spire.db")
        info.size = 4
        tar.addfile(info, io.BytesIO(b"data"))
    from backend.uis.dr import verify_backup
    result = verify_backup(bogus)
    assert result.ok is False
    assert any("manifest" in i.lower() for i in result.issues)


# ---------------------------------------------------------------------------
# Round-trip + restore
# ---------------------------------------------------------------------------


def test_restore_round_trip_preserves_audit_chain(isolated_runtime, tmp_path):
    """End-to-end: seed entries → backup → mutate live DB →
    restore → live DB matches the snapshot."""
    _seed_audit_entries(3)
    archive = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup, restore_backup
    from backend.persistence import verify_chain

    pre_chain = verify_chain()
    assert pre_chain["ok"]
    pre_head = pre_chain["head_hash"]

    create_backup(archive)

    # Mutate live state — append more entries that should be
    # WIPED OUT by the restore.
    _seed_audit_entries(5)
    mutated = verify_chain()
    assert mutated["entries"] > pre_chain["entries"]

    result = restore_backup(archive, capture_prior_state=False)
    assert result.ok, result.issues

    post = verify_chain()
    assert post["ok"]
    assert post["head_hash"] == pre_head
    assert post["entries"] == pre_chain["entries"]


def test_restore_dry_run_leaves_runtime_untouched(isolated_runtime, tmp_path):
    _seed_audit_entries(2)
    archive = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup, restore_backup
    from backend.persistence import verify_chain

    create_backup(archive)
    _seed_audit_entries(4)
    pre_count = verify_chain()["entries"]

    result = restore_backup(archive, capture_prior_state=False, dry_run=True)
    assert result.ok
    assert result.post_state and result.post_state.get("dry_run") is True

    # Live DB still has the post-backup additions
    assert verify_chain()["entries"] == pre_count


def test_restore_captures_pre_state_archive(isolated_runtime, tmp_path):
    _seed_audit_entries(1)
    archive = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup, restore_backup
    create_backup(archive)

    result = restore_backup(archive, capture_prior_state=True)
    assert result.ok
    assert result.pre_state_archive is not None
    assert result.pre_state_archive.exists()


def test_restore_skips_pre_state_when_disabled(isolated_runtime, tmp_path):
    """``capture_prior_state=False`` must skip the pre-restore snapshot
    even though the live ``spire.db`` exists. Regression for the
    operator-precedence bug where ``and ... or enc.exists()`` made the
    snapshot fire regardless of the flag."""
    _seed_audit_entries(1)
    archive = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup, restore_backup
    create_backup(archive)
    assert (isolated_runtime / "spire.db").exists()

    result = restore_backup(archive, capture_prior_state=False)
    assert result.ok, result.issues
    assert result.pre_state_archive is None
    # No stray pre_restore_* snapshot left behind in the runtime dir.
    assert not list(isolated_runtime.glob("pre_restore_*.tar.gz"))


def test_restore_refuses_corrupted_archive(isolated_runtime, tmp_path):
    src = tmp_path / "good.tar.gz"
    bad = tmp_path / "bad.tar.gz"
    from backend.uis.dr import create_backup, restore_backup
    _seed_audit_entries(1)
    create_backup(src)
    _rebuild_archive_with_replaced_member(src, bad, "spire.db", b"\x00\x00\x00")

    result = restore_backup(bad, capture_prior_state=False)
    assert result.ok is False
    assert result.issues


# ---------------------------------------------------------------------------
# Inventory
# ---------------------------------------------------------------------------


def test_list_backups_returns_summaries(isolated_runtime, tmp_path):
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    from backend.uis.dr import create_backup, list_backups
    create_backup(archive_dir / "first.tar.gz", label="first")
    _seed_audit_entries(1)
    create_backup(archive_dir / "second.tar.gz", label="second")

    summaries = list_backups(archive_dir)
    assert len(summaries) == 2
    labels = {s.manifest.label for s in summaries if s.manifest}
    assert labels == {"first", "second"}
    for s in summaries:
        assert s.readable
        assert s.archive_byte_count > 0
        assert s.archive_sha256


def test_list_backups_handles_unreadable_archives(tmp_path):
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    bogus = archive_dir / "bogus.tar.gz"
    # Not actually a gzip archive — just plain text. list_backups
    # should report it as unreadable rather than raising.
    bogus.write_text("not a tar archive", encoding="utf-8")
    from backend.uis.dr import list_backups
    summaries = list_backups(archive_dir)
    assert len(summaries) == 1
    assert summaries[0].readable is False
    assert summaries[0].error


def test_list_backups_empty_directory(tmp_path):
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    from backend.uis.dr import list_backups
    assert list_backups(archive_dir) == []


def test_list_backups_missing_directory(tmp_path):
    from backend.uis.dr import list_backups
    assert list_backups(tmp_path / "does-not-exist") == []


# ---------------------------------------------------------------------------
# Path-traversal defense
# ---------------------------------------------------------------------------


def test_verify_rejects_archive_with_path_traversal(tmp_path):
    """Hand-crafted archive with a `../etc/passwd` member must be
    refused at extract time — not extracted into the dest dir."""
    bad = tmp_path / "evil.tar.gz"
    with tarfile.open(bad, "w:gz") as tar:
        # First add a real-looking manifest so the verifier gets
        # past the manifest-presence check
        manifest = {
            "archive_format_version": "1", "spire_git_rev": "",
            "label": "", "created_at": "",
            "db_filename": "spire.db", "db_sha256": "0" * 64,
            "db_byte_count": 0, "db_encrypted": False,
            "pin_filename": None, "pin_sha256": None,
            "pin_byte_count": 0, "schema_versions": {},
            "audit_entry_count": 0, "audit_head_hash": None,
            "audit_chain_ok_at_backup": False,
            "audit_signing_enabled": False,
            "audit_head_signature": None,
            "manifest_self_hash": "",
        }
        m_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        info_m = tarfile.TarInfo("manifest.json")
        info_m.size = len(m_bytes)
        tar.addfile(info_m, io.BytesIO(m_bytes))
        # Now an evil member trying to escape
        info_evil = tarfile.TarInfo("../escape.txt")
        info_evil.size = 4
        tar.addfile(info_evil, io.BytesIO(b"oops"))

    from backend.uis.dr import verify_backup
    result = verify_backup(bad)
    assert result.ok is False
    # Either the safe-extract guard rejects it, or some downstream
    # check fails first; the key invariant is we never wrote
    # outside the temp dir.
    assert result.issues
    assert not (tmp_path / "escape.txt").exists()


# ---------------------------------------------------------------------------
# Schema-version preservation
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Encryption — backup + verify + restore round-trip when SPIRE_DB_PASSPHRASE set
# ---------------------------------------------------------------------------


@pytest.fixture
def encrypted_runtime(monkeypatch, tmp_path):
    """Like ``isolated_runtime`` but with SPIRE_DB_PASSPHRASE set
    so the DR module's encryption path is exercised.

    Uses the live persistence._unlock_db / _lock_db cycle: each
    call to ``conn()`` decrypts spire.db.enc to spire.db, runs
    the work, then re-encrypts. Backups taken in this state must
    archive an encrypted snapshot to match at-rest privacy."""
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    db_file = runtime / "spire.db"
    enc_file = runtime / "spire.db.enc"

    monkeypatch.setenv("SPIRE_RUNTIME_DIR", str(runtime))
    monkeypatch.setenv("SPIRE_DB_PASSPHRASE", "dr-test-passphrase")

    from backend import persistence
    monkeypatch.setattr(persistence, "DATA_DIR", runtime)
    monkeypatch.setattr(persistence, "DB_PATH", db_file)
    monkeypatch.setattr(persistence, "DB_ENCRYPTED_PATH", enc_file)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", "dr-test-passphrase")

    from backend.uis import audit_integrity
    monkeypatch.setattr(audit_integrity, "_PRIVATE_KEY", None)
    monkeypatch.setattr(audit_integrity, "_PUBLIC_KEY", None)
    monkeypatch.setattr(audit_integrity, "_KEY_LOADED", False)

    persistence.init_db()
    return runtime


def test_encrypted_backup_archive_contains_enc_member(encrypted_runtime, tmp_path):
    _seed_audit_entries(2)
    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup
    manifest = create_backup(out, label="encrypted")

    assert manifest.db_encrypted is True
    assert manifest.db_filename == "spire.db.enc"
    with tarfile.open(out, "r:gz") as tar:
        names = sorted(m.name for m in tar.getmembers())
    assert names == ["manifest.json", "spire.db.enc"]
    # Even though the archive carries encrypted bytes, the
    # plaintext snapshot's audit chain was walked at backup time
    # so the manifest reports the head-hash + entry-count.
    assert manifest.audit_entry_count == 2
    assert manifest.audit_chain_ok_at_backup is True
    assert manifest.audit_head_hash


def test_encrypted_backup_verify_walks_chain_with_passphrase(encrypted_runtime, tmp_path):
    _seed_audit_entries(3)
    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup, verify_backup
    create_backup(out)

    # Verify with passphrase available — should walk chain
    result = verify_backup(out)
    assert result.ok is True, result.issues


def test_encrypted_backup_verify_without_passphrase_only_checks_hashes(
    encrypted_runtime, tmp_path, monkeypatch
):
    """Verifying an encrypted archive on a host without
    SPIRE_DB_PASSPHRASE still passes — byte-hash + manifest
    self-hash are meaningful integrity signals; chain walk just
    can't run."""
    _seed_audit_entries(1)
    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup, verify_backup
    create_backup(out)

    monkeypatch.delenv("SPIRE_DB_PASSPHRASE", raising=False)
    result = verify_backup(out)
    assert result.ok is True, result.issues


def test_encrypted_backup_verify_wrong_passphrase_fails(
    encrypted_runtime, tmp_path, monkeypatch
):
    _seed_audit_entries(1)
    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup, verify_backup
    create_backup(out)

    monkeypatch.setenv("SPIRE_DB_PASSPHRASE", "wrong-passphrase")
    result = verify_backup(out)
    assert result.ok is False
    assert any("decrypt failed" in i for i in result.issues)


def test_encrypted_round_trip_preserves_audit_chain(encrypted_runtime, tmp_path):
    _seed_audit_entries(3)
    archive = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup, restore_backup
    from backend.persistence import verify_chain

    pre_chain = verify_chain()
    pre_head = pre_chain["head_hash"]
    create_backup(archive)

    _seed_audit_entries(5)  # mutate live state past the snapshot
    result = restore_backup(archive, capture_prior_state=False)
    assert result.ok, result.issues

    post = verify_chain()
    assert post["ok"]
    assert post["head_hash"] == pre_head


# ---------------------------------------------------------------------------
# Retention pruning
# ---------------------------------------------------------------------------


def _make_archive_with_created_at(
    archive_dir: Path, name: str, created_at_iso: str, tmp_path: Path
) -> Path:
    """Synthesize a backup archive with a forced ``created_at``
    in its manifest. Used by the pruning tests so we can pin
    timestamps without sleeping between create_backup calls."""
    from backend.uis.dr import (
        BackupManifest, _canonical_json, _compute_manifest_self_hash,
    )

    archive_path = archive_dir / name
    db_bytes = b"SQLite format 3\x00" + b"\x00" * 100  # not a real DB but unique bytes
    db_sha = hashlib.sha256(db_bytes).hexdigest()

    manifest = BackupManifest(
        created_at=created_at_iso,
        db_filename="spire.db",
        db_sha256=db_sha,
        db_byte_count=len(db_bytes),
    )
    manifest.manifest_self_hash = _compute_manifest_self_hash(manifest)

    archive_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive_path, "w:gz") as tar:
        m_bytes = _canonical_json(manifest.to_dict())
        m_info = tarfile.TarInfo("manifest.json")
        m_info.size = len(m_bytes)
        tar.addfile(m_info, io.BytesIO(m_bytes))
        d_info = tarfile.TarInfo("spire.db")
        d_info.size = len(db_bytes)
        tar.addfile(d_info, io.BytesIO(db_bytes))
    return archive_path


def test_prune_keep_count_drops_oldest(tmp_path):
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    _make_archive_with_created_at(archive_dir, "a.tar.gz", "2026-01-01T00:00:00+00:00", tmp_path)
    _make_archive_with_created_at(archive_dir, "b.tar.gz", "2026-02-01T00:00:00+00:00", tmp_path)
    _make_archive_with_created_at(archive_dir, "c.tar.gz", "2026-03-01T00:00:00+00:00", tmp_path)

    from backend.uis.dr import prune_backups
    result = prune_backups(archive_dir, keep_count=2)

    kept_names = sorted(p.name for p in result.kept)
    pruned_names = sorted(p.name for p in result.pruned)
    assert kept_names == ["b.tar.gz", "c.tar.gz"]
    assert pruned_names == ["a.tar.gz"]
    assert not (archive_dir / "a.tar.gz").exists()
    assert (archive_dir / "b.tar.gz").exists()
    assert (archive_dir / "c.tar.gz").exists()


def test_prune_keep_days_drops_too_old(tmp_path):
    """Anything older than keep_days from now is pruned. We
    construct one archive 90 days old and one 1 day old; keep
    only the recent."""
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    old_iso = (now - timedelta(days=90)).isoformat(timespec="seconds")
    new_iso = (now - timedelta(days=1)).isoformat(timespec="seconds")
    _make_archive_with_created_at(archive_dir, "old.tar.gz", old_iso, tmp_path)
    _make_archive_with_created_at(archive_dir, "new.tar.gz", new_iso, tmp_path)

    from backend.uis.dr import prune_backups
    result = prune_backups(archive_dir, keep_days=7)
    assert [p.name for p in result.pruned] == ["old.tar.gz"]
    assert [p.name for p in result.kept] == ["new.tar.gz"]


def test_prune_dry_run_deletes_nothing(tmp_path):
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    _make_archive_with_created_at(archive_dir, "a.tar.gz", "2026-01-01T00:00:00+00:00", tmp_path)
    _make_archive_with_created_at(archive_dir, "b.tar.gz", "2026-02-01T00:00:00+00:00", tmp_path)

    from backend.uis.dr import prune_backups
    result = prune_backups(archive_dir, keep_count=1, dry_run=True)
    assert result.dry_run is True
    assert len(result.pruned) == 1
    assert len(result.kept) == 1
    # Both archives still on disk — dry run.
    assert (archive_dir / "a.tar.gz").exists()
    assert (archive_dir / "b.tar.gz").exists()


def test_prune_keeps_unreadable_archives_safely(tmp_path):
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    _make_archive_with_created_at(archive_dir, "good.tar.gz", "2026-01-01T00:00:00+00:00", tmp_path)
    bogus = archive_dir / "garbage.tar.gz"
    bogus.write_text("not a tar archive", encoding="utf-8")

    from backend.uis.dr import prune_backups
    result = prune_backups(archive_dir, keep_count=0)
    # The corrupt archive shows up in skipped_unreadable; the good
    # one is pruned (because keep_count=0). The corrupt one is
    # NEVER auto-deleted — operator must triage manually.
    assert bogus.exists()
    assert any(p.name == "garbage.tar.gz" for p in result.skipped_unreadable)
    assert any(p.name == "good.tar.gz" for p in result.pruned)


def test_prune_validates_inputs(tmp_path):
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    from backend.uis.dr import prune_backups
    with pytest.raises(ValueError):
        prune_backups(archive_dir)  # neither policy
    with pytest.raises(ValueError):
        prune_backups(archive_dir, keep_count=-1)
    with pytest.raises(ValueError):
        prune_backups(archive_dir, keep_days=-1)


def test_prune_keep_count_and_keep_days_union(tmp_path):
    """When both are set, an archive survives if EITHER policy
    keeps it. Verifies the union semantic."""
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    from datetime import timedelta
    now = datetime.now(timezone.utc)
    very_old = (now - timedelta(days=365)).isoformat(timespec="seconds")
    recent = (now - timedelta(days=1)).isoformat(timespec="seconds")
    _make_archive_with_created_at(archive_dir, "very_old.tar.gz", very_old, tmp_path)
    _make_archive_with_created_at(archive_dir, "recent.tar.gz", recent, tmp_path)

    from backend.uis.dr import prune_backups
    # keep_count=1 alone would drop very_old; keep_days=400 keeps it
    result = prune_backups(archive_dir, keep_count=1, keep_days=400)
    assert sorted(p.name for p in result.kept) == ["recent.tar.gz", "very_old.tar.gz"]
    assert result.pruned == []


# ---------------------------------------------------------------------------
# Schema preservation
# ---------------------------------------------------------------------------


def test_backup_records_schema_versions(isolated_runtime, tmp_path):
    """Stamp a fake migration row, take a backup, confirm the
    manifest reports the version."""
    from backend.persistence import conn
    from backend.uis.migrations import MIGRATION_TRACKING_SCHEMA
    with conn() as c:
        c.execute(MIGRATION_TRACKING_SCHEMA)
        c.execute(
            "INSERT INTO uis_schema_migrations (table_name, version, applied_at) "
            "VALUES (?, ?, ?)",
            ("uis_channels", 7, "2026-05-05T00:00:00"),
        )

    out = tmp_path / "snap.tar.gz"
    from backend.uis.dr import create_backup
    manifest = create_backup(out)
    assert "uis_channels" in manifest.schema_versions
    assert 7 in manifest.schema_versions["uis_channels"]
