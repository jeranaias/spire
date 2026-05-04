"""Records retention + spillage cleanup tests (UIS-P6.8)."""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List

import pytest

from backend.uis.retention import (
    DEFAULT_POLICIES,
    RetentionPolicy,
    RetentionResult,
    cleanup_spillage,
    load_policies,
    set_audit_func,
    sweep_filesystem_channel,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def audit_capture():
    captured: List[dict] = []
    set_audit_func(lambda **kw: captured.append(dict(kw)))
    yield captured
    set_audit_func(lambda **kw: None)


@pytest.fixture
def fs_channel_root(tmp_path):
    """Build a synthetic filesystem-channel root with processed/
    + quarantine/ + a couple of dated subdirs."""
    root = tmp_path / "channel-root"
    (root / "incoming").mkdir(parents=True)
    (root / "processed").mkdir(parents=True)
    (root / "quarantine").mkdir(parents=True)
    return root


def _backdate(path: Path, days: int) -> None:
    """Set mtime/atime on a file or dir to N days ago (UTC)."""
    when = (datetime.now(timezone.utc) - timedelta(days=days)).timestamp()
    os.utime(path, (when, when))


# ---------------------------------------------------------------------------
# Policy loading
# ---------------------------------------------------------------------------


def test_default_policies_present():
    pols = load_policies()
    assert "filesystem.processed" in pols
    assert "filesystem.quarantine" in pols
    assert pols["filesystem.processed"].ttl_days == 90
    assert pols["filesystem.quarantine"].ttl_days == 30


def test_overrides_apply(monkeypatch):
    monkeypatch.setenv(
        "SPIRE_RETENTION_OVERRIDES",
        '{"filesystem.quarantine": 7, "custom.class": 60}',
    )
    pols = load_policies()
    assert pols["filesystem.quarantine"].ttl_days == 7
    assert pols["custom.class"].ttl_days == 60


def test_overrides_malformed_falls_back_to_defaults(monkeypatch):
    monkeypatch.setenv("SPIRE_RETENTION_OVERRIDES", "not json")
    pols = load_policies()
    assert pols["filesystem.processed"].ttl_days == 90  # default unchanged


# ---------------------------------------------------------------------------
# Quarantine sweep
# ---------------------------------------------------------------------------


def test_quarantine_files_past_ttl_deleted_with_audit(fs_channel_root, audit_capture):
    qdir = fs_channel_root / "quarantine"
    # Old file (45 days) — past 30-day TTL
    old = qdir / "bad.csv"
    old.write_bytes(b"corrupt data")
    sidecar = qdir / "bad.csv.reason.txt"
    sidecar.write_text("dup_header", encoding="utf-8")
    _backdate(old, 45)
    _backdate(sidecar, 45)

    # Fresh file (5 days) — within TTL
    fresh = qdir / "fresh.csv"
    fresh.write_bytes(b"recent")
    _backdate(fresh, 5)

    # Override min_keep_count=0 so the single past-TTL file is
    # actually eligible (default of 5 would protect it)
    pols = dict(DEFAULT_POLICIES)
    pols["filesystem.quarantine"] = RetentionPolicy(
        class_name="filesystem.quarantine", ttl_days=30, min_keep_count=0,
    )
    result = sweep_filesystem_channel(
        channel_id="t/x",
        root=str(fs_channel_root),
        policies=pols,
    )
    deleted_names = [d["filename"] for d in result.deleted]
    assert "bad.csv" in deleted_names
    assert "bad.csv.reason.txt" in deleted_names
    assert "fresh.csv" not in deleted_names
    assert not old.exists()
    assert not sidecar.exists()
    assert fresh.exists()

    # Audit emitted with sha256 + reason
    deletes = [a for a in audit_capture if a["kind"] == "retention.delete"]
    assert deletes
    bad_event = next(d for d in deletes if d["payload"]["filename"] == "bad.csv")
    assert bad_event["payload"]["sha256"]
    assert bad_event["payload"]["reason"] == "expired"


def test_min_keep_count_floor_skips_recent_files_past_ttl(fs_channel_root, audit_capture):
    """All 6 files past 30-day TTL but min_keep_count=5 →
    only 1 actually deleted (the oldest)."""
    qdir = fs_channel_root / "quarantine"
    files = []
    for i in range(6):
        f = qdir / f"file_{i}.csv"
        f.write_bytes(f"data {i}".encode())
        # Backdate by 31 + i days so all are past TTL but ordered
        _backdate(f, 31 + i)
        files.append(f)

    result = sweep_filesystem_channel(
        channel_id="t/keep",
        root=str(fs_channel_root),
    )
    # min_keep_count=5 (default for filesystem.quarantine) — keep 5 newest
    assert len(result.deleted) == 1
    assert len(result.skipped) == 5
    # The oldest (file_5 — backdated 36 days) is the one deleted
    deleted_names = {d["filename"] for d in result.deleted}
    assert "file_5.csv" in deleted_names


def test_dry_run_does_not_delete_anything(fs_channel_root, audit_capture):
    qdir = fs_channel_root / "quarantine"
    for i in range(7):
        f = qdir / f"old_{i}.csv"
        f.write_bytes(b"x")
        _backdate(f, 60)

    result = sweep_filesystem_channel(
        channel_id="t/dry", root=str(fs_channel_root), dry_run=True,
    )
    # All identified for deletion (past TTL, past min_keep_count)
    # but nothing actually unlinked
    assert len(result.deleted) >= 1
    for f in qdir.iterdir():
        assert f.exists()
    # No audit emissions on dry run
    deletes = [a for a in audit_capture if a["kind"] == "retention.delete"]
    assert deletes == []


# ---------------------------------------------------------------------------
# Processed dated-subdir sweep
# ---------------------------------------------------------------------------


def test_processed_dated_subdirs_swept(fs_channel_root, audit_capture):
    pdir = fs_channel_root / "processed"
    # Old date — past 90-day TTL
    old_date = (datetime.now(timezone.utc) - timedelta(days=120)).strftime("%Y-%m-%d")
    old_sub = pdir / old_date
    old_sub.mkdir()
    (old_sub / "ecp_old.csv").write_bytes(b"old")
    _backdate(old_sub / "ecp_old.csv", 120)
    _backdate(old_sub, 120)

    # Recent
    recent_date = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")
    recent_sub = pdir / recent_date
    recent_sub.mkdir()
    (recent_sub / "ecp_recent.csv").write_bytes(b"recent")
    _backdate(recent_sub / "ecp_recent.csv", 30)

    # Override min_keep_count to 0 so the old subdir is actually
    # eligible for deletion (default is 10 which would protect
    # a tiny fixture)
    pols = dict(DEFAULT_POLICIES)
    pols["filesystem.processed"] = RetentionPolicy(
        class_name="filesystem.processed", ttl_days=90, min_keep_count=0,
    )
    result = sweep_filesystem_channel(
        channel_id="t/dated", root=str(fs_channel_root), policies=pols,
    )
    assert not old_sub.exists()
    assert recent_sub.exists()
    deleted_names = [d["filename"] for d in result.deleted]
    assert any("ecp_old.csv" in n for n in deleted_names)


def test_processed_min_keep_count_protects_quiet_channel(fs_channel_root):
    """When a channel only has 3 dated subdirs, all past TTL,
    min_keep_count=10 protects all of them."""
    pdir = fs_channel_root / "processed"
    for i in range(3):
        d = (datetime.now(timezone.utc) - timedelta(days=120 + i)).strftime("%Y-%m-%d")
        sub = pdir / d
        sub.mkdir()
        (sub / "x.csv").write_bytes(b"x")
        _backdate(sub, 120 + i)

    result = sweep_filesystem_channel(
        channel_id="t/quiet", root=str(fs_channel_root),
    )
    # All within min_keep_count=10 → skipped
    assert len(result.deleted) == 0
    assert len(result.skipped) == 3


# ---------------------------------------------------------------------------
# Spillage cleanup
# ---------------------------------------------------------------------------


def test_spillage_cleanup_deletes_and_audits(tmp_path, audit_capture):
    f1 = tmp_path / "leaked.csv"
    f1.write_bytes(b"this should not be here")
    f2 = tmp_path / "also_leaked.json"
    f2.write_bytes(b'{"x": 1}')

    report = cleanup_spillage(
        paths=[str(f1), str(f2)],
        requested_by="security_manager/3456789012",
        reason="confidential_data_landed_at_unclass_tier",
        classification="CONFIDENTIAL",
    )

    assert len(report.deleted_files) == 2
    assert not f1.exists()
    assert not f2.exists()
    # All deletions share the same spillage_id
    spillage_ids = {d["spillage_id"] for d in report.deleted_files}
    assert len(spillage_ids) == 1
    # Audit chain has per-file + summary entries
    file_events = [a for a in audit_capture if a["kind"] == "retention.spillage"]
    summary_events = [a for a in audit_capture if a["kind"] == "retention.spillage.summary"]
    assert len(file_events) == 2
    assert len(summary_events) == 1
    # Summary names the requestor
    assert summary_events[0]["payload"]["requested_by"] == "security_manager/3456789012"


def test_spillage_records_sha256_for_post_delete_verification(tmp_path, audit_capture):
    """The file's sha256 is recorded BEFORE deletion so an
    investigator can later verify which bytes were removed
    without retaining the bytes themselves."""
    f = tmp_path / "x.bin"
    payload = b"specific-payload-bytes"
    f.write_bytes(payload)

    import hashlib
    expected_sha = hashlib.sha256(payload).hexdigest()

    report = cleanup_spillage(
        paths=[str(f)],
        requested_by="u",
        reason="test",
    )
    assert report.deleted_files[0]["sha256"] == expected_sha


def test_spillage_missing_file_records_error(tmp_path, audit_capture):
    report = cleanup_spillage(
        paths=[str(tmp_path / "ghost.csv")],
        requested_by="u",
        reason="x",
    )
    assert report.deleted_files == []
    assert any(e["error"] == "not_found" for e in report.errors)


def test_spillage_directory_path_records_error(tmp_path, audit_capture):
    """Spillage cleanup is per-FILE; a directory path is rejected
    rather than recursively deleted (operator must enumerate)."""
    d = tmp_path / "sub"
    d.mkdir()
    report = cleanup_spillage(
        paths=[str(d)],
        requested_by="u",
        reason="x",
    )
    assert d.exists()  # not deleted
    assert any(e["error"] == "not_a_file" for e in report.errors)


def test_spillage_id_is_unique_per_call(tmp_path, audit_capture):
    f1 = tmp_path / "a"
    f1.write_bytes(b"a")
    f2 = tmp_path / "b"
    f2.write_bytes(b"b")

    r1 = cleanup_spillage(paths=[str(f1)], requested_by="u", reason="x")
    r2 = cleanup_spillage(paths=[str(f2)], requested_by="u", reason="x")
    assert r1.spillage_id != r2.spillage_id
