"""IngestChannel protocol + registry.

Channels are pull-mode counterparts to the HTTP /api/uis/upload
endpoint. Each channel knows how to enumerate pending files from a
source (fileshare, SFTP server, IMAP mailbox, REST endpoint, ...),
fetch them, and acknowledge consumption. The channel runner (in
``runner.py``) drives them through the pipeline + writer protocol
that all upload paths share.

Contract — pure I/O surface, no merge logic
-------------------------------------------
``list_pending() -> Iterable[PendingFile]``
    Enumerate files visible to this channel that haven't been
    consumed yet. Idempotent — calling twice with no new arrivals
    returns the same list. Channel decides "what's pending"
    (e.g. filesystem channel: files with mtime > checkpoint;
    IMAP channel: messages without the Seen flag).

``fetch(pending) -> bytes``
    Read the raw file bytes. Allowed to fail; runner retries with
    backoff per the resilience layer.

``acknowledge(pending) -> None``
    Mark the file as consumed (move to processed/, set Seen flag,
    advance the watermark, ...). MUST be idempotent — runner may
    retry after a partial-success failure.

``quarantine(pending, reason) -> None``
    Move the file to a poison/quarantine location so it doesn't
    get re-picked-up next poll. Required for DLQ semantics.

``health() -> ChannelHealth``
    Quick non-side-effecting status — connectivity, last-success,
    pending count. Surfaces in the channel admin tab + monitoring.

Registry
--------
Channels are registered against a unique ``channel_id``. The runner
looks up by id to drive a poll cycle. Two filesystem-watcher
channels watching different directories register as different ids.

Channel construction is split into "type" (the class — filesystem,
sftp, imap) and "config" (host, path, credentials env-var name).
This lets the persistence layer store config as JSON + reconstruct
the typed channel on startup.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Protocol, runtime_checkable


@dataclass
class PendingFile:
    """A file the channel has identified as pending ingest.

    ``handle`` is opaque to the runner — channels use it internally
    (full filesystem path, IMAP message UID, SFTP remote path, etc.)
    without leaking the type. ``filename`` is human-readable for
    audit / UI. ``size_bytes`` and ``content_hash_hint`` are
    optional metadata channels can populate when cheap.
    """

    handle: Any
    filename: str
    size_bytes: Optional[int] = None
    content_hash_hint: Optional[str] = None
    received_at: Optional[str] = None  # ISO-8601 if known

    def __repr__(self) -> str:
        return f"PendingFile({self.filename!r})"


@dataclass
class ChannelHealth:
    """Non-side-effecting status snapshot. Returned by ``health()``.

    Surfaced through the channel admin tab so an operator can spot
    a stuck poller without inspecting logs.
    """

    channel_id: str
    channel_type: str
    reachable: bool
    pending_count: Optional[int] = None
    last_polled_at: Optional[str] = None
    last_success_at: Optional[str] = None
    last_error: Optional[str] = None
    consecutive_failures: int = 0
    circuit_open: bool = False
    extra: Dict[str, Any] = field(default_factory=dict)


@runtime_checkable
class IngestChannel(Protocol):
    """Pull channel — fileshare watcher, SFTP poller, IMAP intake, etc.

    Channels are stateless w.r.t. canonical data; they only know how
    to surface files. Apply semantics live in the writer layer; the
    runner glues channel + pipeline + writer.
    """

    channel_id: str
    channel_type: str   # "filesystem" / "sftp" / "imap" / "http_poll" / ...
    adapter_id: str     # which AdapterSpec parses fetched bytes

    def list_pending(self) -> Iterable[PendingFile]: ...

    def fetch(self, pending: PendingFile) -> bytes: ...

    def acknowledge(self, pending: PendingFile) -> None: ...

    def quarantine(self, pending: PendingFile, reason: str) -> None: ...

    def health(self) -> ChannelHealth: ...


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


CHANNELS: Dict[str, IngestChannel] = {}


def register_channel(channel: IngestChannel) -> IngestChannel:
    """Register a channel against its ``channel_id``.

    Re-registration is allowed (tests do this); the new instance
    replaces the prior one. The runner always looks up fresh from
    the registry, so a swap takes effect on the next poll.
    """
    if not getattr(channel, "channel_id", ""):
        raise ValueError("IngestChannel must declare a non-empty channel_id")
    if not getattr(channel, "adapter_id", ""):
        raise ValueError(
            f"IngestChannel {channel.channel_id!r} must declare an adapter_id"
        )
    CHANNELS[channel.channel_id] = channel
    return channel


def unregister_channel(channel_id: str) -> bool:
    return CHANNELS.pop(channel_id, None) is not None


def get_channel(channel_id: str) -> IngestChannel:
    if channel_id not in CHANNELS:
        raise KeyError(
            f"No channel registered for channel_id {channel_id!r}. "
            f"Known: {sorted(CHANNELS.keys())}"
        )
    return CHANNELS[channel_id]


def has_channel(channel_id: str) -> bool:
    return channel_id in CHANNELS


def list_channels() -> List[IngestChannel]:
    return list(CHANNELS.values())
