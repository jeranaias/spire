"""Records retention + hard-delete (UIS-P6.8 / DoD 5015.02).

Two failure modes this closes:

  1. **Disk bloat** — filesystem channels keep their full
     ``processed/<YYYY-MM-DD>/`` and ``quarantine/`` history
     forever. A unit pulling 50 files/day for two years would
     accumulate 36k files with no cleanup signal.
  2. **Records management non-compliance** — DoD 5015.02-STD
     requires per-record-class retention + auditable deletion.
     Without explicit retention rules every deletion is an
     ad-hoc operator action with no reconstructible trail.

What's in scope here
--------------------
* Filesystem channel ``processed/<YYYY-MM-DD>/`` directories →
  age-based delete (default: 90 days)
* Filesystem channel ``quarantine/`` files → age-based delete
  (default: 30 days)
* HTTP-poll / DB CDC / Kafka quarantine artifacts (when
  configured to local disk) — same rules as filesystem
* Operator-triggered **spillage cleanup** — hard-delete + sealed
  audit entry naming the reason and the file hash so the
  deletion is reconstructible without retaining the data

What's NOT in scope (intentionally)
-----------------------------------
* Audit chain (``audit_log`` table) — NEVER auto-deleted. ATO
  mandates indefinite retention. Operators with legitimate
  expiry needs run an offline archive procedure outside this
  module.
* Canonical dataset rows — the dataset is a snapshot model;
  retention there is managed at the swap layer (P6.6 DR/backup).
* MappingProfile + ChannelConfig — operator-managed; no
  automatic expiry.

Audit semantics for deletions
-----------------------------
Every file deleted by retention emits an audit entry:

  kind: "retention.delete"
  payload: {channel_id, filename, reason, sha256, age_days, class}

The sha256 is computed before deletion so an investigator can
later verify which specific bytes were removed without keeping
the bytes themselves. ``reason`` is one of:
  - "expired"  — TTL-based retention sweep
  - "spillage" — operator-triggered spillage cleanup
  - "manual"   — operator-triggered routine cleanup
"""
from __future__ import annotations

import hashlib
import logging
import os
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


log = logging.getLogger(__name__)


# Audit emitter — injected like the rest of the UIS package.
AuditFunc = Callable[..., None]
_audit: AuditFunc = lambda **kwargs: None


def set_audit_func(fn: AuditFunc) -> None:
    global _audit
    _audit = fn


# ---------------------------------------------------------------------------
# Retention policy model
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RetentionPolicy:
    """Per-record-class retention rule.

    ``class_name`` is a free-form label (e.g. "filesystem.processed",
    "filesystem.quarantine", "http.quarantine"). ``ttl_days`` is the
    age cutoff; ``min_keep_count`` is a floor that prevents over-
    aggressive cleanup on quiet channels (always retain the N most
    recent files even if they're past TTL).
    """
    class_name: str
    ttl_days: int
    min_keep_count: int = 0


# Default policies — operator can override via SPIRE_RETENTION_OVERRIDES env
# (JSON dict of class_name → ttl_days).
DEFAULT_POLICIES: Dict[str, RetentionPolicy] = {
    "filesystem.processed": RetentionPolicy(
        class_name="filesystem.processed", ttl_days=90, min_keep_count=10,
    ),
    "filesystem.quarantine": RetentionPolicy(
        class_name="filesystem.quarantine", ttl_days=30, min_keep_count=5,
    ),
    # HTTP / DB CDC / Kafka local quarantine (when configured to
    # write to disk for forensic inspection)
    "http.quarantine": RetentionPolicy(
        class_name="http.quarantine", ttl_days=30, min_keep_count=5,
    ),
    "db_cdc.quarantine": RetentionPolicy(
        class_name="db_cdc.quarantine", ttl_days=30, min_keep_count=5,
    ),
    "kafka.quarantine": RetentionPolicy(
        class_name="kafka.quarantine", ttl_days=30, min_keep_count=5,
    ),
}


