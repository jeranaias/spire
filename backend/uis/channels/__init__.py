"""Pull-mode ingestion channels.

The HTTP /api/uis/upload route is the push entry point — operator
drags a file into the dropzone and bytes flow through pipeline →
writer → canonical. Channels are the pull counterpart: SPIRE polls
a remote source on its own schedule, fetches new files, and routes
them through the same pipeline + writer.

Available channel types
-----------------------
* **filesystem** — local dir or mounted SMB/NFS share. Covers
  airgap-watcher, fileshare polling, USB sneakernet drop. No
  network deps.
* **sftp** — paramiko-backed SFTP poll. Most common DoD operational
  delivery (DLA EMALL nightly drops, M-CARE, GCSS-MC SFTP exports).
* **imap** — imaplib-backed email-attachment intake. Small unit
  daily reports; works through Outlook/Exchange via plain IMAP
  even when MS Graph is gated.
* **http_poll** — REST/SOAP polling for systems without file
  export (GCSS-MC SOAP web services, REST APIs).

Adding a new channel = drop a class implementing IngestChannel,
register it, import the module here for the side-effect.
"""
from __future__ import annotations

from .base import (
    CHANNELS,
    ChannelHealth,
    IngestChannel,
    PendingFile,
    get_channel,
    has_channel,
    list_channels,
    register_channel,
    unregister_channel,
)
from .filesystem import FilesystemChannel
from .http_poll import HttpPollChannel
from .imap import IMAPChannel
from .runner import (
    ChannelScheduler,
    FileResult,
    PollResult,
    poll_channel,
    set_audit_func,
)
from .sftp import SFTPChannel

__all__ = [
    "IngestChannel",
    "PendingFile",
    "ChannelHealth",
    "CHANNELS",
    "register_channel",
    "unregister_channel",
    "get_channel",
    "has_channel",
    "list_channels",
    "FilesystemChannel",
    "SFTPChannel",
    "IMAPChannel",
    "HttpPollChannel",
    "poll_channel",
    "PollResult",
    "FileResult",
    "ChannelScheduler",
    "set_audit_func",
]
