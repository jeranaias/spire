"""SFTPChannel — paramiko-backed SFTP polling.

Most common DoD operational delivery for batch logistics data.
DLA EMALL nightly drops, M-CARE readiness exports, GCSS-MC
out-of-band SFTP shares — all land here.

Layout on the remote side mirrors the FilesystemChannel:

    /<base>/incoming/        files awaiting pickup
    /<base>/processed/       consumed files (move on ack)
    /<base>/quarantine/      poison files + .reason.txt sidecar

State stays remote (file moves on the SFTP server) so SPIRE
restart doesn't re-process already-consumed files. If the remote
side doesn't allow moves, fall back to a local checkpoint
(``processed_handles_path`` config) — channel records consumed
remote paths in a local file and skips them on re-poll.

Credential model
----------------
Passwords and key passphrases are NEVER stored in SPIRE config
or SQLite. Config carries the *name* of the env var that holds
the secret (e.g. ``password_env="SPIRE_SFTP_DLA_PWD"``); the
channel resolves the actual value at fetch time. Keeps secrets
out of backups, exports, and audit logs.

Auth precedence:
  1. SSH key (path on disk + optional passphrase env var)
  2. Password from env var
  3. SSH agent (for hand-launched dev sessions)

Failure semantics
-----------------
Network errors raise during ``list_pending`` / ``fetch`` and the
runner catches them at the resilience layer (P4.3). The channel's
``health()`` carries the last error so an operator sees "host
unreachable since Tue 14:23" rather than silent stalls.
"""
from __future__ import annotations

import io
import json
import logging
import os
import socket
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, List, Optional

from .base import ChannelHealth, IngestChannel, PendingFile


log = logging.getLogger(__name__)