def load_policies() -> Dict[str, RetentionPolicy]:
    """Returns DEFAULT_POLICIES with any operator overrides applied.

    Override format: SPIRE_RETENTION_OVERRIDES='{"class": ttl_days, ...}'
    """
    out = dict(DEFAULT_POLICIES)
    raw = os.environ.get("SPIRE_RETENTION_OVERRIDES", "").strip()
    if not raw:
        return out
    try:
        import json
        overrides = json.loads(raw)
        for cls, ttl in overrides.items():
            if cls in out:
                out[cls] = RetentionPolicy(
                    class_name=cls,
                    ttl_days=int(ttl),
                    min_keep_count=out[cls].min_keep_count,
                )
            else:
                out[cls] = RetentionPolicy(class_name=cls, ttl_days=int(ttl))
    except Exception as e:  # noqa: BLE001
        log.warning("SPIRE_RETENTION_OVERRIDES parse failed: %s", e)
    return out


# ---------------------------------------------------------------------------
# Cleanup result
# ---------------------------------------------------------------------------


@dataclass
class RetentionResult:
    """Aggregate outcome of one retention sweep."""

    started_at: str
    finished_at: str
    dry_run: bool
    deleted: List[Dict[str, Any]] = field(default_factory=list)
    skipped: List[Dict[str, Any]] = field(default_factory=list)
    errors: List[Dict[str, Any]] = field(default_factory=list)

    def counts(self) -> Dict[str, int]:
        return {
            "deleted": len(self.deleted),
            "skipped": len(self.skipped),
            "errors": len(self.errors),
        }


# ---------------------------------------------------------------------------
# Sweep — filesystem channels
# ---------------------------------------------------------------------------


def sweep_filesystem_channel(
    channel_id: str,
    root: str,
    *,
    policies: Optional[Dict[str, RetentionPolicy]] = None,
    dry_run: bool = False,
    actor: str = "retention",
    now: Optional[datetime] = None,
) -> RetentionResult:
    """Walk a filesystem channel's processed/ + quarantine/ dirs;
    delete files past their class TTL with audit emission.

    ``min_keep_count`` ensures the most-recent N files survive
    even if past TTL — protects quiet channels from losing all
    forensic context.
    """
    pols = policies or load_policies()
    nowt = now or datetime.now(timezone.utc)
    started = nowt.isoformat(timespec="seconds")

    result = RetentionResult(
        started_at=started, finished_at=started, dry_run=dry_run,
    )

    root_p = Path(root)

    # Sweep quarantine/ — flat dir of files + .reason.txt sidecars
    qdir = root_p / "quarantine"
    if qdir.exists():
        _sweep_flat_dir(
            channel_id=channel_id,
            class_name="filesystem.quarantine",
            directory=qdir,
            policy=pols.get("filesystem.quarantine"),
            now=nowt,
            dry_run=dry_run,
            actor=actor,
            result=result,
        )

    # Sweep processed/<YYYY-MM-DD>/ — dated subdirs
    pdir = root_p / "processed"
    if pdir.exists():
        _sweep_dated_subdirs(
            channel_id=channel_id,
            class_name="filesystem.processed",
            directory=pdir,
            policy=pols.get("filesystem.processed"),
            now=nowt,
            dry_run=dry_run,
            actor=actor,
            result=result,
        )

    result.finished_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return result


