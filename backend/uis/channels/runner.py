"""Channel poll runner — drives a channel through one cycle.

Glues the IngestChannel protocol to the existing pipeline +
writer protocol. One ``poll_channel(channel)`` call:

  1. Calls ``channel.list_pending()`` to enumerate new files.
  2. For each pending file:
     a. Calls ``channel.fetch(p)`` to get bytes.
     b. Pipes bytes through the ``run_pipeline`` for the
        channel's adapter_id.
     c. If a writer is registered, runs preview + apply.
     d. Calls ``channel.acknowledge(p)`` on success, or
        ``channel.quarantine(p, reason)`` on poison input.
  3. Returns a PollResult summarizing the cycle.

The runner is a pure function (no scheduling, no thread, no
asyncio task). Scheduling is split into ``ChannelScheduler``
(below) which can be started from a FastAPI lifespan or driven
by a manual /api/uis/channels/{id}/poll request.

Audit emission:
  channel.poll       — one per cycle, summary
  channel.fetched    — per file fetched
  channel.applied    — per file successfully applied
  channel.quarantined — per file moved to DLQ
  channel.skipped    — per file skipped (no writer + dry-run-only)
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from .base import IngestChannel, PendingFile
from .resilience import (
    CircuitState,
    IntegrityMismatchError,
    RetryPolicy,
    get_breaker,
    verify_against_declared,
    with_retry,
)


log = logging.getLogger(__name__)


# Hard cap on bytes per fetched file. Enforced after the bytes
# come back from the channel — protects against single-file OOM
# regardless of channel type. The pipeline's row-cap is in
# addition to (not a substitute for) this byte-cap: a 5GB
# single-line JSON has zero rows from a row-counter perspective
# but still OOMs the box. Default 256MB matches the route-level
# upload limit; override via SPIRE_UIS_MAX_FILE_BYTES.
DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024


def _max_file_bytes() -> int:
    raw = (os.environ.get("SPIRE_UIS_MAX_FILE_BYTES") or "").strip()
    if not raw:
        return DEFAULT_MAX_FILE_BYTES
    try:
        n = int(raw)
        return n if n > 0 else DEFAULT_MAX_FILE_BYTES
    except ValueError:
        return DEFAULT_MAX_FILE_BYTES


@dataclass
class FileResult:
    """Outcome of processing one pending file."""

    filename: str
    status: str               # "applied" / "skipped" / "quarantined" / "failed"
    bytes_read: int = 0
    file_sha256: str = ""
    rows_total: int = 0
    rows_kept: int = 0
    error: str = ""
    duration_ms: float = 0.0
    diff_counts: Dict[str, int] = field(default_factory=dict)


@dataclass
class PollResult:
    """Aggregate outcome of one poll cycle."""

    channel_id: str
    started_at: str
    finished_at: str
    duration_ms: float
    pending_count: int
    file_results: List[FileResult] = field(default_factory=list)

    def counts(self) -> Dict[str, int]:
        c = {"applied": 0, "skipped": 0, "quarantined": 0, "failed": 0}
        for fr in self.file_results:
            c[fr.status] = c.get(fr.status, 0) + 1
        return c


# ---------------------------------------------------------------------------
# Audit hook — channels register a writer; the runner emits audit
# entries here. Default is the SPIRE persistence audit_log; tests
# inject a stub.
# ---------------------------------------------------------------------------


AuditFunc = Callable[..., None]
_audit: AuditFunc = lambda **kwargs: None


def set_audit_func(fn: AuditFunc) -> None:
    """Inject an audit-log emitter. Production wires this to
    ``backend.persistence.log``. Tests pass a list-appending stub.
    """
    global _audit
    _audit = fn


def _emit_audit(**kwargs) -> None:
    try:
        _audit(**kwargs)
    except Exception as e:  # noqa: BLE001
        # Audit emission must never crash a poll cycle. Log the
        # failure and keep going — the operator-side health endpoint
        # will surface "audit-log writes failing" through other
        # signals (DB health check).
        log.warning("Audit emit failed inside channel runner: %s", e)


# ---------------------------------------------------------------------------
# Single-cycle poll
# ---------------------------------------------------------------------------


def poll_channel(
    channel: IngestChannel,
    *,
    actor: str = "channel-runner",
    max_files: Optional[int] = None,
    retry_policy: Optional[RetryPolicy] = None,
) -> PollResult:
    """Run one poll cycle on a channel.

    Pure with respect to canonical state — uses the writer protocol
    same as the HTTP /api/uis/upload?apply=1 path. No silent data
    loss: every pending file ends up in exactly one of
    {applied, skipped, quarantined, failed}.

    ``max_files`` caps how many pending files a single cycle
    consumes. None = no limit (drain). Default of None matches
    operational expectations (process the backlog; the next cycle
    handles whatever arrives next).

    ``retry_policy`` (P4.3) wraps transient channel I/O — fetch +
    list_pending — with exponential backoff. Default policy is
    3 attempts with 0.5s base delay, suitable for SFTP/IMAP blips.
    File-level failures (parse errors, writer conflicts) do NOT
    retry — those are deterministic and route straight to DLQ.

    Circuit breaker (P4.3) — when a channel has been failing
    consecutively, the runner short-circuits the cycle to avoid
    hammering an upstream that's already known-bad. Operator
    resets the breaker via /api/uis/channels/{id}/circuit/reset.
    """
    started = _utc_iso()
    t0 = time.perf_counter()
    file_results: List[FileResult] = []
    breaker = get_breaker(channel.channel_id)

    # Circuit breaker: if open + still in cooldown, skip the cycle
    if not breaker.allow():
        finished = _utc_iso()
        _emit_audit(
            kind="channel.poll",
            actor=actor,
            subject_id=channel.channel_id,
            payload={
                "outcome": "circuit_open",
                "started_at": started,
                "finished_at": finished,
                "circuit_snapshot": breaker.snapshot(),
            },
        )
        return PollResult(
            channel_id=channel.channel_id,
            started_at=started,
            finished_at=finished,
            duration_ms=(time.perf_counter() - t0) * 1000.0,
            pending_count=0,
        )

    rp = retry_policy or RetryPolicy()

    # Enumerate pending under retry. Fail-fast if all attempts fail —
    # that's a connectivity issue, not a per-file problem.
    try:
        pending = with_retry(
            lambda: list(channel.list_pending()),
            policy=rp,
            on_retry=lambda attempt, exc: log.info(
                "Channel %s list_pending retry %d: %s",
                channel.channel_id, attempt, exc,
            ),
        )
    except Exception as e:
        breaker.record_failure(f"list_pending: {str(e)[:200]}")
        log.warning("Channel %s list_pending failed: %s", channel.channel_id, e)
        finished = _utc_iso()
        _emit_audit(
            kind="channel.poll",
            actor=actor,
            subject_id=channel.channel_id,
            payload={
                "outcome": "list_pending_failed",
                "error": str(e)[:500],
                "started_at": started,
                "finished_at": finished,
                "circuit_snapshot": breaker.snapshot(),
            },
        )
        return PollResult(
            channel_id=channel.channel_id,
            started_at=started,
            finished_at=finished,
            duration_ms=(time.perf_counter() - t0) * 1000.0,
            pending_count=0,
        )

    if max_files is not None:
        pending = pending[:max_files]

    for p in pending:
        result = _process_one(channel, p, actor=actor, retry_policy=rp)
        file_results.append(result)

    # Cycle outcome → breaker
    cycle_failed_count = sum(
        1 for fr in file_results if fr.status in ("quarantined", "failed")
    )
    cycle_succeeded_count = sum(
        1 for fr in file_results if fr.status in ("applied", "skipped")
    )
    if cycle_succeeded_count > 0 and cycle_failed_count == 0:
        breaker.record_success()
    elif file_results and cycle_succeeded_count == 0 and cycle_failed_count > 0:
        # Every file failed — count as a cycle failure for the breaker
        breaker.record_failure("all_files_failed")

    finished = _utc_iso()
    duration_ms = (time.perf_counter() - t0) * 1000.0

    poll_result = PollResult(
        channel_id=channel.channel_id,
        started_at=started,
        finished_at=finished,
        duration_ms=round(duration_ms, 2),
        pending_count=len(pending),
        file_results=file_results,
    )

    _emit_audit(
        kind="channel.poll",
        actor=actor,
        subject_id=channel.channel_id,
        payload={
            "outcome": "ok",
            "started_at": started,
            "finished_at": finished,
            "duration_ms": poll_result.duration_ms,
            "pending_count": poll_result.pending_count,
            "counts": poll_result.counts(),
        },
    )

    return poll_result


def _process_one(
    channel: IngestChannel,
    pending: PendingFile,
    *,
    actor: str,
    retry_policy: Optional[RetryPolicy] = None,
) -> FileResult:
    """Single-file pipeline: fetch → pipeline → writer.apply → ack | quarantine."""
    from ..adapters import get_adapter
    from ..pipeline import PipelineRowLimitExceeded, run_pipeline
    from ..writers import get_writer, has_writer
    # Late-bound to break circular imports + keep the channels
    # package importable in standalone extraction contexts.
    try:
        from ...state import get_dataset, swap_dataset
    except ImportError:
        get_dataset = lambda: None
        swap_dataset = lambda *a, **k: None

    file_started = time.perf_counter()
    file_result = FileResult(filename=pending.filename, status="failed")
    rp = retry_policy or RetryPolicy()

    # 1. Fetch (with retry — transient network blips shouldn't kill the file)
    try:
        body = with_retry(
            lambda: channel.fetch(pending),
            policy=rp,
            on_retry=lambda attempt, exc: log.info(
                "Channel %s fetch retry %d for %s: %s",
                channel.channel_id, attempt, pending.filename, exc,
            ),
        )
    except Exception as e:
        file_result.error = f"fetch: {str(e)[:300]}"
        # Don't quarantine on fetch failure — connectivity issues
        # should retry on next cycle, not lose the file. The runner
        # leaves the file in incoming/ (filesystem) or unread (IMAP).
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.fetched",
            actor=actor,
            subject_id=channel.channel_id,
            payload={
                "filename": pending.filename,
                "outcome": "fetch_failed",
                "error": file_result.error,
            },
        )
        return file_result

    file_result.bytes_read = len(body)

    # 1a. Byte cap — protects against single-file OOM. A 5GB
    # JSONL single-line, a 2GB XML doc, an unbounded HTTP body,
    # an oversized email attachment all land in quarantine here
    # rather than tipping the backend over.
    max_bytes = _max_file_bytes()
    if file_result.bytes_read > max_bytes:
        reason = (
            f"file_size_exceeds_cap: {file_result.bytes_read:,} bytes > "
            f"{max_bytes:,} (SPIRE_UIS_MAX_FILE_BYTES)"
        )
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={
                "filename": pending.filename,
                "reason": reason,
                "bytes_read": file_result.bytes_read,
                "max_bytes": max_bytes,
            },
        )
        return file_result

    # 1b. File integrity verify — channel may have surfaced a
    # declared sha256 (sidecar file, HTTP header, mailbox subject
    # convention). Mismatch is a poison-message signal — quarantine.
    try:
        file_result.file_sha256 = verify_against_declared(
            body, pending.content_hash_hint, filename=pending.filename,
        )
    except IntegrityMismatchError as e:
        reason = f"integrity_mismatch: {e}"
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={
                "filename": pending.filename,
                "reason": reason,
                "expected_sha256": e.expected,
                "actual_sha256": e.actual,
            },
        )
        return file_result

    _emit_audit(
        kind="channel.fetched",
        actor=actor,
        subject_id=channel.channel_id,
        payload={
            "filename": pending.filename,
            "size_bytes": file_result.bytes_read,
            "sha256": file_result.file_sha256,
            "integrity_verified": pending.content_hash_hint is not None,
        },
    )

    # 2. Pipeline parse — adapter resolved by the channel's adapter_id
    try:
        adapter = get_adapter(channel.adapter_id)
    except KeyError as e:
        # Misconfiguration. Quarantine so the operator notices on
        # next health check; otherwise the channel polls forever
        # against a dead adapter.
        reason = f"unknown_adapter: {channel.adapter_id}"
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={"filename": pending.filename, "reason": reason},
        )
        return file_result

    try:
        pipeline_result = run_pipeline(body, adapter)
    except PipelineRowLimitExceeded as e:
        reason = f"row_limit_exceeded: {e}"
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={"filename": pending.filename, "reason": reason},
        )
        return file_result
    except Exception as e:  # noqa: BLE001
        reason = f"pipeline_exception: {str(e)[:300]}"
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={"filename": pending.filename, "reason": reason},
        )
        return file_result

    file_result.rows_total = pipeline_result.report.rows_total
    file_result.rows_kept = pipeline_result.report.rows_kept

    # File-level pipeline warnings (encoding / duplicate-header /
    # etc.) — quarantine if any of the hard-fail codes fired.
    HARD_FAIL_CODES = {
        "duplicate_header_columns",
        "format_stream_error",
    }
    file_level_warnings = [
        w for w in pipeline_result.warnings if w.row_index < 0
    ]
    hard_fail = next(
        (w for w in file_level_warnings if w.code in HARD_FAIL_CODES),
        None,
    )
    if hard_fail is not None:
        reason = f"{hard_fail.code}: {hard_fail.message[:300]}"
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={"filename": pending.filename, "reason": reason},
        )
        return file_result

    # 3. Writer apply — when one is registered for this adapter
    if not has_writer(channel.adapter_id):
        # Read-only adapter — pipeline ran successfully (signal that
        # the file parsed cleanly) but no canonical write. Mark
        # acknowledged so we don't re-process; downstream consumers
        # can read from the audit chain if they care.
        _safe_acknowledge(channel, pending)
        file_result.status = "skipped"
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.skipped",
            actor=actor,
            subject_id=channel.channel_id,
            payload={
                "filename": pending.filename,
                "reason": "no_writer_registered",
                "rows_kept": pipeline_result.report.rows_kept,
            },
        )
        return file_result

    # P4.10 — refuse apply when a required canonical field is
    # unmapped. Channel runs are unattended; quarantine + audit
    # so the operator can spot the schema-drift on the next health
    # check.
    from ..pipeline import required_columns_unmapped as _required_unmapped
    missing_required = _required_unmapped(pipeline_result, adapter)
    if missing_required:
        reason = (
            f"required_canonical_fields_unmapped: {missing_required}. "
            "Source file missing columns the adapter requires."
        )
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={
                "filename": pending.filename,
                "reason": reason,
                "missing_required": missing_required,
            },
        )
        return file_result

    writer = get_writer(channel.adapter_id)
    ds = get_dataset()
    try:
        writer_diff = writer.preview(pipeline_result, ds)
    except Exception as e:  # noqa: BLE001
        reason = f"writer_preview_failed: {str(e)[:300]}"
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={"filename": pending.filename, "reason": reason},
        )
        return file_result

    if writer_diff.has_conflicts():
        # Conflicts require operator resolution; quarantine so the
        # file doesn't get re-attempted forever, sidecar carries
        # the conflict count.
        reason = f"conflicts: {len(writer_diff.conflicts)} row(s) need resolution"
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.diff_counts = dict(writer_diff.counts)
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={
                "filename": pending.filename,
                "reason": reason,
                "diff_counts": dict(writer_diff.counts),
            },
        )
        return file_result

    try:
        apply_result = writer.apply(writer_diff, ds)
        swap_dataset(
            apply_result.new_dataset,
            source=f"channel.{channel.channel_id}",
            ingested_by=actor,
            ingest_hash=file_result.file_sha256[:16],
        )
    except Exception as e:  # noqa: BLE001
        reason = f"writer_apply_failed: {str(e)[:300]}"
        _safe_quarantine(channel, pending, reason)
        file_result.status = "quarantined"
        file_result.error = reason
        file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
        _emit_audit(
            kind="channel.quarantined",
            actor=actor,
            subject_id=channel.channel_id,
            payload={"filename": pending.filename, "reason": reason},
        )
        return file_result

    # 4. Ack — apply succeeded, file consumed
    _safe_acknowledge(channel, pending)
    file_result.status = "applied"
    file_result.diff_counts = dict(apply_result.summary_counts)
    file_result.duration_ms = round((time.perf_counter() - file_started) * 1000.0, 2)
    _emit_audit(
        kind="channel.applied",
        actor=actor,
        subject_id=channel.channel_id,
        payload={
            "filename": pending.filename,
            "sha256": file_result.file_sha256,
            "counts": file_result.diff_counts,
            "rows_kept": file_result.rows_kept,
        },
    )
    # Per-row audit fan-out (writer-supplied)
    for row_audit in apply_result.audit_rows:
        _emit_audit(
            kind=row_audit["kind"],
            actor=actor,
            subject_id=row_audit["subject_id"],
            payload={**row_audit["payload"], "channel_id": channel.channel_id},
        )

    return file_result


def _safe_acknowledge(channel: IngestChannel, pending: PendingFile) -> None:
    try:
        channel.acknowledge(pending)
    except Exception as e:  # noqa: BLE001
        log.warning(
            "Channel %s: acknowledge failed for %s: %s",
            channel.channel_id, pending.filename, e,
        )


def _safe_quarantine(channel: IngestChannel, pending: PendingFile, reason: str) -> None:
    try:
        channel.quarantine(pending, reason)
    except Exception as e:  # noqa: BLE001
        log.warning(
            "Channel %s: quarantine failed for %s: %s",
            channel.channel_id, pending.filename, e,
        )


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Background scheduler
# ---------------------------------------------------------------------------


@dataclass
class ChannelScheduler:
    """Async scheduler that polls registered channels at their
    configured interval. Wire into FastAPI lifespan as::

        scheduler = ChannelScheduler()
        scheduler.add(channel, interval_seconds=300)
        await scheduler.start()
        # ... lifespan ...
        await scheduler.stop()

    The scheduler is single-process and single-task per channel —
    no thread pool, no concurrent polls of the same channel. That
    matches operational reality (an SFTP server doesn't expect two
    concurrent connections from the same intake).
    """

    _entries: Dict[str, "_ScheduledChannel"] = field(default_factory=dict, init=False)
    _running: bool = field(default=False, init=False)

    def add(
        self,
        channel: IngestChannel,
        *,
        interval_seconds: int = 300,
        actor: str = "channel-scheduler",
    ) -> None:
        self._entries[channel.channel_id] = _ScheduledChannel(
            channel=channel,
            interval_seconds=max(1, interval_seconds),
            actor=actor,
        )

    def remove(self, channel_id: str) -> None:
        entry = self._entries.pop(channel_id, None)
        if entry and entry.task is not None:
            entry.task.cancel()

    async def start(self) -> None:
        self._running = True
        for entry in self._entries.values():
            if entry.task is None or entry.task.done():
                entry.task = asyncio.create_task(self._loop(entry))

    async def stop(self) -> None:
        self._running = False
        for entry in self._entries.values():
            if entry.task is not None:
                entry.task.cancel()
        # Wait for them to finish cancelling
        for entry in self._entries.values():
            if entry.task is not None:
                try:
                    await entry.task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass

    async def _loop(self, entry: "_ScheduledChannel") -> None:
        while self._running:
            try:
                # Run the synchronous poll in a thread so it doesn't
                # block the event loop on slow SFTP connects.
                await asyncio.to_thread(
                    poll_channel, entry.channel, actor=entry.actor,
                )
            except Exception as e:  # noqa: BLE001
                log.warning(
                    "Channel %s scheduler loop caught: %s",
                    entry.channel.channel_id, e,
                )
            try:
                await asyncio.sleep(entry.interval_seconds)
            except asyncio.CancelledError:
                break


@dataclass
class _ScheduledChannel:
    channel: IngestChannel
    interval_seconds: int
    actor: str
    task: Optional[asyncio.Task] = None
