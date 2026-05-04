"""Channel-config persistence.

Channels survive process restart through a SQLite-backed config
store. Same connection-factory pattern as ``uis/mapping/store.py``
so the channels package stays extractable without coupling to
backend.persistence.

Schema
------
``uis_channels`` table::

    channel_id       TEXT PRIMARY KEY
    channel_type     TEXT NOT NULL          -- "filesystem" / "sftp" / "imap" / "http_poll"
    adapter_id       TEXT NOT NULL
    config_json      TEXT NOT NULL
    enabled          INTEGER NOT NULL DEFAULT 1
    poll_interval_seconds INTEGER NOT NULL DEFAULT 300
    created_at       TEXT
    updated_at       TEXT

Secrets are NEVER stored here — config_json carries env-var names
only (password_env, key_passphrase_env). The channel resolves the
actual secret at connect time.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional


CHANNELS_SCHEMA = """
CREATE TABLE IF NOT EXISTS uis_channels (
    channel_id            TEXT PRIMARY KEY,
    channel_type          TEXT NOT NULL,
    adapter_id            TEXT NOT NULL,
    config_json           TEXT NOT NULL,
    enabled               INTEGER NOT NULL DEFAULT 1,
    poll_interval_seconds INTEGER NOT NULL DEFAULT 300,
    created_at            TEXT,
    updated_at            TEXT
)
"""


@dataclass
class ChannelConfig:
    """Persisted channel-config row.

    ``config`` is a free-form dict whose shape depends on
    ``channel_type``. Each channel class validates its own config
    on construction. Passwords / passphrases are NEVER in this
    dict — only env-var names.
    """

    channel_id: str
    channel_type: str
    adapter_id: str
    config: Dict[str, Any] = field(default_factory=dict)
    enabled: bool = True
    poll_interval_seconds: int = 300
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


# ---------------------------------------------------------------------------
# Connection factory — mirrors uis/mapping/store.py for modularity
# ---------------------------------------------------------------------------


ConnectionFactory = Callable[[], sqlite3.Connection]


def _default_connection_factory() -> sqlite3.Connection:
    """Default: route through backend.persistence."""
    from ...persistence import conn  # late-bind
    return conn()


_factory: ConnectionFactory = _default_connection_factory


def set_connection_factory(factory: ConnectionFactory) -> None:
    """Override the SQLite connection source. Used by tests + by
    extraction consumers who supply their own DB."""
    global _factory
    _factory = factory


def reset_connection_factory() -> None:
    global _factory
    _factory = _default_connection_factory


def ensure_schema() -> None:
    """Create the uis_channels table if it doesn't exist."""
    with _factory() as c:
        c.execute(CHANNELS_SCHEMA)
        c.commit()


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def create_channel_config(cfg: ChannelConfig) -> None:
    ensure_schema()
    now = _utc_iso()
    cfg.created_at = cfg.created_at or now
    cfg.updated_at = now
    with _factory() as c:
        c.execute(
            """
            INSERT INTO uis_channels (
                channel_id, channel_type, adapter_id, config_json,
                enabled, poll_interval_seconds, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                cfg.channel_id,
                cfg.channel_type,
                cfg.adapter_id,
                json.dumps(cfg.config, sort_keys=True),
                1 if cfg.enabled else 0,
                cfg.poll_interval_seconds,
                cfg.created_at,
                cfg.updated_at,
            ),
        )
        c.commit()


def update_channel_config(cfg: ChannelConfig) -> None:
    ensure_schema()
    cfg.updated_at = _utc_iso()
    with _factory() as c:
        c.execute(
            """
            UPDATE uis_channels SET
                channel_type = ?,
                adapter_id = ?,
                config_json = ?,
                enabled = ?,
                poll_interval_seconds = ?,
                updated_at = ?
            WHERE channel_id = ?
            """,
            (
                cfg.channel_type,
                cfg.adapter_id,
                json.dumps(cfg.config, sort_keys=True),
                1 if cfg.enabled else 0,
                cfg.poll_interval_seconds,
                cfg.updated_at,
                cfg.channel_id,
            ),
        )
        c.commit()


def get_channel_config(channel_id: str) -> Optional[ChannelConfig]:
    ensure_schema()
    with _factory() as c:
        row = c.execute(
            "SELECT * FROM uis_channels WHERE channel_id = ?",
            (channel_id,),
        ).fetchone()
    if row is None:
        return None
    return _row_to_config(row)


def list_channel_configs(*, enabled_only: bool = False) -> List[ChannelConfig]:
    ensure_schema()
    sql = "SELECT * FROM uis_channels"
    if enabled_only:
        sql += " WHERE enabled = 1"
    sql += " ORDER BY channel_id"
    with _factory() as c:
        rows = c.execute(sql).fetchall()
    return [_row_to_config(r) for r in rows]


def delete_channel_config(channel_id: str) -> bool:
    ensure_schema()
    with _factory() as c:
        cur = c.execute(
            "DELETE FROM uis_channels WHERE channel_id = ?",
            (channel_id,),
        )
        c.commit()
        return cur.rowcount > 0


def _row_to_config(row: Any) -> ChannelConfig:
    return ChannelConfig(
        channel_id=row["channel_id"],
        channel_type=row["channel_type"],
        adapter_id=row["adapter_id"],
        config=json.loads(row["config_json"] or "{}"),
        enabled=bool(row["enabled"]),
        poll_interval_seconds=row["poll_interval_seconds"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


# ---------------------------------------------------------------------------
# Channel reconstruction from persisted config
# ---------------------------------------------------------------------------


def build_channel(cfg: ChannelConfig):
    """Reconstruct a typed IngestChannel instance from a persisted
    config row.

    Adding a new channel type:
      1. Create the channel class implementing IngestChannel.
      2. Add a branch here mapping ``channel_type`` → constructor.
      3. Add an import to channels/__init__.py.
    """
    from .filesystem import FilesystemChannel
    from .http_poll import HttpPollChannel
    from .imap import IMAPChannel
    from .sftp import SFTPChannel

    common = {
        "channel_id": cfg.channel_id,
        "adapter_id": cfg.adapter_id,
    }
    c = cfg.config

    if cfg.channel_type == "filesystem":
        return FilesystemChannel(
            **common,
            root=c["root"],
            glob=c.get("glob", "*"),
            stability_seconds=int(c.get("stability_seconds", 5)),
        )
    if cfg.channel_type == "sftp":
        return SFTPChannel(
            **common,
            host=c["host"],
            username=c["username"],
            base_path=c["base_path"],
            port=int(c.get("port", 22)),
            glob=c.get("glob", "*"),
            key_path=c.get("key_path", ""),
            key_passphrase_env=c.get("key_passphrase_env", ""),
            password_env=c.get("password_env", ""),
            host_key_policy=c.get("host_key_policy", "warn"),
            known_hosts_path=c.get("known_hosts_path", ""),
            remote_move_enabled=bool(c.get("remote_move_enabled", True)),
            processed_handles_path=c.get("processed_handles_path", ""),
        )
    if cfg.channel_type == "imap":
        return IMAPChannel(
            **common,
            host=c["host"],
            username=c["username"],
            password_env=c["password_env"],
            inbox_folder=c.get("inbox_folder", "INBOX"),
            processed_folder=c.get("processed_folder"),
            quarantine_folder=c.get("quarantine_folder"),
            port=int(c.get("port", 993)),
            use_ssl=bool(c.get("use_ssl", True)),
            attachment_glob=c.get("attachment_glob", "*"),
            sender_allowlist=list(c.get("sender_allowlist", [])),
        )
    if cfg.channel_type == "http_poll":
        return HttpPollChannel(
            **common,
            url=c["url"],
            method=c.get("method", "GET"),
            bearer_token_env=c.get("bearer_token_env", ""),
            basic_auth_username=c.get("basic_auth_username", ""),
            basic_auth_password_env=c.get("basic_auth_password_env", ""),
            mtls_cert_path=c.get("mtls_cert_path", ""),
            mtls_key_path=c.get("mtls_key_path", ""),
            soap_action=c.get("soap_action", ""),
            request_body=c.get("request_body", ""),
            content_type=c.get("content_type", ""),
            headers=dict(c.get("headers", {}) or {}),
            watermark_param=c.get("watermark_param", ""),
            watermark_header=c.get("watermark_header", ""),
            watermark_jsonpath=c.get("watermark_jsonpath", ""),
            watermark_state_path=c.get("watermark_state_path", ""),
            verify_tls=bool(c.get("verify_tls", True)),
            ca_bundle_path=c.get("ca_bundle_path", ""),
            timeout_seconds=float(c.get("timeout_seconds", 30.0)),
            response_filename=c.get("response_filename", ""),
        )
    raise ValueError(
        f"Unknown channel_type {cfg.channel_type!r} for channel {cfg.channel_id!r}"
    )
