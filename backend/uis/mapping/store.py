"""SQLite-backed CRUD for MappingProfile.

Module is import-safe and standalone: it does NOT couple to the
parent backend.persistence module. Callers either accept the
default connection factory (which lazily delegates to
backend.persistence.conn for the SPIRE deployment) or inject
their own via `set_connection_factory`. An open-source consumer
extracting just the UIS package can pass a sqlite3.connect()
callable and the rest of the module Just Works.

API
---
    create_profile(profile)        → MappingProfile
    get_profile(profile_id)        → MappingProfile | None
    find_profile(source_id, unit)  → MappingProfile | None
    list_profiles(source_id=None)  → List[MappingProfile]
    update_profile(profile)        → MappingProfile
    delete_profile(profile_id)     → bool

For module extraction
---------------------
    from backend.uis.mapping.store import set_connection_factory, ensure_schema
    set_connection_factory(my_conn_factory)
    ensure_schema()  # CREATE TABLE IF NOT EXISTS

That's the entire integration surface.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from typing import Callable, ContextManager, List, Optional

from .profile import MappingProfile


# Connection factory — a callable returning a context manager that
# yields a sqlite3 connection. Defaults to a lazy delegate to
# backend.persistence.conn for the in-tree SPIRE deployment;
# callers can override via set_connection_factory().
ConnectionFactory = Callable[[], ContextManager[sqlite3.Connection]]


def _default_connection_factory():  # pragma: no cover — wired in production only
    from ...persistence import conn  # late-bound to avoid coupling at import time
    return conn()


_connection_factory: ConnectionFactory = _default_connection_factory


def set_connection_factory(factory: ConnectionFactory) -> None:
    """Install a custom connection factory for embedded / extracted use.

    The factory must yield a sqlite3.Connection from a context
    manager (so `with factory() as c: ...` works). Schema is the
    caller's responsibility — call `ensure_schema()` once at
    startup if you're not inheriting backend.persistence.init_db.

    Use `reset_connection_factory()` to restore the in-tree default
    (lazy delegate to backend.persistence.conn).
    """
    global _connection_factory
    _connection_factory = factory


def reset_connection_factory() -> None:
    """Restore the default connection factory (lazy delegate to
    backend.persistence.conn). Useful in tests that have set a
    custom factory and want to reset state for the next test."""
    global _connection_factory
    _connection_factory = _default_connection_factory


def conn() -> ContextManager[sqlite3.Connection]:
    """Internal: open a connection via the active factory."""
    return _connection_factory()


# Schema for the uis_mapping_profiles table — same SQL as in
# backend/persistence.py SCHEMA constant. Duplicated here so the
# extracted package can `ensure_schema()` against an arbitrary
# SQLite file without backend.persistence.
PROFILES_SCHEMA = """
CREATE TABLE IF NOT EXISTS uis_mapping_profiles (
    profile_id      TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL,
    unit            TEXT,
    source_version  TEXT,
    column_map_json TEXT NOT NULL,
    cell_transforms_json TEXT NOT NULL DEFAULT '{}',
    operator_notes  TEXT NOT NULL DEFAULT '',
    created_by      TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    confirmed_at    TEXT,
    confidence      REAL NOT NULL DEFAULT 1.0
);
CREATE INDEX IF NOT EXISTS idx_uis_profiles_source ON uis_mapping_profiles(source_id);
CREATE INDEX IF NOT EXISTS idx_uis_profiles_unit ON uis_mapping_profiles(unit);
"""


def ensure_schema() -> None:
    """Apply the profiles schema. Idempotent. Call once at startup
    if you're using the UIS package outside of backend/."""
    with conn() as c:
        c.executescript(PROFILES_SCHEMA)