def _sweep_flat_dir(
    *,
    channel_id: str,
    class_name: str,
    directory: Path,
    policy: Optional[RetentionPolicy],
    now: datetime,
    dry_run: bool,
    actor: str,
    result: RetentionResult,
) -> None:
    if policy is None:
        return
    cutoff = now - timedelta(days=policy.ttl_days)
    # Build past-TTL candidate list (excluding .reason.txt sidecars
    # — those get deleted alongside their parent below). Sort
    # newest-first so min_keep_count protects the most-recent N
    # expired files specifically. Files within TTL aren't in the
    # candidate list at all, so they don't burn a min_keep slot.
    past_ttl: List[Path] = []
    for path in directory.iterdir():
        if not path.is_file():
            continue
        if path.name.endswith(".reason.txt"):
            continue
        try:
            stat = path.stat()
        except OSError as e:
            result.errors.append({"filename": str(path), "error": str(e)})
            continue
        mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
        if mtime >= cutoff:
            continue  # within TTL
        past_ttl.append(path)
    past_ttl.sort(key=lambda p: p.stat().st_mtime, reverse=True)

    for idx, path in enumerate(past_ttl):
        try:
            stat = path.stat()
            mtime = datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc)
            age_days = (now - mtime).days
            if idx < policy.min_keep_count:
                result.skipped.append({
                    "channel_id": channel_id,
                    "class": class_name,
                    "filename": str(path.relative_to(directory.parent)),
                    "reason": "min_keep_count_floor",
                    "age_days": age_days,
                })
                continue
            _delete_file_with_audit(
                channel_id=channel_id,
                class_name=class_name,
                path=path,
                age_days=age_days,
                reason="expired",
                dry_run=dry_run,
                actor=actor,
                result=result,
            )
            sidecar = path.with_suffix(path.suffix + ".reason.txt")
            if sidecar.exists():
                _delete_file_with_audit(
                    channel_id=channel_id,
                    class_name=class_name,
                    path=sidecar,
                    age_days=age_days,
                    reason="expired_sidecar",
                    dry_run=dry_run,
                    actor=actor,
                    result=result,
                )
        except OSError as e:
            result.errors.append({
                "filename": str(path),
                "error": str(e),
            })


