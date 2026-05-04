"""SQLite-backed CRUD for MappingProfile.

The profiles table lives alongside the audit log (same SQLite file).
Profiles are looked up at ingest time by (source_id, unit) — first
match wins. When a confirmed profile exists for a (source, unit)
pair, the pipeline skips the auto-mapper and uses the profile's
column_map directly.

API
---
    create_profile(profile)        → MappingProfile
    get_profile(profile_id)        → MappingProfile | None
    find_profile(source_id, unit)  → MappingProfile | None
    list_profiles(source_id=None)  → List[MappingProfile]
    update_profile(profile)        → MappingProfile
    delete_profile(profile_id)     → bool
"""
from __future__ import annotations

import json
from typing import List, Optional

from ...persistence import conn
from .profile import MappingProfile


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
