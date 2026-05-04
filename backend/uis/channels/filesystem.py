"""FilesystemChannel — directory polling for any pull source backed by
a local or mounted filesystem.

Covers three operational patterns with one implementation:

  1. **Airgap watcher** — operator drops a USB drive into a conex
     comms shelter, mounts it, copies files to a known incoming/
     directory. SPIRE picks them up on next poll. No network.
  2. **Fileshare polling** — Windows `\\\\share\\path` mounted on the
     SPIRE host, or Linux NFS/CIFS mount. Same code path.
  3. **SMB-as-mount** — DoD-internal SMB shares mounted via
     `mount.cifs` show up as a normal directory; SMB-specific auth
     is handled by the OS, not us.

State is filesystem-native — no DB rows, no checkpoints to lose.
Pending files live in ``incoming/``; consumed files move to
``processed/<YYYY-MM-DD>/``; poison files move to ``quarantine/``
with a sidecar ``.reason.txt``. An operator can inspect the on-
disk state directly to understand what's where.

Stability filter: files newer than ``stability_seconds`` are
skipped — guards against picking up a file mid-write. Default is
5 seconds, conservative for typical FTP / SMB write patterns.
"""
from __future__ import annotations

import logging
import os
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Optional

from .base import ChannelHealth, IngestChannel, PendingFile, register_channel


log = logging.getLogger(__name__)


