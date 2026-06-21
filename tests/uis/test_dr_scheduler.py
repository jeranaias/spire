"""Scheduled-backup tests for UIS-P6.6+."""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest


@pytest.fixture
def isolated_runtime(monkeypatch, tmp_path):
    """Same fixture shape as test_dr.py — fresh runtime + DB,
    pointed at by SPIRE_RUNTIME_DIR. The scheduler reads the
    same env knobs the DR module does."""
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

    from backend.uis import audit_integrity
    monkeypatch.setattr(audit_integrity, "_PRIVATE_KEY", None)
    monkeypatch.setattr(audit_integrity, "_PUBLIC_KEY", None)
    monkeypatch.setattr(audit_integrity, "_KEY_LOADED", False)

    persistence.init_db()
    return runtime


# ---------------------------------------------------------------------------
# Config parsing
# ---------------------------------------------------------------------------


def test_interval_seconds_unset_returns_none(monkeypatch):
    monkeypatch.delenv("SPIRE_BACKUP_SCHEDULE_HOURS", raising=False)
    from backend.uis.dr_scheduler import _interval_seconds
    assert _interval_seconds() is None


def test_interval_seconds_zero_returns_none(monkeypatch):
    monkeypatch.setenv("SPIRE_BACKUP_SCHEDULE_HOURS", "0")
    from backend.uis.dr_scheduler import _interval_seconds
    assert _interval_seconds() is None


def test_interval_seconds_negative_returns_none(monkeypatch):
    monkeypatch.setenv("SPIRE_BACKUP_SCHEDULE_HOURS", "-1")
    from backend.uis.dr_scheduler import _interval_seconds
    assert _interval_seconds() is None


def test_interval_seconds_garbage_returns_none(monkeypatch):
    monkeypatch.setenv("SPIRE_BACKUP_SCHEDULE_HOURS", "not-a-number")
    from backend.uis.dr_scheduler import _interval_seconds
    assert _interval_seconds() is None


def test_interval_seconds_float(monkeypatch):
    monkeypatch.setenv("SPIRE_BACKUP_SCHEDULE_HOURS", "0.5")
    from backend.uis.dr_scheduler import _interval_seconds
    assert _interval_seconds() == 1800.0


def test_retention_args_default_to_none(monkeypatch):
    monkeypatch.delenv("SPIRE_BACKUP_KEEP_COUNT", raising=False)
    monkeypatch.delenv("SPIRE_BACKUP_KEEP_DAYS", raising=False)
    from backend.uis.dr_scheduler import _retention_args
    assert _retention_args() == (None, None)


def test_retention_args_parses(monkeypatch):
    monkeypatch.setenv("SPIRE_BACKUP_KEEP_COUNT", "10")
    monkeypatch.setenv("SPIRE_BACKUP_KEEP_DAYS", "30")
    from backend.uis.dr_scheduler import _retention_args
    assert _retention_args() == (10, 30)


def test_retention_args_garbage_falls_back_to_none(monkeypatch):
    monkeypatch.setenv("SPIRE_BACKUP_KEEP_COUNT", "not-a-number")
    monkeypatch.setenv("SPIRE_BACKUP_KEEP_DAYS", "")
    from backend.uis.dr_scheduler import _retention_args
    assert _retention_args() == (None, None)


def test_label_prefix_default(monkeypatch):
    monkeypatch.delenv("SPIRE_BACKUP_LABEL_PREFIX", raising=False)
    from backend.uis.dr_scheduler import _label_prefix
    assert _label_prefix() == "scheduled"


def test_label_prefix_override(monkeypatch):
    monkeypatch.setenv("SPIRE_BACKUP_LABEL_PREFIX", "pilot-rehearsal")
    from backend.uis.dr_scheduler import _label_prefix
    assert _label_prefix() == "pilot-rehearsal"


# ---------------------------------------------------------------------------
# One-shot tick — happy path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_one_tick_happy_path(isolated_runtime, tmp_path, monkeypatch):
    backup_dir = tmp_path / "backups"
    monkeypatch.setenv("SPIRE_BACKUP_DIR", str(backup_dir))

    from backend.uis.dr_scheduler import run_one_tick
    summary = await run_one_tick()

    assert summary["ok"] is True
    assert summary["error"] is None
    archive_path = Path(summary["archive_path"])
    assert archive_path.exists()
    assert archive_path.parent == backup_dir
    assert archive_path.name.startswith("backup_")
    assert archive_path.suffix == ".gz"


@pytest.mark.asyncio
async def test_run_one_tick_audit_logs_success(isolated_runtime, tmp_path, monkeypatch):
    backup_dir = tmp_path / "backups"
    monkeypatch.setenv("SPIRE_BACKUP_DIR", str(backup_dir))

    from backend.persistence import recent_entries
    from backend.uis.dr_scheduler import run_one_tick

    await run_one_tick()
    kinds = {r["kind"] for r in recent_entries(limit=10)}
    assert "system.dr.scheduled_backup.created" in kinds


