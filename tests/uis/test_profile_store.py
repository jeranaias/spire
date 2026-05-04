"""UIS MappingProfile persistence — SQLite CRUD."""
from __future__ import annotations

import os
import tempfile
from datetime import datetime, timezone

import pytest


@pytest.fixture
def tmp_db(monkeypatch, tmp_path):
    """Point persistence at a fresh SQLite file per test so the
    profile table starts clean and tests don't bleed into each
    other or into the live audit log.

    The persistence module hardcodes DB_PATH at import time, so we
    monkeypatch the constant + clear any module-level state, then
    re-init the schema."""
    db_file = tmp_path / "test.sqlite"
    from backend import persistence
    monkeypatch.setattr(persistence, "DB_PATH", db_file)
    monkeypatch.setattr(persistence, "_DB_PASSPHRASE", None)
    persistence.init_db()
    yield str(db_file)


def _sample_profile(profile_id="3d-mlr/gcss-mc-ecp/v1", unit="3d MLR"):
    from backend.uis.mapping.profile import MappingProfile
    return MappingProfile(
        profile_id=profile_id,
        source_id="gcss-mc/ecp",
        unit=unit,
        source_version="2026-04",
        column_map={"TAMCN_Code": "tamcn", "SerialNum": "serial_number"},
        cell_transforms={},
        operator_notes="3d MLR's variant — TAMCN comes with _Code suffix",
        created_by="3456789012",
        confirmed_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        confidence=1.0,
    )


def test_create_then_get_round_trip(tmp_db):
    from backend.uis.mapping import create_profile, get_profile

    created = create_profile(_sample_profile())
    fetched = get_profile(created.profile_id)
    assert fetched is not None
    assert fetched.profile_id == created.profile_id
    assert fetched.column_map == created.column_map
    assert fetched.unit == "3d MLR"
    assert fetched.source_version == "2026-04"
    assert fetched.confidence == 1.0


def test_get_unknown_returns_none(tmp_db):
    from backend.uis.mapping import get_profile
    assert get_profile("does-not-exist") is None


def test_create_duplicate_id_raises(tmp_db):
    from backend.uis.mapping import create_profile
    create_profile(_sample_profile())
    with pytest.raises(Exception):  # sqlite3.IntegrityError
        create_profile(_sample_profile())


def test_list_filters_by_source(tmp_db):
    from backend.uis.mapping import create_profile, list_profiles

    create_profile(_sample_profile(profile_id="a/ecp/v1"))
    create_profile(_sample_profile(profile_id="b/ecp/v1", unit="2d MLG"))
    util = _sample_profile(profile_id="a/util/v1")
    util.source_id = "gcss-mc/util"
    create_profile(util)

    all_profiles = list_profiles()
    assert len(all_profiles) == 3

    ecp_only = list_profiles(source_id="gcss-mc/ecp")
    assert len(ecp_only) == 2
    assert all(p.source_id == "gcss-mc/ecp" for p in ecp_only)


def test_find_unit_specific_wins_over_fleetwide(tmp_db):
    from backend.uis.mapping import create_profile, find_profile

    fleetwide = _sample_profile(profile_id="fleet/ecp/v1", unit=None)
    create_profile(fleetwide)
    unit_specific = _sample_profile(profile_id="3d-mlr/ecp/v1", unit="3d MLR")
    create_profile(unit_specific)

    found = find_profile(source_id="gcss-mc/ecp", unit="3d MLR")
    assert found is not None
    assert found.profile_id == "3d-mlr/ecp/v1"


def test_find_falls_back_to_fleetwide_when_no_unit_match(tmp_db):
    from backend.uis.mapping import create_profile, find_profile

    fleetwide = _sample_profile(profile_id="fleet/ecp/v1", unit=None)
    create_profile(fleetwide)

    # 7th ESB has no unit-specific profile, so the fleetwide one wins.
    found = find_profile(source_id="gcss-mc/ecp", unit="7th ESB")
    assert found is not None
    assert found.profile_id == "fleet/ecp/v1"


def test_find_returns_none_if_not_confirmed(tmp_db):
    """Unconfirmed (draft) profiles don't get auto-applied at ingest time."""
    from backend.uis.mapping import create_profile, find_profile

    draft = _sample_profile(profile_id="draft/ecp/v1")
    draft.confirmed_at = None  # explicitly unconfirmed
    create_profile(draft)

    found = find_profile(source_id="gcss-mc/ecp", unit="3d MLR")
    assert found is None


def test_update_profile(tmp_db):
    from backend.uis.mapping import create_profile, get_profile, update_profile

    p = create_profile(_sample_profile())
    p.column_map["NEW_COL"] = "nomenclature"
    p.operator_notes = "edited"
    update_profile(p)

    refetched = get_profile(p.profile_id)
    assert refetched.column_map.get("NEW_COL") == "nomenclature"
    assert refetched.operator_notes == "edited"


def test_update_unknown_raises(tmp_db):
    from backend.uis.mapping import update_profile
    p = _sample_profile(profile_id="ghost")
    with pytest.raises(KeyError):
        update_profile(p)


def test_delete_profile(tmp_db):
    from backend.uis.mapping import create_profile, delete_profile, get_profile

    p = create_profile(_sample_profile())
    assert delete_profile(p.profile_id) is True
    assert get_profile(p.profile_id) is None


def test_delete_unknown_returns_false(tmp_db):
    from backend.uis.mapping import delete_profile
    assert delete_profile("nope") is False


def test_find_profile_deterministic_on_same_second_confirmation(tmp_db):
    """Two profiles for the same (source, unit) confirmed in the
    same second must resolve deterministically. Without an explicit
    secondary sort key the SQLite output order on a tie is
    implementation-defined — risky for a value the apply path
    depends on."""
    from backend.uis.mapping import create_profile, find_profile

    same_ts = "2026-05-03T10:00:00+00:00"
    p_a = _sample_profile(profile_id="aaa/ecp/v1")
    p_a.confirmed_at = same_ts
    create_profile(p_a)

    p_b = _sample_profile(profile_id="bbb/ecp/v1")
    p_b.confirmed_at = same_ts
    create_profile(p_b)

    # find_profile must return the same profile every call. ASC
    # secondary sort means "aaa/ecp/v1" wins.
    found1 = find_profile(source_id="gcss-mc/ecp", unit="3d MLR")
    found2 = find_profile(source_id="gcss-mc/ecp", unit="3d MLR")
    assert found1 is not None
    assert found1.profile_id == found2.profile_id == "aaa/ecp/v1"
