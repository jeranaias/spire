"""DbCdcChannel tests against a real sqlite database.

sqlite is shipped with stdlib so these tests run without external
services. The same code paths (with different drivers) cover
Postgres / Oracle / MySQL — we don't reach for SQLAlchemy because
keeping DbCdcChannel driver-bare matches operational reality
(IL5 air-gapped installs prefer minimal deps).
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from backend.uis.channels import DbCdcChannel, IngestChannel


# ---------------------------------------------------------------------------
# Fixture — a populated sqlite source DB
# ---------------------------------------------------------------------------


@pytest.fixture
def source_db(tmp_path):
    """Create a tmp sqlite DB with a `srs` table populated with
    rows that have an `updated_at` watermark column."""
    db_path = tmp_path / "source.sqlite"
    conn = sqlite3.connect(str(db_path))
    conn.execute("""
        CREATE TABLE srs (
            sr_number TEXT PRIMARY KEY,
            status TEXT,
            priority TEXT,
            updated_at TEXT NOT NULL
        )
    """)
    conn.executemany(
        "INSERT INTO srs VALUES (?, ?, ?, ?)",
        [
            ("SR-1", "OPEN", "02", "2026-04-26T10:00:00Z"),
            ("SR-2", "OPEN", "03", "2026-04-26T11:00:00Z"),
            ("SR-3", "CLOSED", "02", "2026-04-26T12:00:00Z"),
        ],
    )
    conn.commit()
    conn.close()
    return db_path


# ---------------------------------------------------------------------------
# Construction + protocol
# ---------------------------------------------------------------------------


def test_db_cdc_satisfies_protocol(tmp_path):
    ch = DbCdcChannel(
        channel_id="t/db",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(tmp_path / "x.sqlite"),
        table="srs",
    )
    assert isinstance(ch, IngestChannel)
    assert ch.channel_type == "db_cdc"


def test_to_config_excludes_password(monkeypatch):
    monkeypatch.setenv("DBPWD", "secret-pwd-xyz")
    ch = DbCdcChannel(
        channel_id="t/db",
        adapter_id="x",
        dialect="postgresql",
        host="db.usmc.mil",
        username="spire",
        password_env="DBPWD",
        table="srs",
    )
    cfg = ch.to_config_dict()
    assert cfg["config"]["password_env"] == "DBPWD"
    assert "secret-pwd-xyz" not in str(cfg)


# ---------------------------------------------------------------------------
# Watermark polling — happy path
# ---------------------------------------------------------------------------


def test_first_poll_returns_all_rows_when_initial_watermark_empty(source_db, tmp_path):
    """Without a saved watermark + empty initial_watermark, the
    polling query returns everything past the empty string. SQLite
    string ordering puts the timestamp values after the empty
    string, so all 3 rows come back."""
    state = tmp_path / "wm.txt"
    ch = DbCdcChannel(
        channel_id="t/cdc",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
        watermark_column="updated_at",
        watermark_state_path=str(state),
    )
    pending = list(ch.list_pending())
    assert len(pending) == 1
    handle = pending[0].handle
    assert handle.row_count == 3
    body = ch.fetch(pending[0]).decode("utf-8").strip().split("\n")
    rows = [json.loads(line) for line in body]
    assert {r["sr_number"] for r in rows} == {"SR-1", "SR-2", "SR-3"}


def test_acknowledge_advances_watermark(source_db, tmp_path):
    state = tmp_path / "wm.txt"
    ch = DbCdcChannel(
        channel_id="t/cdc-ack",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
        watermark_column="updated_at",
        watermark_state_path=str(state),
    )
    pending = list(ch.list_pending())[0]
    ch.acknowledge(pending)
    saved = state.read_text(encoding="utf-8").strip()
    assert saved == "2026-04-26T12:00:00Z"  # max watermark seen


def test_subsequent_poll_uses_persisted_watermark(source_db, tmp_path):
    state = tmp_path / "wm.txt"
    state.write_text("2026-04-26T11:00:00Z", encoding="utf-8")
    ch = DbCdcChannel(
        channel_id="t/cdc-resume",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
        watermark_column="updated_at",
        watermark_state_path=str(state),
    )
    pending = list(ch.list_pending())
    # Only SR-3 (12:00) is past the 11:00 watermark
    assert pending[0].handle.row_count == 1
    rows = [json.loads(l) for l in pending[0].handle.body.decode().strip().split("\n")]
    assert rows[0]["sr_number"] == "SR-3"


def test_quarantine_does_not_advance_watermark(source_db, tmp_path):
    """Initial watermark behind everything → all 3 rows return.
    After quarantine, the saved watermark is unchanged so a
    retry sees the same delta."""
    state = tmp_path / "wm.txt"
    state.write_text("2020-01-01T00:00:00Z", encoding="utf-8")
    ch = DbCdcChannel(
        channel_id="t/cdc-noadv",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
        watermark_column="updated_at",
        watermark_state_path=str(state),
    )
    pending = list(ch.list_pending())[0]
    ch.quarantine(pending, "schema_drift_detected")
    assert state.read_text(encoding="utf-8").strip() == "2020-01-01T00:00:00Z"

    # And the body is dumped to quarantine/
    qdir = tmp_path / "quarantine"
    files = list(qdir.iterdir())
    sidecars = [f for f in files if f.name.endswith(".reason.txt")]
    assert sidecars
    assert "schema_drift_detected" in sidecars[0].read_text(encoding="utf-8")


def test_empty_result_yields_zero_pending(source_db, tmp_path):
    """No rows past the watermark → empty cycle, no PendingFile."""
    state = tmp_path / "wm.txt"
    state.write_text("9999-12-31T00:00:00Z", encoding="utf-8")
    ch = DbCdcChannel(
        channel_id="t/cdc-empty",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
        watermark_column="updated_at",
        watermark_state_path=str(state),
    )
    pending = list(ch.list_pending())
    assert pending == []


def test_max_rows_per_poll_limits_batch(source_db, tmp_path):
    state = tmp_path / "wm.txt"
    ch = DbCdcChannel(
        channel_id="t/cdc-cap",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
        watermark_column="updated_at",
        watermark_state_path=str(state),
        max_rows_per_poll=2,
    )
    pending = list(ch.list_pending())[0]
    assert pending.handle.row_count == 2


def test_extra_where_filter(source_db, tmp_path):
    state = tmp_path / "wm.txt"
    ch = DbCdcChannel(
        channel_id="t/cdc-where",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
        watermark_column="updated_at",
        watermark_state_path=str(state),
        extra_where="status = 'OPEN'",
    )
    pending = list(ch.list_pending())[0]
    rows = [json.loads(l) for l in pending.handle.body.decode().strip().split("\n")]
    assert all(r["status"] == "OPEN" for r in rows)
    assert len(rows) == 2  # SR-1, SR-2


def test_custom_select_sql(source_db, tmp_path):
    state = tmp_path / "wm.txt"
    ch = DbCdcChannel(
        channel_id="t/cdc-sql",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        watermark_column="updated_at",
        watermark_state_path=str(state),
        select_sql=(
            "SELECT sr_number, priority FROM srs "
            "WHERE updated_at > ? AND priority = '03' "
            "ORDER BY updated_at"
        ),
    )
    pending = list(ch.list_pending())
    assert len(pending) == 1
    rows = [json.loads(l) for l in pending[0].handle.body.decode().strip().split("\n")]
    assert len(rows) == 1
    assert rows[0]["sr_number"] == "SR-2"
    # Custom select projects only sr_number + priority
    assert "status" not in rows[0]


# ---------------------------------------------------------------------------
# Validation — reject SQL-injection attempts at construction time
# ---------------------------------------------------------------------------


def test_invalid_table_name_rejected(source_db, tmp_path):
    ch = DbCdcChannel(
        channel_id="t/inj",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs; DROP TABLE srs",
        watermark_column="updated_at",
    )
    with pytest.raises(RuntimeError, match="invalid table"):
        list(ch.list_pending())


def test_invalid_watermark_column_rejected(source_db):
    ch = DbCdcChannel(
        channel_id="t/inj2",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
        watermark_column="updated_at) OR (1=1",
    )
    with pytest.raises(RuntimeError, match="invalid watermark_column"):
        list(ch.list_pending())


# ---------------------------------------------------------------------------
# Driver dispatch + health
# ---------------------------------------------------------------------------


def test_health_reachable_for_valid_sqlite(source_db):
    ch = DbCdcChannel(
        channel_id="t/health",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
    )
    h = ch.health()
    assert h.reachable is True


def test_health_unreachable_for_missing_sqlite_path(tmp_path):
    ch = DbCdcChannel(
        channel_id="t/health2",
        adapter_id="gcss-mc/sr-header",
        dialect="sqlite",
        database=str(tmp_path / "nope" / "missing.sqlite"),
        table="srs",
    )
    h = ch.health()
    # sqlite3 will create the path on connect → reachable=True.
    # Test the truly-bad-path case — directory doesn't exist.
    # Actually sqlite creates the file but not parent dirs,
    # so this DOES fail.
    assert h.reachable is False


def test_unsupported_dialect_raises():
    ch = DbCdcChannel(
        channel_id="t/d",
        adapter_id="gcss-mc/sr-header",
        dialect="redshift",
        host="x", database="y", username="z",
        table="srs",
    )
    with pytest.raises(RuntimeError, match="unsupported dialect"):
        list(ch.list_pending())


def test_password_env_unset_raises_on_postgresql_path(monkeypatch):
    """A non-sqlite dialect with a configured password_env requires
    the env var. Sqlite doesn't trigger the password resolution
    path so this only fires for postgres/oracle/mysql."""
    monkeypatch.delenv("MISSING_PWD", raising=False)
    ch = DbCdcChannel(
        channel_id="t/auth",
        adapter_id="x",
        dialect="postgresql",
        host="h", database="d", username="u",
        password_env="MISSING_PWD",
        table="srs",
    )
    # We expect either a connect failure (driver not installed) OR
    # a RuntimeError about MISSING_PWD. Either is correct
    # depending on whether psycopg is installed in the test env.
    with pytest.raises(Exception) as exc:
        list(ch.list_pending())
    # The point: it doesn't silently swallow + return zero rows
    msg = str(exc.value).lower()
    assert "missing_pwd" in msg or "psycopg" in msg or "postgresql" in msg


# ---------------------------------------------------------------------------
# End-to-end: pipeline parses the JSONL the channel emits
# ---------------------------------------------------------------------------


def test_runner_processes_db_cdc_payload(source_db, tmp_path):
    """The CDC channel emits JSONL bytes; the pipeline auto-detects
    JSONL and parses through to canonical rows. End-to-end
    integration test — proves the channel + pipeline + writer
    triangle works for direct DB ingestion."""
    from backend.uis.channels import poll_channel, set_audit_func
    from backend.uis.adapters.spec import AdapterSpec, ColumnSpec
    from backend.uis.adapters import register_adapter

    captured = []
    set_audit_func(lambda **kw: captured.append(dict(kw)))

    # Register a one-off adapter targeting these rows
    test_spec = AdapterSpec(
        id="test/cdc-srs",
        target_entity="ServiceRequest",
        canonical_columns=[
            ColumnSpec("sr_number", required=True, source_aliases=["sr_number"]),
            ColumnSpec("priority", source_aliases=["priority"]),
        ],
    )
    register_adapter(test_spec)

    state = tmp_path / "wm.txt"
    ch = DbCdcChannel(
        channel_id="t/cdc-e2e",
        adapter_id="test/cdc-srs",
        dialect="sqlite",
        database=str(source_db),
        table="srs",
        watermark_column="updated_at",
        watermark_state_path=str(state),
    )
    result = poll_channel(ch)

    set_audit_func(lambda **kw: None)
    assert result.pending_count == 1
    fr = result.file_results[0]
    # No writer for "test/cdc-srs" → skipped, but pipeline parsed the rows
    assert fr.status == "skipped"
    assert fr.rows_kept == 3
