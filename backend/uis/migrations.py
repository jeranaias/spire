"""Schema migration helper for UIS SQLite tables.

The original ``ensure_schema`` calls were CREATE-only. Adding a
column to ``uis_channels`` or ``uis_mapping_profiles`` later
required manual SQLite surgery on every deployed instance.

This module provides a minimal migration runner. Each table
declares a list of ``(version, sql)`` tuples; ``apply_migrations``
runs the ones that haven't been applied yet, tracking applied
versions in a ``uis_schema_migrations`` table.

Constraints
-----------
SQLite's ALTER TABLE is limited — ADD COLUMN works; DROP/MODIFY
COLUMN don't. For destructive changes the migration must
recreate the table. The helper handles plain SQL statements
(CREATE / ALTER / INSERT) — anything more complex (data
backfill) goes in a separate Python migration that the operator
runs.

Migration ordering
------------------
Versions are applied in numeric order. If two migrations share
a version, behavior is undefined — keep them strictly increasing.
Applied versions are recorded immediately; a partial-failure mid-
batch leaves earlier successes recorded so the next run picks up
where the failure left off.
"""
from __future__ import annotations

import logging
import sqlite3
from typing import Callable, List, Tuple


log = logging.getLogger(__name__)


MIGRATION_TRACKING_SCHEMA = """
CREATE TABLE IF NOT EXISTS uis_schema_migrations (
    table_name TEXT NOT NULL,
    version    INTEGER NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (table_name, version)
)
"""


def apply_migrations(
    factory: Callable[[], sqlite3.Connection],
    table_name: str,
    migrations: List[Tuple[int, str]],
) -> List[int]:
    """Apply any pending migrations for ``table_name``.

    Returns the list of newly-applied versions (empty if all
    were already applied). ``factory()`` produces a SQLite
    connection — same factory pattern as mapping/store.py and
    channels/store.py.
    """
    if not migrations:
        return []
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    newly_applied: List[int] = []

    with factory() as conn:
        conn.execute(MIGRATION_TRACKING_SCHEMA)
        rows = conn.execute(
            "SELECT version FROM uis_schema_migrations WHERE table_name = ?",
            (table_name,),
        ).fetchall()
        applied = {r["version"] if hasattr(r, "keys") else r[0] for r in rows}

        # Apply in version order
        for version, sql in sorted(migrations, key=lambda x: x[0]):
            if version in applied:
                continue
            try:
                conn.executescript(sql)
                conn.execute(
                    "INSERT INTO uis_schema_migrations (table_name, version, applied_at) VALUES (?, ?, ?)",
                    (table_name, version, now),
                )
                conn.commit()
                newly_applied.append(version)
                log.info(
                    "uis_schema_migrations: applied %s v%d", table_name, version,
                )
            except sqlite3.OperationalError as e:
                # ALTER TABLE ADD COLUMN raises "duplicate column name"
                # if the column already exists — that's a recovery
                # path (operator manually added the column already).
                # Record the migration as applied so we don't keep
                # retrying.
                msg = str(e).lower()
                if "duplicate column" in msg:
                    conn.execute(
                        "INSERT INTO uis_schema_migrations (table_name, version, applied_at) VALUES (?, ?, ?)",
                        (table_name, version, now),
                    )
                    conn.commit()
                    log.info(
                        "uis_schema_migrations: %s v%d already applied (column exists)",
                        table_name, version,
                    )
                    continue
                # Anything else — partial state, raise so operator
                # sees the failure rather than silently masking it.
                raise

    return newly_applied


def applied_versions(
    factory: Callable[[], sqlite3.Connection],
    table_name: str,
) -> List[int]:
    """Inspect — return sorted list of versions already applied
    against ``table_name``."""
    with factory() as conn:
        conn.execute(MIGRATION_TRACKING_SCHEMA)
        rows = conn.execute(
            "SELECT version FROM uis_schema_migrations WHERE table_name = ? ORDER BY version",
            (table_name,),
        ).fetchall()
    return [r["version"] if hasattr(r, "keys") else r[0] for r in rows]