@dataclass
class SFTPChannel:
    """Polling channel for an SFTP share.

    Lazily constructs paramiko transport per poll cycle (no
    persistent connection — DoD operational SFTP servers
    typically have idle-disconnect policies, and a fresh
    connection per cycle keeps semantics simple).
    """

    channel_id: str
    adapter_id: str
    host: str
    username: str
    base_path: str
    port: int = 22
    glob: str = "*"
    # Auth — exactly one of these should be set per the precedence
    # rules in the module docstring. Empty means "unused"; runtime
    # surfaces an error during connect if all three are empty.
    key_path: str = ""
    key_passphrase_env: str = ""
    password_env: str = ""
    # Host key verification mode. "strict" = require host key in
    # known_hosts; "warn" = log on unknown host but accept (DoD
    # ATO will require strict). For first deployments / lab
    # bringup, "warn" is the friction-free default.
    host_key_policy: str = "warn"
    known_hosts_path: str = ""
    # When True the channel moves remote files on ack/quarantine.
    # When the remote SFTP user lacks move permission, set False
    # and the channel uses a local checkpoint file at
    # ``processed_handles_path`` to dedupe.
    remote_move_enabled: bool = True
    processed_handles_path: str = ""
    channel_type: str = field(default="sftp", init=False)

    _last_polled_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_success_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_error: Optional[str] = field(default=None, init=False, repr=False)
    _consecutive_failures: int = field(default=0, init=False, repr=False)
    _processed_cache: Optional[set] = field(default=None, init=False, repr=False)

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def _connect(self):
        """Open a fresh SFTP client. Caller must close it.

        Late-binds paramiko so the broader UIS package stays
        importable on hosts that don't have it (e.g. an extraction
        consumer who doesn't need SFTP).
        """
        try:
            import paramiko  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "SFTPChannel requires `paramiko`. Install it: pip install paramiko"
            ) from e

        client = paramiko.SSHClient()
        if self.host_key_policy == "strict":
            if self.known_hosts_path:
                client.load_host_keys(self.known_hosts_path)
            else:
                client.load_system_host_keys()
            client.set_missing_host_key_policy(paramiko.RejectPolicy())
        else:  # "warn"
            client.set_missing_host_key_policy(paramiko.WarningPolicy())

        connect_kwargs: dict = {
            "hostname": self.host,
            "port": self.port,
            "username": self.username,
            "timeout": 30,
            "allow_agent": True,
            "look_for_keys": True,
        }
        # P6.9 — secrets resolve through resolve_env_secret so a
        # value like ``vault://secret/spire/dla#password`` routes
        # to Vault automatically. Plain env values still work
        # unchanged for dev / pilot.
        from ..secrets import resolve_env_secret as _resolve
        if self.key_path:
            connect_kwargs["key_filename"] = self.key_path
            if self.key_passphrase_env:
                phrase = _resolve(self.key_passphrase_env)
                if phrase:
                    connect_kwargs["passphrase"] = phrase
        elif self.password_env:
            pwd = _resolve(self.password_env)
            if not pwd:
                raise RuntimeError(
                    f"SFTPChannel {self.channel_id}: password_env "
                    f"{self.password_env!r} is empty / unset."
                )
            connect_kwargs["password"] = pwd
            connect_kwargs["allow_agent"] = False
            connect_kwargs["look_for_keys"] = False
        # else: rely on SSH agent

        client.connect(**connect_kwargs)
        return client

    # ------------------------------------------------------------------
    # IngestChannel interface
    # ------------------------------------------------------------------

    def list_pending(self) -> Iterable[PendingFile]:
        self._last_polled_at = _utc_iso()
        try:
            client = self._connect()
        except Exception as e:
            self._record_failure(f"connect: {e}")
            raise
        try:
            sftp = client.open_sftp()
            incoming = _join(self.base_path, "incoming")
            try:
                entries = sftp.listdir_attr(incoming)
            except FileNotFoundError:
                # First poll — incoming/ may not exist yet
                self._ensure_remote_layout(sftp)
                entries = []
            processed = self._load_processed_handles()
            out: List[PendingFile] = []
            from fnmatch import fnmatch
            for attr in entries:
                name = attr.filename
                if not fnmatch(name, self.glob):
                    continue
                # Skip directories — paramiko sets st_mode bits
                import stat as _stat
                if _stat.S_ISDIR(attr.st_mode or 0):
                    continue
                remote_path = _join(incoming, name)
                if remote_path in processed:
                    continue
                out.append(PendingFile(
                    handle=remote_path,
                    filename=name,
                    size_bytes=attr.st_size,
                    received_at=datetime.fromtimestamp(
                        attr.st_mtime or 0, tz=timezone.utc,
                    ).isoformat() if attr.st_mtime else None,
                ))
            sftp.close()
            return out
        finally:
            client.close()

    def fetch(self, pending: PendingFile) -> bytes:
        try:
            client = self._connect()
        except Exception as e:
            self._record_failure(f"connect: {e}")
            raise
        try:
            sftp = client.open_sftp()
            try:
                buf = io.BytesIO()
                sftp.getfo(pending.handle, buf)
                return buf.getvalue()
            finally:
                sftp.close()
        except Exception as e:
            self._record_failure(f"fetch {pending.filename}: {e}")
            raise
        finally:
            client.close()

    def acknowledge(self, pending: PendingFile) -> None:
        if self.remote_move_enabled:
            self._remote_move_to(pending, "processed")
        else:
            # Local-checkpoint path: just record the remote handle
            # and let the next poll skip it.
            self._mark_processed(pending.handle)
        self._last_success_at = _utc_iso()
        self._consecutive_failures = 0
        self._last_error = None

    def quarantine(self, pending: PendingFile, reason: str) -> None:
        try:
            if self.remote_move_enabled:
                self._remote_move_to(pending, "quarantine", reason=reason)
            else:
                self._mark_processed(pending.handle, quarantine_reason=reason)
        except Exception as e:
            log.warning(
                "SFTPChannel %s: could not move %s to quarantine: %s",
                self.channel_id, pending.filename, e,
            )
        self._record_failure(reason)

    def health(self) -> ChannelHealth:
        reachable = False
        pending_count: Optional[int] = None
        try:
            # Cheap reachability probe — TCP connect only, no auth
            with socket.create_connection((self.host, self.port), timeout=5):
                reachable = True
            try:
                client = self._connect()
                try:
                    sftp = client.open_sftp()
                    incoming = _join(self.base_path, "incoming")
                    try:
                        entries = sftp.listdir(incoming)
                        pending_count = len(entries)
                    except FileNotFoundError:
                        pending_count = 0
                    sftp.close()
                finally:
                    client.close()
            except Exception as e:
                # Reachable but auth/path failed — surface as last_error
                self._last_error = str(e)
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
                "base_path": self.base_path,
                "remote_move_enabled": self.remote_move_enabled,
            },
        )

    # ------------------------------------------------------------------
    # Internal — remote-side ops
    # ------------------------------------------------------------------

    def _ensure_remote_layout(self, sftp) -> None:
        for sub in ("incoming", "processed", "quarantine"):
            path = _join(self.base_path, sub)
            try:
                sftp.stat(path)
            except FileNotFoundError:
                try:
                    sftp.mkdir(path)
                except Exception:
                    # Best-effort. The next poll will surface the error.
                    pass

    def _remote_move_to(
        self, pending: PendingFile, subdir: str, *, reason: Optional[str] = None,
    ) -> None:
        client = self._connect()
        try:
            sftp = client.open_sftp()
            self._ensure_remote_layout(sftp)
            target_dir = _join(self.base_path, subdir)
            target = _join(target_dir, pending.filename)
            target = self._unique_remote_target(sftp, target)
            try:
                sftp.rename(pending.handle, target)
            except OSError as e:
                # Some servers don't support rename across directories;
                # fall back to copy + delete.
                buf = io.BytesIO()
                sftp.getfo(pending.handle, buf)
                with sftp.open(target, "wb") as dst:
                    dst.write(buf.getvalue())
                sftp.remove(pending.handle)
                log.info(
                    "SFTPChannel %s: rename failed (%s); copy+delete fallback used.",
                    self.channel_id, e,
                )
            if reason:
                # Sidecar reason file alongside the quarantined item
                try:
                    sidecar = target + ".reason.txt"
                    payload = (
                        f"channel: {self.channel_id}\n"
                        f"timestamp: {_utc_iso()}\n"
                        f"reason: {reason}\n"
                    ).encode("utf-8")
                    with sftp.open(sidecar, "wb") as f:
                        f.write(payload)
                except Exception as e:
                    log.warning("Could not write quarantine sidecar: %s", e)
            sftp.close()
        finally:
            client.close()

    def _unique_remote_target(self, sftp, target: str) -> str:
        """If a same-name file already exists at target, append -2, -3..."""
        from posixpath import splitext
        try:
            sftp.stat(target)
        except FileNotFoundError:
            return target
        base, ext = splitext(target)
        n = 2
        while True:
            candidate = f"{base}-{n}{ext}"
            try:
                sftp.stat(candidate)
            except FileNotFoundError:
                return candidate
            n += 1

    # ------------------------------------------------------------------
    # Internal — local checkpoint (when remote moves are disabled)
    # ------------------------------------------------------------------

    def _load_processed_handles(self) -> set:
        if self.remote_move_enabled or not self.processed_handles_path:
            return set()
        if self._processed_cache is not None:
            return self._processed_cache
        try:
            with open(self.processed_handles_path, "r", encoding="utf-8") as f:
                self._processed_cache = set(
                    line.strip() for line in f if line.strip()
                )
        except FileNotFoundError:
            self._processed_cache = set()
        return self._processed_cache

    def _mark_processed(self, remote_path: str, *, quarantine_reason: str = "") -> None:
        if not self.processed_handles_path:
            return
        cache = self._load_processed_handles()
        cache.add(remote_path)
        try:
            line = remote_path
            if quarantine_reason:
                line += f"\t# QUARANTINE: {quarantine_reason}"
            with open(self.processed_handles_path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError as e:
            log.warning(
                "SFTPChannel %s: could not append to processed-handles file: %s",
                self.channel_id, e,
            )

    def _record_failure(self, reason: str) -> None:
        self._consecutive_failures += 1
        self._last_error = reason

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def to_config_dict(self) -> dict:
        """Serialize for the channel-config persistence layer.

        Secrets (password, key passphrase) are NEVER serialized —
        only the env-var names. Reconstructing the channel reads
        the env at connect time.
        """
        return {
            "channel_id": self.channel_id,
            "channel_type": self.channel_type,
            "adapter_id": self.adapter_id,
            "config": {
                "host": self.host,
                "port": self.port,
                "username": self.username,
                "base_path": self.base_path,
                "glob": self.glob,
                "key_path": self.key_path,
                "key_passphrase_env": self.key_passphrase_env,
                "password_env": self.password_env,
                "host_key_policy": self.host_key_policy,
                "known_hosts_path": self.known_hosts_path,
                "remote_move_enabled": self.remote_move_enabled,
                "processed_handles_path": self.processed_handles_path,
            },
        }


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _join(base: str, *parts: str) -> str:
    """POSIX path join — SFTP server paths are always forward-slash
    even on Windows hosts. ``os.path.join`` would corrupt them."""
    out = base.rstrip("/")
    for p in parts:
        if not p:
            continue
        out += "/" + p.lstrip("/")
    return out