@dataclass
class FilesystemChannel:
    """Polling channel rooted at a filesystem directory.

    Layout under ``root``::

        incoming/        files awaiting pickup
        processed/       <YYYY-MM-DD>/<original_filename>
        quarantine/      <original_filename> + <original_filename>.reason.txt

    The runner calls ``list_pending`` → ``fetch`` → (apply via
    pipeline+writer) → ``acknowledge`` (success) | ``quarantine``
    (poison). Move semantics are atomic on POSIX and best-effort on
    Windows; failures degrade to copy+delete.
    """

    channel_id: str
    adapter_id: str
    root: str
    glob: str = "*"
    stability_seconds: int = 5
    channel_type: str = field(default="filesystem", init=False)

    # Mutable runtime state — kept separate from config so to_config_dict
    # below produces a stable JSON shape suitable for persistence.
    _last_polled_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_success_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_error: Optional[str] = field(default=None, init=False, repr=False)
    _consecutive_failures: int = field(default=0, init=False, repr=False)

    def __post_init__(self) -> None:
        # Ensure the layout exists. Idempotent — first poll ever
        # creates the dirs, subsequent polls no-op.
        self._ensure_layout()

    # ------------------------------------------------------------------
    # Path helpers
    # ------------------------------------------------------------------

    def _root_path(self) -> Path:
        return Path(self.root)

    def _incoming(self) -> Path:
        return self._root_path() / "incoming"

    def _processed_dir_today(self) -> Path:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return self._root_path() / "processed" / today

    def _quarantine(self) -> Path:
        return self._root_path() / "quarantine"

    def _ensure_layout(self) -> None:
        try:
            self._incoming().mkdir(parents=True, exist_ok=True)
            (self._root_path() / "processed").mkdir(parents=True, exist_ok=True)
            self._quarantine().mkdir(parents=True, exist_ok=True)
        except OSError as e:
            # Don't crash on construction — surface via health() instead
            # so the operator sees a permissions error in the admin tab.
            log.warning(
                "FilesystemChannel %s could not initialize layout at %s: %s",
                self.channel_id, self.root, e,
            )

    # ------------------------------------------------------------------
    # IngestChannel interface
    # ------------------------------------------------------------------

    def list_pending(self) -> Iterable[PendingFile]:
        self._last_polled_at = _utc_iso()
        incoming = self._incoming()
        if not incoming.exists():
            return []
        out: List[PendingFile] = []
        cutoff = time.time() - max(0, self.stability_seconds)
        for path in sorted(incoming.glob(self.glob)):
            if not path.is_file():
                continue
            try:
                stat = path.stat()
            except OSError:
                continue
            # Stability filter — skip files still being written
            if stat.st_mtime > cutoff:
                continue
            out.append(PendingFile(
                handle=str(path),
                filename=path.name,
                size_bytes=stat.st_size,
                received_at=datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc,
                ).isoformat(),
            ))
        return out

    def fetch(self, pending: PendingFile) -> bytes:
        path = Path(pending.handle)
        try:
            return path.read_bytes()
        except Exception as e:
            self._record_failure(str(e))
            raise

    def acknowledge(self, pending: PendingFile) -> None:
        """Move ``incoming/<file>`` → ``processed/<YYYY-MM-DD>/<file>``.

        Idempotent: if the source no longer exists (already moved on
        a prior partial-success), skip silently.
        """
        src = Path(pending.handle)
        if not src.exists():
            return
        target_dir = self._processed_dir_today()
        target_dir.mkdir(parents=True, exist_ok=True)
        target = _unique_target(target_dir / src.name)
        _safe_move(src, target)
        self._last_success_at = _utc_iso()
        self._consecutive_failures = 0
        self._last_error = None

    def quarantine(self, pending: PendingFile, reason: str) -> None:
        """Move ``incoming/<file>`` → ``quarantine/<file>`` with a
        sidecar reason file so an operator can tell why it's there.
        """
        src = Path(pending.handle)
        if not src.exists():
            return
        q_dir = self._quarantine()
        q_dir.mkdir(parents=True, exist_ok=True)
        target = _unique_target(q_dir / src.name)
        _safe_move(src, target)
        sidecar = target.with_suffix(target.suffix + ".reason.txt")
        try:
            sidecar.write_text(
                f"channel: {self.channel_id}\n"
                f"timestamp: {_utc_iso()}\n"
                f"reason: {reason}\n",
                encoding="utf-8",
            )
        except OSError as e:
            log.warning("Could not write quarantine sidecar %s: %s", sidecar, e)
        self._record_failure(reason)

    def health(self) -> ChannelHealth:
        reachable = False
        pending_count: Optional[int] = None
        try:
            incoming = self._incoming()
            reachable = incoming.exists() and os.access(incoming, os.R_OK | os.W_OK)
            if reachable:
                pending_count = sum(1 for p in incoming.glob(self.glob) if p.is_file())
        except OSError as e:
            self._last_error = str(e)
        return ChannelHealth(
            channel_id=self.channel_id,
            channel_type=self.channel_type,
            reachable=reachable,
            pending_count=pending_count,
            last_polled_at=self._last_polled_at,
            last_success_at=self._last_success_at,
            last_error=self._last_error,
            consecutive_failures=self._consecutive_failures,
            extra={"root": self.root, "glob": self.glob},
        )

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _record_failure(self, reason: str) -> None:
        self._consecutive_failures += 1
        self._last_error = reason

    def to_config_dict(self) -> dict:
        """Serialize for the channel-config persistence layer."""
        return {
            "channel_id": self.channel_id,
            "channel_type": self.channel_type,
            "adapter_id": self.adapter_id,
            "config": {
                "root": self.root,
                "glob": self.glob,
                "stability_seconds": self.stability_seconds,
            },
        }


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _unique_target(target: Path) -> Path:
    """If ``target`` exists, append a numeric suffix until it doesn't.

    Prevents collisions when two files with the same name arrive on
    different days but get processed into the same dated directory,
    or when a quarantined name is re-quarantined later.
    """
    if not target.exists():
        return target
    stem = target.stem
    suffix = target.suffix
    parent = target.parent
    n = 2
    while True:
        candidate = parent / f"{stem}-{n}{suffix}"
        if not candidate.exists():
            return candidate
        n += 1


def _safe_move(src: Path, target: Path) -> None:
    """``shutil.move`` is atomic-ish on same filesystem, copy+delete
    across mount boundaries. Use it directly — same semantics across
    POSIX + Windows."""
    shutil.move(str(src), str(target))
