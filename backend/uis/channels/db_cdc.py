"""DbCdcChannel — watermark-polling change data capture.

For source systems where SPIRE has direct read access to a
database, this channel polls a configured table on each cycle:

    SELECT * FROM <table>
    WHERE <watermark_column> > :watermark
    ORDER BY <watermark_column>
    LIMIT <max_rows>

Returned rows serialize to JSONL bytes and surface as one
PendingFile that flows through the pipeline + writer protocol
just like a CSV/SFTP/IMAP delivery would.

Why watermark polling, not log-based CDC
----------------------------------------
True CDC via replication logs (Oracle LogMiner, Postgres logical
slots) is more accurate but requires:
  * Privileged DB access SPIRE typically can't get on a real
    operational system without a long ATO conversation.
  * Per-DB mining infrastructure that's its own platform-team
    project.
  * Schema awareness inside the mining layer.

Watermark polling works against ANY database with an
``updated_at``-style column + a stable primary key. It's what
real DoD deployments use first; log-based CDC is a later
hardening if needed.

Drivers
-------
Late-bound by dialect string in the config:

  * ``sqlite``     — stdlib sqlite3 (works in tests, also for
                     small operational stores)
  * ``postgresql`` — psycopg (v3) or psycopg2
  * ``oracle``     — oracledb (replaces cx_Oracle)
  * ``mysql``      — mysql.connector or pymysql

If none of these import for the configured dialect, ``health()``
reports unreachable + last_error; the runner skips polls without
crashing.

Credentials
-----------
DSN is built from config + env-var resolved password (same model
as SFTP/IMAP). Config carries:
  - dialect, host, port, database, username
  - password_env (env-var name)
  - watermark_column, primary_key_columns
  - table (or full SELECT query in ``select_sql``)

Watermark state lives in a sidecar file just like HttpPollChannel.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from .base import ChannelHealth, IngestChannel, PendingFile


log = logging.getLogger(__name__)


@dataclass
class _CdcHandle:
    body: bytes
    row_count: int
    new_watermark: Optional[str] = None


@dataclass
class DbCdcChannel:
    """Polling CDC channel — emits one JSONL payload per cycle
    containing rows whose watermark column advanced since last poll.
    """

    channel_id: str
    adapter_id: str
    dialect: str                          # "sqlite" / "postgresql" / "oracle" / "mysql"
    table: str = ""                        # ignored if select_sql is set
    watermark_column: str = "updated_at"
    primary_key_columns: List[str] = field(default_factory=list)

    # Connection — at least one of (dsn, host+database) must be set.
    # SQLite uses ``database`` as the file path.
    dsn: str = ""
    host: str = ""
    port: int = 0
    database: str = ""
    username: str = ""
    password_env: str = ""

    # Tuning
    max_rows_per_poll: int = 10000
    select_sql: str = ""                   # custom query overrides table-based default
    extra_where: str = ""                  # appended to default SELECT

    # Watermark state
    watermark_state_path: str = ""
    initial_watermark: str = ""             # used when state file doesn't exist

    response_filename: str = ""

    channel_type: str = field(default="db_cdc", init=False)

    _last_polled_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_success_at: Optional[str] = field(default=None, init=False, repr=False)
    _last_error: Optional[str] = field(default=None, init=False, repr=False)
    _consecutive_failures: int = field(default=0, init=False, repr=False)

    # ------------------------------------------------------------------
    # IngestChannel interface
    # ------------------------------------------------------------------

    def list_pending(self) -> Iterable[PendingFile]:
        self._last_polled_at = _utc_iso()
        try:
            rows = self._execute_query()
        except Exception as e:
            self._record_failure(str(e))
            raise

        if not rows:
            return []

        # Serialize as JSONL — pipeline auto-detects it
        body_lines = []
        max_wm: Optional[str] = None
        for row in rows:
            body_lines.append(json.dumps(row, default=_json_default))
            wm = row.get(self.watermark_column)
            if wm is not None:
                wm_str = _stringify_watermark(wm)
                if max_wm is None or wm_str > max_wm:
                    max_wm = wm_str

        body = ("\n".join(body_lines) + "\n").encode("utf-8")
        filename = self.response_filename or _derive_filename(self)
        handle = _CdcHandle(
            body=body,
            row_count=len(rows),
            new_watermark=max_wm,
        )
        return [PendingFile(
            handle=handle,
            filename=filename,
            size_bytes=len(body),
            received_at=_utc_iso(),
        )]

    def fetch(self, pending: PendingFile) -> bytes:
        if not isinstance(pending.handle, _CdcHandle):
            raise TypeError(
                f"DbCdcChannel.fetch expected _CdcHandle, got {type(pending.handle)}"
            )
        return pending.handle.body

    def acknowledge(self, pending: PendingFile) -> None:
        handle: _CdcHandle = pending.handle
        if handle.new_watermark and self.watermark_state_path:
            try:
                Path(self.watermark_state_path).parent.mkdir(parents=True, exist_ok=True)
                with open(self.watermark_state_path, "w", encoding="utf-8") as f:
                    f.write(handle.new_watermark)
            except OSError as e:
                log.warning(
                    "DbCdcChannel %s: could not persist watermark: %s",
                    self.channel_id, e,
                )
        self._last_success_at = _utc_iso()
        self._consecutive_failures = 0
        self._last_error = None

    def quarantine(self, pending: PendingFile, reason: str) -> None:
        """Watermark does NOT advance on quarantine. Optionally
        dump the JSONL payload to disk for postmortem inspection."""
        handle: _CdcHandle = pending.handle
        if self.watermark_state_path:
            try:
                qdir = Path(self.watermark_state_path).parent / "quarantine"
                qdir.mkdir(parents=True, exist_ok=True)
                stamp = _utc_iso().replace(":", "").replace("-", "")
                payload = qdir / f"{stamp}_{pending.filename}"
                payload.write_bytes(handle.body)
                sidecar = payload.with_suffix(payload.suffix + ".reason.txt")
                sidecar.write_text(
                    f"channel: {self.channel_id}\n"
                    f"timestamp: {_utc_iso()}\n"
                    f"row_count: {handle.row_count}\n"
                    f"reason: {reason}\n",
                    encoding="utf-8",
                )
            except OSError as e:
                log.warning(
                    "DbCdcChannel %s: could not write quarantine artifacts: %s",
                    self.channel_id, e,
                )
        self._record_failure(reason)

    def health(self) -> ChannelHealth:
        reachable = False
        try:
            conn = self._connect()
            conn.close()
            reachable = True
        except Exception as e:
            self._last_error = str(e)
        return ChannelHealth(
            channel_id=self.channel_id,
            channel_type=self.channel_type,
            reachable=reachable,
            pending_count=None,
            last_polled_at=self._last_polled_at,
            last_success_at=self._last_success_at,
            last_error=self._last_error,
            consecutive_failures=self._consecutive_failures,
            extra={
                "dialect": self.dialect,
                "table": self.table,
                "host": self.host,
                "database": self.database,
            },
        )

    # ------------------------------------------------------------------
    # Driver dispatch + query execution
    # ------------------------------------------------------------------

    def _connect(self):
        d = self.dialect.lower()
        if d == "sqlite":
            import sqlite3
            path = self.dsn or self.database
            if not path:
                raise RuntimeError(
                    f"DbCdcChannel {self.channel_id}: sqlite needs database path"
                )
            return sqlite3.connect(path)
        if d in ("postgresql", "postgres"):
            return self._connect_postgresql()
        if d == "oracle":
            return self._connect_oracle()
        if d == "mysql":
            return self._connect_mysql()
        raise RuntimeError(
            f"DbCdcChannel {self.channel_id}: unsupported dialect {self.dialect!r}"
        )

    def _connect_postgresql(self):
        try:
            import psycopg  # type: ignore  # v3
            return psycopg.connect(
                host=self.host, port=self.port or 5432,
                dbname=self.database, user=self.username,
                password=self._resolved_password() or "",
            )
        except ImportError:
            try:
                import psycopg2  # type: ignore
                return psycopg2.connect(
                    host=self.host, port=self.port or 5432,
                    dbname=self.database, user=self.username,
                    password=self._resolved_password() or "",
                )
            except ImportError as e:
                raise RuntimeError(
                    "DbCdcChannel postgresql needs psycopg (v3) or psycopg2. "
                    "Install: pip install psycopg[binary]"
                ) from e

    def _connect_oracle(self):
        try:
            import oracledb  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "DbCdcChannel oracle needs oracledb. Install: pip install oracledb"
            ) from e
        return oracledb.connect(
            user=self.username,
            password=self._resolved_password() or "",
            dsn=self.dsn or f"{self.host}:{self.port or 1521}/{self.database}",
        )

    def _connect_mysql(self):
        try:
            import mysql.connector  # type: ignore
        except ImportError:
            try:
                import pymysql  # type: ignore
                return pymysql.connect(
                    host=self.host, port=self.port or 3306,
                    db=self.database, user=self.username,
                    password=self._resolved_password() or "",
                )
            except ImportError as e:
                raise RuntimeError(
                    "DbCdcChannel mysql needs mysql.connector or pymysql"
                ) from e
        return mysql.connector.connect(
            host=self.host, port=self.port or 3306,
            database=self.database, user=self.username,
            password=self._resolved_password() or "",
        )

    def _resolved_password(self) -> Optional[str]:
        if not self.password_env:
            return None
        pwd = os.environ.get(self.password_env)
        if pwd is None:
            raise RuntimeError(
                f"DbCdcChannel {self.channel_id}: password_env "
                f"{self.password_env!r} is unset."
            )
        return pwd

    def _execute_query(self) -> List[Dict[str, Any]]:
        """Run the watermark-bounded SELECT and return rows as
        list-of-dicts. SQLite path is the testable default; other
        dialects work the same with their respective drivers."""
        watermark = self._read_watermark()
        sql, params = self._build_query(watermark)

        conn = self._connect()
        try:
            cur = conn.cursor()
            cur.execute(sql, params)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = cur.fetchall()
            cur.close()
            return [dict(zip(cols, _normalize_row(r))) for r in rows]
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    def _build_query(self, watermark: str) -> tuple:
        """Construct the parameterized query.

        Custom ``select_sql`` is used as-is with one positional
        watermark parameter. The default builds::

            SELECT * FROM <table>
            WHERE <watermark_column> > ?
            [AND <extra_where>]
            ORDER BY <watermark_column>
            LIMIT <max>
        """
        if self.select_sql:
            sql = self.select_sql
            return sql, (watermark,)
        if not self.table:
            raise RuntimeError(
                f"DbCdcChannel {self.channel_id}: requires either table or select_sql"
            )
        # Validate identifiers — guard against SQL injection through
        # operator-supplied table/column names. Allowed: alphanumerics,
        # underscores, dots (for schema-qualified names).
        _validate_ident(self.table, "table")
        _validate_ident(self.watermark_column, "watermark_column")

        sql = (
            f"SELECT * FROM {self.table} "
            f"WHERE {self.watermark_column} > ? "
        )
        if self.extra_where:
            sql += f"AND ({self.extra_where}) "
        sql += (
            f"ORDER BY {self.watermark_column} "
            f"LIMIT {int(self.max_rows_per_poll)}"
        )
        return sql, (watermark,)

    def _read_watermark(self) -> str:
        if not self.watermark_state_path:
            return self.initial_watermark
        try:
            with open(self.watermark_state_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
                return content or self.initial_watermark
        except FileNotFoundError:
            return self.initial_watermark
        except OSError:
            return self.initial_watermark

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
                "dialect": self.dialect,
                "table": self.table,
                "watermark_column": self.watermark_column,
                "primary_key_columns": list(self.primary_key_columns),
                "dsn": self.dsn,
                "host": self.host,
                "port": self.port,
                "database": self.database,
                "username": self.username,
                "password_env": self.password_env,
                "max_rows_per_poll": self.max_rows_per_poll,
                "select_sql": self.select_sql,
                "extra_where": self.extra_where,
                "watermark_state_path": self.watermark_state_path,
                "initial_watermark": self.initial_watermark,
                "response_filename": self.response_filename,
            },
        }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _validate_ident(s: str, label: str) -> None:
    """Reject identifiers containing characters outside [A-Za-z0-9_.].

    Operator-supplied table + column names are interpolated into
    SQL (no parameterized way to do schema-name binding). Validate
    upfront so a malicious config can't inject ``foo; DROP TABLE…``.
    """
    import re
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_.]*$", s or ""):
        raise RuntimeError(
            f"DbCdcChannel: invalid {label} {s!r} — only alphanumerics, "
            "underscores, and dots allowed"
        )


def _stringify_watermark(value: Any) -> str:
    """Coerce a watermark value to a comparable string. Datetimes
    get ISO format; everything else `str()`."""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _json_default(o: Any) -> Any:
    """Default serializer for json.dumps — handles dates / datetimes
    + things sqlite returns as bytes."""
    if hasattr(o, "isoformat"):
        return o.isoformat()
    if isinstance(o, bytes):
        return o.decode("utf-8", errors="replace")
    return str(o)


def _normalize_row(row: Any) -> tuple:
    """sqlite3 returns Row objects; psycopg returns tuples;
    mysql.connector returns lists. Coerce to a plain tuple of
    Python primitives."""
    if hasattr(row, "keys"):  # sqlite3.Row, psycopg dict_row
        return tuple(row[k] for k in row.keys())
    return tuple(row)


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _derive_filename(channel) -> str:
    parts = [channel.dialect, channel.database or "default", channel.table or "query"]
    safe = [p.replace("/", "_").replace(":", "_").replace("\\", "_") for p in parts]
    return "_".join(filter(None, safe)) + ".jsonl"
