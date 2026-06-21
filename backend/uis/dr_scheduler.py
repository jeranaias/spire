"""Scheduled-backup loop for UIS-P6.6.

Closes the DR story for operators who want a hands-off snapshot
cadence without standing up cron / Task Scheduler. The scheduler
is **opt-in** — it sleeps forever unless ``SPIRE_BACKUP_SCHEDULE_HOURS``
is set in the environment.

Configuration
-------------

``SPIRE_BACKUP_SCHEDULE_HOURS``
    Interval between backups, in hours. Float-valued — set to
    ``0.5`` for every 30 minutes during a pilot if you want to
    rehearse restore quickly. Unset (or empty / 0) disables the
    scheduler entirely.

``SPIRE_BACKUP_DIR``
    Where archives go. Defaults to ``runtime/backups/``. Same
    location the manual ``/api/system/dr/backup`` route writes
    to, so a subsequent ``/api/system/dr/backups`` listing shows
    both manual and scheduled archives.

``SPIRE_BACKUP_KEEP_COUNT`` / ``SPIRE_BACKUP_KEEP_DAYS``
    Retention policy applied after every successful backup.
    Either, both, or neither — when neither is set the scheduler
    only creates archives, never prunes. Same union semantics as
    :func:`backend.uis.dr.prune_backups`.

``SPIRE_BACKUP_LABEL_PREFIX``
    Defaults to ``"scheduled"``. The full label of each archive
    is ``"<prefix> @ <ISO timestamp>"`` so an operator scrolling
    the inventory can tell scheduled archives from manual ones.

Failure handling
----------------

Backup failures don't crash the loop. Each attempt is wrapped:
on success the scheduler logs the manifest summary and writes
an audit-log entry; on failure it logs the exception and writes
a separate ``system.dr.scheduled_backup.failed`` audit entry so
an inspector can see the attempt happened and why it didn't
land. The next interval ticks normally.

Lifecycle
---------

The async task is started from :mod:`backend.main` 's lifespan
context manager via :func:`start_scheduler` and shut down with
:func:`stop_scheduler`. Importing this module is side-effect-
free; it doesn't read env until the scheduler starts.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Optional


log = logging.getLogger(__name__)


_SCHEDULER_TASK: Optional[asyncio.Task] = None


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


def _backup_dir() -> Path:
    raw = os.environ.get("SPIRE_BACKUP_DIR", "").strip()
    if raw:
        return Path(raw)
    return Path(__file__).resolve().parent.parent.parent / "runtime" / "backups"


def _interval_seconds() -> Optional[float]:
    """Resolve the polling interval from env. Returns None when
    the scheduler should stay dormant.

    Floats are accepted so pilot rehearsals can run sub-hourly
    without code changes; values <= 0 also disable the scheduler.
    """
    raw = (os.environ.get("SPIRE_BACKUP_SCHEDULE_HOURS") or "").strip()
    if not raw:
        return None
    try:
        hours = float(raw)
    except ValueError:
        log.warning(
            "SPIRE_BACKUP_SCHEDULE_HOURS=%r is not a number; "
            "scheduler disabled.", raw,
        )
        return None
    if hours <= 0:
        return None
    return hours * 3600.0


def _retention_args() -> tuple[Optional[int], Optional[int]]:
    """(keep_count, keep_days) — returns the values that will
    be passed to :func:`prune_backups`. Empty / invalid values
    silently fall back to None (= policy disabled)."""
    def _safe_int(name: str) -> Optional[int]:
        raw = (os.environ.get(name) or "").strip()
        if not raw:
            return None
        try:
            v = int(raw)
        except ValueError:
            log.warning("%s=%r not an integer; ignoring.", name, raw)
            return None
        return v if v >= 0 else None
    return _safe_int("SPIRE_BACKUP_KEEP_COUNT"), _safe_int("SPIRE_BACKUP_KEEP_DAYS")


def _label_prefix() -> str:
    raw = (os.environ.get("SPIRE_BACKUP_LABEL_PREFIX") or "").strip()
    return raw or "scheduled"


# ---------------------------------------------------------------------------
# One-shot tick (the unit-tested entry point)
# ---------------------------------------------------------------------------


async def run_one_tick() -> dict:
    """Execute exactly one backup + prune cycle.

    Returns a summary dict useful for logging and tests. Never
    raises — failures are caught, logged, and reflected in the
    summary so the scheduler loop can keep ticking after a
    transient issue (full disk, DB locked, etc.).
    """
    summary: dict = {
        "ok": False,
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "archive_path": None,
        "audit_entry_count": None,
        "pruned_count": 0,
        "kept_count": 0,
        "error": None,
    }

    backup_dir = _backup_dir()
    backup_dir.mkdir(parents=True, exist_ok=True)
    label_prefix = _label_prefix()
    keep_count, keep_days = _retention_args()

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = backup_dir / f"backup_{ts}_{uuid.uuid4().hex[:8]}.tar.gz"
    label = f"{label_prefix} @ {summary['ts']}"

    # The DR module is sync. Run it in the thread pool so a
    # hot snapshot doesn't block the event loop. SQLite Online
    # Backup API is C-bound; it releases the GIL during the
    # copy so other handlers continue to serve.
    from .dr import create_backup, prune_backups

    loop = asyncio.get_running_loop()
    try:
        manifest = await loop.run_in_executor(
            None, lambda: create_backup(out_path, label=label),
        )
        summary["archive_path"] = str(out_path)
        summary["audit_entry_count"] = manifest.audit_entry_count
        summary["ok"] = True
    except Exception as e:  # noqa: BLE001
        summary["error"] = f"backup: {e}"
        log.exception("scheduled backup failed")
        # Best-effort audit log — if the live DB is unwritable
        # the audit-log call itself may fail; swallow that.
        try:
            from ..persistence import log as audit_log
            audit_log(
                "system.dr.scheduled_backup.failed",
                actor="scheduler", subject_id=str(out_path.name),
                payload={"error": str(e)[:300]},
            )
        except Exception:  # noqa: BLE001
            pass
        return summary

    # Audit-log the success once we know we have a manifest. The
    # entry lands in the just-snapshotted chain's *successor* — i.e.
    # it's not in the archive we just wrote, only in the live chain.
    try:
        from ..persistence import log as audit_log
        audit_log(
            "system.dr.scheduled_backup.created",
            actor="scheduler", subject_id=str(out_path.name),
            payload={
                "archive_path": str(out_path),
                "label": label,
                "audit_entry_count": manifest.audit_entry_count,
                "audit_head_hash": manifest.audit_head_hash,
                "db_sha256": manifest.db_sha256,
            },
        )
    except Exception:  # noqa: BLE001
        log.warning("scheduler: audit_log write failed (backup itself succeeded)")

    # Retention. Best-effort: pruning errors don't fail the tick.
    if keep_count is not None or keep_days is not None:
        try:
            result = await loop.run_in_executor(
                None,
                lambda: prune_backups(
                    backup_dir,
                    keep_count=keep_count,
                    keep_days=keep_days,
                ),
            )
            summary["pruned_count"] = len(result.pruned)
            summary["kept_count"] = len(result.kept)
            if result.pruned:
                try:
                    from ..persistence import log as audit_log
                    audit_log(
                        "system.dr.scheduled_prune",
                        actor="scheduler", subject_id=str(backup_dir.name),
                        payload={
                            "directory": str(backup_dir),
                            "keep_count": keep_count,
                            "keep_days": keep_days,
                            "pruned_count": len(result.pruned),
                            "kept_count": len(result.kept),
                        },
                    )
                except Exception:  # noqa: BLE001
                    pass
        except Exception as e:  # noqa: BLE001
            summary["error"] = f"prune: {e}"
            log.exception("scheduled prune failed")

    return summary


# ---------------------------------------------------------------------------
# Long-running loop
# ---------------------------------------------------------------------------


async def _scheduler_loop(interval_seconds: float) -> None:
    """Loop forever, sleeping ``interval_seconds`` between ticks.

    Ticks happen on the schedule, not on startup — operators
    don't want a mass reboot to trigger a backup storm.
    """
    log.info(
        "DR scheduler armed: interval=%s hours, dir=%s",
        interval_seconds / 3600.0, _backup_dir(),
    )
    while True:
        try:
            await asyncio.sleep(interval_seconds)
        except asyncio.CancelledError:
            raise
        try:
            summary = await run_one_tick()
            if summary.get("ok"):
                log.info(
                    "DR scheduler: backup ok, archive=%s entries=%s "
                    "pruned=%s kept=%s",
                    summary.get("archive_path"),
                    summary.get("audit_entry_count"),
                    summary.get("pruned_count"),
                    summary.get("kept_count"),
                )
            else:
                log.warning(
                    "DR scheduler: backup failed: %s",
                    summary.get("error"),
                )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            # run_one_tick is supposed to never raise. If it
            # does, log and keep ticking — better degraded than
            # silent.
            log.exception("DR scheduler tick crashed")


def start_scheduler() -> Optional[asyncio.Task]:
    """Launch the scheduler if the environment configures one.

    Idempotent: a second call while a task is already running is
    a no-op. Returns the task (or the previously-launched task)
    so callers can store and cancel it on shutdown.
    """
    global _SCHEDULER_TASK
    if _SCHEDULER_TASK is not None and not _SCHEDULER_TASK.done():
        return _SCHEDULER_TASK
    interval = _interval_seconds()
    if interval is None:
        log.info("DR scheduler dormant: SPIRE_BACKUP_SCHEDULE_HOURS unset.")
        return None
    _SCHEDULER_TASK = asyncio.create_task(
        _scheduler_loop(interval), name="spire-dr-scheduler",
    )
    return _SCHEDULER_TASK


async def stop_scheduler() -> None:
    """Cancel the scheduler task and await its shutdown.

    Safe to call when no scheduler was ever started — in that
    case it's a no-op."""
    global _SCHEDULER_TASK
    task = _SCHEDULER_TASK
    if task is None:
        return
    _SCHEDULER_TASK = None
    if task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:  # noqa: BLE001
        log.exception("DR scheduler shutdown raised")