def _sweep_dated_subdirs(
    *,
    channel_id: str,
    class_name: str,
    directory: Path,
    policy: Optional[RetentionPolicy],
    now: datetime,
    dry_run: bool,
    actor: str,
    result: RetentionResult,
) -> None:
    """Sweep ``processed/<YYYY-MM-DD>/`` — entire dated subdirs
    drop together when the date itself is past TTL. min_keep_count
    is interpreted as "keep at least the N newest dated subdirs."
    """
    if policy is None:
        return
    cutoff = now - timedelta(days=policy.ttl_days)
    subdirs = sorted(
        (d for d in directory.iterdir() if d.is_dir()),
        key=lambda d: d.name,
        reverse=True,
    )
    for idx, sub in enumerate(subdirs):
        # Try to parse the dirname as an ISO date; fall back to
        # mtime if it's a non-standard layout
        try:
            sub_date = datetime.strptime(sub.name, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            try:
                sub_date = datetime.fromtimestamp(sub.stat().st_mtime, tz=timezone.utc)
            except OSError:
                continue
        age_days = (now - sub_date).days
        if sub_date >= cutoff:
            continue
        if idx < policy.min_keep_count:
            result.skipped.append({
                "channel_id": channel_id,
                "class": class_name,
                "filename": str(sub.relative_to(directory.parent)),
                "reason": "min_keep_count_floor",
                "age_days": age_days,
            })
            continue
        # Delete every file in the subdir with individual audit
        # entries, then rmdir
        try:
            for path in sorted(sub.rglob("*")):
                if path.is_file():
                    _delete_file_with_audit(
                        channel_id=channel_id,
                        class_name=class_name,
                        path=path,
                        age_days=age_days,
                        reason="expired",
                        dry_run=dry_run,
                        actor=actor,
                        result=result,
                    )
            if not dry_run:
                shutil.rmtree(sub, ignore_errors=True)
        except OSError as e:
            result.errors.append({
                "filename": str(sub),
                "error": str(e),
            })


def _delete_file_with_audit(
    *,
    channel_id: str,
    class_name: str,
    path: Path,
    age_days: int,
    reason: str,
    dry_run: bool,
    actor: str,
    result: RetentionResult,
) -> None:
    """Hard-delete a file + emit ``retention.delete`` audit. The
    file's sha256 is recorded so a future investigator can verify
    what was removed without keeping the bytes."""
    try:
        sha = _file_sha256(path)
        size = path.stat().st_size
    except OSError as e:
        result.errors.append({
            "filename": str(path),
            "error": f"stat_failed: {e}",
        })
        return

    record = {
        "channel_id": channel_id,
        "class": class_name,
        "filename": path.name,
        "path": str(path),
        "size_bytes": size,
        "sha256": sha,
        "age_days": age_days,
        "reason": reason,
        "dry_run": dry_run,
    }
    result.deleted.append(record)

    if dry_run:
        return

    try:
        path.unlink()
    except OSError as e:
        result.errors.append({
            "filename": str(path),
            "error": f"unlink_failed: {e}",
        })
        return

    # Best-effort audit emission — a chain failure doesn't undo
    # the delete (the file is already gone), but the operator
    # sees the warning in the runner's audit log + this module's
    # error list.
    try:
        _audit(
            kind="retention.delete",
            actor=actor,
            subject_id=channel_id,
            payload=record,
        )
    except Exception as e:  # noqa: BLE001
        result.errors.append({
            "filename": str(path),
            "error": f"audit_emit_failed: {e}",
        })


# ---------------------------------------------------------------------------
# Spillage cleanup — operator-triggered hard-delete
# ---------------------------------------------------------------------------


@dataclass
class SpillageReport:
    spillage_id: str
    requested_by: str
    reason: str
    deleted_files: List[Dict[str, Any]] = field(default_factory=list)
    errors: List[Dict[str, Any]] = field(default_factory=list)


def cleanup_spillage(
    *,
    paths: List[str],
    requested_by: str,
    reason: str,
    classification: str = "UNKNOWN",
    actor: str = "spillage-handler",
) -> SpillageReport:
    """Hard-delete a list of paths flagged as classification
    spillage. Each deletion records:
      - the file's sha256 (so the deletion is verifiable later)
      - the reason + classification claimed
      - who requested it (chain-of-command attribution)
      - a unique spillage_id linking related cleanup events

    Audit emission MUST succeed for the operation to count as
    valid records-management evidence; if it fails the file is
    still gone but the operator sees an error and re-emits
    manually. This is the trade-off of best-effort vs strict-
    transactional — for spillage we lean toward hard-delete-now
    with manual audit recovery, since leaving classified data
    in place is the worse outcome.
    """
    import secrets as _secrets
    spillage_id = _secrets.token_hex(8)
    report = SpillageReport(
        spillage_id=spillage_id,
        requested_by=requested_by,
        reason=reason,
    )

    for raw_path in paths:
        p = Path(raw_path)
        if not p.exists():
            report.errors.append({
                "path": raw_path,
                "error": "not_found",
            })
            continue
        if not p.is_file():
            report.errors.append({
                "path": raw_path,
                "error": "not_a_file",
            })
            continue
        try:
            sha = _file_sha256(p)
            size = p.stat().st_size
        except OSError as e:
            report.errors.append({
                "path": raw_path,
                "error": f"stat_failed: {e}",
            })
            continue

        record = {
            "spillage_id": spillage_id,
            "path": str(p),
            "sha256": sha,
            "size_bytes": size,
            "classification": classification,
            "reason": reason,
            "requested_by": requested_by,
        }

        try:
            p.unlink()
            report.deleted_files.append(record)
        except OSError as e:
            report.errors.append({
                "path": raw_path,
                "error": f"unlink_failed: {e}",
            })
            continue

        try:
            _audit(
                kind="retention.spillage",
                actor=actor,
                subject_id=spillage_id,
                payload=record,
            )
        except Exception as e:  # noqa: BLE001
            report.errors.append({
                "path": raw_path,
                "error": f"audit_emit_failed: {e}",
            })

    # Summary entry — pinned to spillage_id so an investigation
    # can correlate the per-file events
    try:
        _audit(
            kind="retention.spillage.summary",
            actor=actor,
            subject_id=spillage_id,
            payload={
                "spillage_id": spillage_id,
                "requested_by": requested_by,
                "reason": reason,
                "classification": classification,
                "files_deleted": len(report.deleted_files),
                "errors": len(report.errors),
            },
        )
    except Exception as e:  # noqa: BLE001
        report.errors.append({
            "path": "<summary>",
            "error": f"audit_summary_failed: {e}",
        })

    return report


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()
