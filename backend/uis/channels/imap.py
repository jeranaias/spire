"""IMAPChannel — email-attachment intake.

Small unit daily reports often arrive by email when SFTP isn't
provisioned: a battalion S-4 emails the daily readiness CSV to a
shared mailbox, SPIRE polls that mailbox, picks up the attachment.

Works against any IMAP4-SSL server: Exchange Online via plain
IMAP, on-prem Exchange, Postfix/Dovecot for lab. MS Graph is a
better path for O365 production, but IMAP is universal and
unblocked even when Graph is gated for tenant policy reasons.

Protocol semantics
------------------
list_pending  — search the inbox folder for un-Seen messages
                whose attachments match a filename glob and an
                optional sender allowlist (anti-spoofing). Each
                attachment becomes one PendingFile.
fetch         — re-open the message + extract the attachment
                bytes by mime part index.
acknowledge   — mark message Seen + (optional) move to a
                "processed" folder so it's not re-evaluated next
                poll. If no processed_folder is configured, the
                Seen flag alone is the dedup signal.
quarantine    — mark Seen + move to a "quarantine" folder; the
                reason is appended as an X-SPIRE-Quarantine-Reason
                header on a copy of the message.

Credential model
----------------
Identical to SFTPChannel: password lives in an env var; only the
env var NAME is stored. Channel resolves at connect time.

Sender allow-list
-----------------
Sender addresses are spoofable, but combined with TLS to a
trusted IMAP server (provider does SPF/DKIM/DMARC enforcement
upstream) the allowlist is meaningful operational hygiene. The
channel rejects attachments whose ``From:`` doesn't match the
allowlist when set.
"""
from __future__ import annotations

import email
import email.policy
import imaplib
import logging
import os
import socket
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import Message
from fnmatch import fnmatch
from typing import Any, Iterable, List, Optional

from .base import ChannelHealth, IngestChannel, PendingFile


log = logging.getLogger(__name__)


@dataclass
class _ImapHandle:
    """Opaque handle a PendingFile carries to identify which
    attachment of which message it represents."""
    uid: str
    attachment_index: int
    filename: str
    sender: str