@pytest.mark.asyncio
async def test_run_one_tick_with_pruning(isolated_runtime, tmp_path, monkeypatch):
    """Configure keep_count=1 and run two ticks. The first
    archive should get pruned by the second tick."""
    backup_dir = tmp_path / "backups"
    monkeypatch.setenv("SPIRE_BACKUP_DIR", str(backup_dir))
    monkeypatch.setenv("SPIRE_BACKUP_KEEP_COUNT", "1")

    from backend.uis.dr_scheduler import run_one_tick

    summary_a = await run_one_tick()
    assert summary_a["ok"]
    # Tiny sleep so the timestamps differ — the manifest's
    # ``created_at`` is whole-second resolution. Without a sleep
    # the two archives would tie on creation time and the
    # ordering would be deterministic by filename only, which
    # is fine but less semantically meaningful.
    await asyncio.sleep(1.1)
    summary_b = await run_one_tick()
    assert summary_b["ok"]
    # After the second tick, only one archive should remain on
    # disk (keep_count=1). Pruning happens INSIDE the second
    # tick so by the time it returns the older archive is gone.
    archives = sorted(backup_dir.glob("*.tar.gz"))
    assert len(archives) == 1
    assert summary_b["pruned_count"] == 1
    assert summary_b["kept_count"] == 1


@pytest.mark.asyncio
async def test_run_one_tick_does_not_prune_when_disabled(isolated_runtime, tmp_path, monkeypatch):
    backup_dir = tmp_path / "backups"
    monkeypatch.setenv("SPIRE_BACKUP_DIR", str(backup_dir))
    monkeypatch.delenv("SPIRE_BACKUP_KEEP_COUNT", raising=False)
    monkeypatch.delenv("SPIRE_BACKUP_KEEP_DAYS", raising=False)

    from backend.uis.dr_scheduler import run_one_tick

    await run_one_tick()
    await asyncio.sleep(1.1)
    summary = await run_one_tick()
    archives = sorted(backup_dir.glob("*.tar.gz"))
    assert len(archives) == 2
    assert summary["pruned_count"] == 0


# ---------------------------------------------------------------------------
# One-shot tick — failure path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_one_tick_handles_backup_failure(isolated_runtime, tmp_path, monkeypatch):
    """Substitute create_backup with one that always raises;
    verify the tick returns a failure summary, doesn't propagate
    the exception, and writes a `failed` audit entry."""
    backup_dir = tmp_path / "backups"
    monkeypatch.setenv("SPIRE_BACKUP_DIR", str(backup_dir))

    from backend.uis import dr as dr_module

    def _broken_create(*a, **kw):
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(dr_module, "create_backup", _broken_create)

    from backend.persistence import recent_entries
    from backend.uis.dr_scheduler import run_one_tick

    summary = await run_one_tick()
    assert summary["ok"] is False
    assert "simulated failure" in (summary["error"] or "")

    # Audit-log records the attempt
    kinds = {r["kind"] for r in recent_entries(limit=10)}
    assert "system.dr.scheduled_backup.failed" in kinds


# ---------------------------------------------------------------------------
# Lifecycle (start / stop)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_scheduler_returns_none_when_disabled(monkeypatch):
    monkeypatch.delenv("SPIRE_BACKUP_SCHEDULE_HOURS", raising=False)
    from backend.uis import dr_scheduler
    # Reset module-level state so this test isn't polluted by
    # an earlier in-process start
    monkeypatch.setattr(dr_scheduler, "_SCHEDULER_TASK", None)

    task = dr_scheduler.start_scheduler()
    assert task is None
    await dr_scheduler.stop_scheduler()  # should be a no-op


@pytest.mark.asyncio
async def test_start_scheduler_launches_task_then_stops_clean(monkeypatch):
    # 1 hour = 3600s. The loop sleeps the full interval before
    # the first tick, so even though we start the scheduler we
    # never actually take a backup in this test — just verify
    # the task exists and shuts down cleanly.
    monkeypatch.setenv("SPIRE_BACKUP_SCHEDULE_HOURS", "1")
    from backend.uis import dr_scheduler
    monkeypatch.setattr(dr_scheduler, "_SCHEDULER_TASK", None)

    task = dr_scheduler.start_scheduler()
    assert task is not None
    assert not task.done()

    await dr_scheduler.stop_scheduler()
    assert task.done()
    # stop_scheduler() must clear the module-level reference so
    # a subsequent start gets a fresh task.
    assert dr_scheduler._SCHEDULER_TASK is None


@pytest.mark.asyncio
async def test_start_scheduler_idempotent(monkeypatch):
    monkeypatch.setenv("SPIRE_BACKUP_SCHEDULE_HOURS", "1")
    from backend.uis import dr_scheduler
    monkeypatch.setattr(dr_scheduler, "_SCHEDULER_TASK", None)
    try:
        task_a = dr_scheduler.start_scheduler()
        task_b = dr_scheduler.start_scheduler()
        assert task_a is task_b  # same task, not a duplicate
    finally:
        await dr_scheduler.stop_scheduler()