def _row_to_profile(row) -> MappingProfile:
    return MappingProfile(
        profile_id=row["profile_id"],
        source_id=row["source_id"],
        unit=row["unit"],
        source_version=row["source_version"],
        column_map=json.loads(row["column_map_json"]),
        cell_transforms=json.loads(row["cell_transforms_json"] or "{}"),
        operator_notes=row["operator_notes"] or "",
        created_by=row["created_by"] or "",
        created_at=row["created_at"],
        confirmed_at=row["confirmed_at"],
        confidence=float(row["confidence"]),
    )


def create_profile(profile: MappingProfile) -> MappingProfile:
    """Insert a new profile. Raises if profile_id collides."""
    with conn() as c:
        c.execute(
            """
            INSERT INTO uis_mapping_profiles (
                profile_id, source_id, unit, source_version,
                column_map_json, cell_transforms_json,
                operator_notes, created_by, created_at,
                confirmed_at, confidence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                profile.profile_id,
                profile.source_id,
                profile.unit,
                profile.source_version,
                json.dumps(profile.column_map, sort_keys=True),
                json.dumps(profile.cell_transforms, sort_keys=True),
                profile.operator_notes,
                profile.created_by,
                profile.created_at,
                profile.confirmed_at,
                profile.confidence,
            ),
        )
    return profile


def get_profile(profile_id: str) -> Optional[MappingProfile]:
    with conn() as c:
        row = c.execute(
            "SELECT * FROM uis_mapping_profiles WHERE profile_id = ?",
            (profile_id,),
        ).fetchone()
    return _row_to_profile(row) if row else None


def find_profile(source_id: str, unit: Optional[str] = None) -> Optional[MappingProfile]:
    """Return the most-specific matching profile.

    Lookup order: (source_id, unit) → (source_id, NULL unit). Most
    recent confirmed profile wins on ties.
    """
    with conn() as c:
        if unit:
            row = c.execute(
                """
                SELECT * FROM uis_mapping_profiles
                WHERE source_id = ? AND unit = ? AND confirmed_at IS NOT NULL
                ORDER BY confirmed_at DESC, profile_id ASC LIMIT 1
                """,
                (source_id, unit),
            ).fetchone()
            if row:
                return _row_to_profile(row)
        row = c.execute(
            """
            SELECT * FROM uis_mapping_profiles
            WHERE source_id = ? AND (unit IS NULL OR unit = '') AND confirmed_at IS NOT NULL
            ORDER BY confirmed_at DESC, profile_id ASC LIMIT 1
            """,
            (source_id,),
        ).fetchone()
    return _row_to_profile(row) if row else None


def list_profiles(source_id: Optional[str] = None) -> List[MappingProfile]:
    with conn() as c:
        if source_id:
            rows = c.execute(
                "SELECT * FROM uis_mapping_profiles WHERE source_id = ? ORDER BY created_at DESC",
                (source_id,),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM uis_mapping_profiles ORDER BY created_at DESC"
            ).fetchall()
    return [_row_to_profile(r) for r in rows]


def update_profile(profile: MappingProfile) -> MappingProfile:
    """Update an existing profile. Raises if profile_id is absent."""
    with conn() as c:
        cur = c.execute(
            """
            UPDATE uis_mapping_profiles
            SET source_id = ?, unit = ?, source_version = ?,
                column_map_json = ?, cell_transforms_json = ?,
                operator_notes = ?, created_by = ?, created_at = ?,
                confirmed_at = ?, confidence = ?
            WHERE profile_id = ?
            """,
            (
                profile.source_id,
                profile.unit,
                profile.source_version,
                json.dumps(profile.column_map, sort_keys=True),
                json.dumps(profile.cell_transforms, sort_keys=True),
                profile.operator_notes,
                profile.created_by,
                profile.created_at,
                profile.confirmed_at,
                profile.confidence,
                profile.profile_id,
            ),
        )
        if cur.rowcount == 0:
            raise KeyError(f"No profile with id {profile.profile_id!r}")
    return profile


def delete_profile(profile_id: str) -> bool:
    with conn() as c:
        cur = c.execute(
            "DELETE FROM uis_mapping_profiles WHERE profile_id = ?",
            (profile_id,),
        )
    return cur.rowcount > 0