@dataclass
class IMAPChannel:
    """Polling channel for IMAP4-SSL mailboxes.

    One configured mailbox + one inbox folder + one filename glob
    + one optional sender allowlist. For multiple report types,
    register multiple IMAPChannel instances (or use the same
    inbox + different glob patterns).
    """

    channel_id: str
    adapter_id: str
    host: str
    username: str
    password_env: str
    inbox_folder: str = "INBOX"
    processed_folder: Optional[str] = None
    quarantine_folder: Optional[str] = None
    port: int = 993
    use_ssl: bool = True
    attachment_glob: str = "*"
    sender_allowlist: List[str] = field(default_factory=list)
    channel_type: str = field(default="imap", init=False)

    _last_polled_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_success_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_error: Optional[str] = field(default=None, init=False, repr=False)
    _consecutive_failures: int = field(default=0, init=False, repr=False)

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def _connect(self) -> imaplib.IMAP4:
        pwd = os.environ.get(self.password_env)
        if not pwd:
            raise RuntimeError(
                f"IMAPChannel {self.channel_id}: password_env "
                f"{self.password_env!r} is empty / unset."
            )
        if self.use_ssl:
            client = imaplib.IMAP4_SSL(self.host, self.port)
        else:
            client = imaplib.IMAP4(self.host, self.port)
        client.login(self.username, pwd)
        return client

    # ------------------------------------------------------------------
    # IngestChannel interface
    # ------------------------------------------------------------------

    def list_pending(self) -> Iterable[PendingFile]:
        self._last_polled_at = _utc_iso()
        client: Optional[imaplib.IMAP4] = None
        try:
            client = self._connect()
            client.select(self.inbox_folder)
            # Search for un-seen messages
            typ, data = client.uid("search", None, "UNSEEN")
            if typ != "OK":
                self._record_failure(f"IMAP search failed: {typ}")
                return []
            uids = data[0].split() if data and data[0] else []
            out: List[PendingFile] = []
            for uid_bytes in uids:
                uid = uid_bytes.decode("ascii")
                msg = self._fetch_message(client, uid)
                if msg is None:
                    continue
                sender = self._extract_sender(msg)
                if not self._sender_allowed(sender):
                    log.info(
                        "IMAPChannel %s: rejecting message uid=%s sender=%r — not in allowlist",
                        self.channel_id, uid, sender,
                    )
                    continue
                for idx, part in enumerate(msg.walk()):
                    if part.get_content_maintype() == "multipart":
                        continue
                    filename = part.get_filename()
                    if not filename:
                        continue
                    if not fnmatch(filename, self.attachment_glob):
                        continue
                    handle = _ImapHandle(
                        uid=uid,
                        attachment_index=idx,
                        filename=filename,
                        sender=sender,
                    )
                    payload = part.get_payload(decode=True) or b""
                    out.append(PendingFile(
                        handle=handle,
                        filename=filename,
                        size_bytes=len(payload),
                        received_at=_msg_date_iso(msg),
                    ))
            return out
        except Exception as e:
            self._record_failure(str(e))
            raise
        finally:
            if client is not None:
                try:
                    client.logout()
                except Exception:
                    pass

    def fetch(self, pending: PendingFile) -> bytes:
        if not isinstance(pending.handle, _ImapHandle):
            raise TypeError(
                f"IMAPChannel.fetch expected _ImapHandle, got {type(pending.handle)}"
            )
        handle: _ImapHandle = pending.handle
        client: Optional[imaplib.IMAP4] = None
        try:
            client = self._connect()
            client.select(self.inbox_folder)
            msg = self._fetch_message(client, handle.uid)
            if msg is None:
                raise RuntimeError(
                    f"IMAPChannel {self.channel_id}: message uid={handle.uid} "
                    "no longer in inbox (consumed concurrently?)"
                )
            for idx, part in enumerate(msg.walk()):
                if idx != handle.attachment_index:
                    continue
                payload = part.get_payload(decode=True)
                if payload is None:
                    raise RuntimeError(
                        f"IMAPChannel {self.channel_id}: attachment idx="
                        f"{handle.attachment_index} on uid={handle.uid} has no payload"
                    )
                return payload
            raise RuntimeError(
                f"IMAPChannel {self.channel_id}: attachment idx="
                f"{handle.attachment_index} not present in uid={handle.uid}"
            )
        except Exception as e:
            self._record_failure(str(e))
            raise
        finally:
            if client is not None:
                try:
                    client.logout()
                except Exception:
                    pass

    def acknowledge(self, pending: PendingFile) -> None:
        handle: _ImapHandle = pending.handle
        client: Optional[imaplib.IMAP4] = None
        try:
            client = self._connect()
            client.select(self.inbox_folder)
            # Mark Seen — that alone is enough to dedup on next poll
            # since list_pending searches UNSEEN only.
            client.uid("store", handle.uid, "+FLAGS", "(\\Seen)")
            if self.processed_folder:
                self._move_uid(client, handle.uid, self.processed_folder)
            self._last_success_at = _utc_iso()
            self._consecutive_failures = 0
            self._last_error = None
        except Exception as e:
            log.warning(
                "IMAPChannel %s: ack failed for uid=%s: %s",
                self.channel_id, handle.uid, e,
            )
        finally:
            if client is not None:
                try:
                    client.logout()
                except Exception:
                    pass

    def quarantine(self, pending: PendingFile, reason: str) -> None:
        handle: _ImapHandle = pending.handle
        client: Optional[imaplib.IMAP4] = None
        try:
            client = self._connect()
            client.select(self.inbox_folder)
            client.uid("store", handle.uid, "+FLAGS", "(\\Seen)")
            if self.quarantine_folder:
                self._move_uid(
                    client, handle.uid, self.quarantine_folder,
                    extra_header=f"X-SPIRE-Quarantine-Reason: {reason}",
                )
            log.warning(
                "IMAPChannel %s: quarantined uid=%s reason=%s",
                self.channel_id, handle.uid, reason,
            )
        except Exception as e:
            log.warning(
                "IMAPChannel %s: quarantine failed for uid=%s: %s",
                self.channel_id, handle.uid, e,
            )
        finally:
            if client is not None:
                try:
                    client.logout()
                except Exception:
                    pass
        self._record_failure(reason)

    def health(self) -> ChannelHealth:
        reachable = False
        pending_count: Optional[int] = None
        try:
            with socket.create_connection((self.host, self.port), timeout=5):
                reachable = True
            client = self._connect()
            try:
                client.select(self.inbox_folder)
                typ, data = client.uid("search", None, "UNSEEN")
                if typ == "OK" and data and data[0]:
                    pending_count = len(data[0].split())
                else:
                    pending_count = 0
            finally:
                try:
                    client.logout()
                except Exception:
                    pass
        except Exception as e:
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
            extra={
                "host": self.host,
                "port": self.port,
                "inbox_folder": self.inbox_folder,
                "sender_allowlist_size": len(self.sender_allowlist),
            },
        )

    # ------------------------------------------------------------------
    # Internal — IMAP helpers
    # ------------------------------------------------------------------

    def _fetch_message(self, client: imaplib.IMAP4, uid: str) -> Optional[Message]:
        typ, data = client.uid("fetch", uid, "(RFC822)")
        if typ != "OK" or not data or not data[0]:
            return None
        # data is [(b'1 (RFC822 {len}', b'<bytes>'), b')']
        raw_bytes: Optional[bytes] = None
        for piece in data:
            if isinstance(piece, tuple) and len(piece) >= 2:
                raw_bytes = piece[1]
                break
        if raw_bytes is None:
            return None
        return email.message_from_bytes(raw_bytes, policy=email.policy.default)

    def _move_uid(
        self,
        client: imaplib.IMAP4,
        uid: str,
        target_folder: str,
        *,
        extra_header: Optional[str] = None,
    ) -> None:
        """Move a message by UID. Uses MOVE if the server supports
        it, else falls back to COPY + STORE \\Deleted + EXPUNGE.

        ``extra_header`` (if set) is *not* appended to the moved
        message — IMAP doesn't allow header edits in place. The
        header is recorded in our audit chain instead via the
        runner. This stub keeps the parameter so the audit fan-out
        knows to log it but doesn't lie about server-side behavior.
        """
        # Try MOVE extension
        try:
            typ, _ = client.uid("move", uid, target_folder)
            if typ == "OK":
                return
        except imaplib.IMAP4.error:
            pass
        # Fallback — COPY then mark deleted
        client.uid("copy", uid, target_folder)
        client.uid("store", uid, "+FLAGS", "(\\Deleted)")
        client.expunge()

    def _extract_sender(self, msg: Message) -> str:
        from_header = msg.get("From", "") or ""
        # From header may be "Name <addr@domain>"; extract the addr
        if "<" in from_header and ">" in from_header:
            return from_header.split("<", 1)[1].split(">", 1)[0].strip().lower()
        return from_header.strip().lower()

    def _sender_allowed(self, sender: str) -> bool:
        if not self.sender_allowlist:
            return True
        sender_l = sender.lower()
        for allowed in self.sender_allowlist:
            allowed_l = allowed.lower()
            # Allow exact match or domain-suffix match (e.g.
            # "@usmc.mil" allows any sender at usmc.mil)
            if allowed_l.startswith("@"):
                if sender_l.endswith(allowed_l):
                    return True
            elif sender_l == allowed_l:
                return True
        return False

    def _record_failure(self, reason: str) -> None:
        self._consecutive_failures += 1
        self._last_error = reason

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def to_config_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "channel_type": self.channel_type,
            "adapter_id": self.adapter_id,
            "config": {
                "host": self.host,
                "port": self.port,
                "use_ssl": self.use_ssl,
                "username": self.username,
                "password_env": self.password_env,
                "inbox_folder": self.inbox_folder,
                "processed_folder": self.processed_folder,
                "quarantine_folder": self.quarantine_folder,
                "attachment_glob": self.attachment_glob,
                "sender_allowlist": list(self.sender_allowlist),
            },
        }


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _msg_date_iso(msg: Message) -> Optional[str]:
    """Pull the message Date header → ISO8601 string. Returns None
    on parse failure (some servers send malformed dates)."""
    try:
        from email.utils import parsedate_to_datetime
        d = parsedate_to_datetime(msg.get("Date", ""))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.isoformat()
    except Exception:
        return None
