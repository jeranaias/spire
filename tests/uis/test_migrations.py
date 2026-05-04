"""Schema migration framework tests."""
from __future__ import annotations

import sqlite3

import pytest

from backend.uis.migrations import apply_migrations, applied_versions


@pytest.fixture
def db_factory(tmp_path):
    """Returns a SQLite connection factory pointed at a tmp DB."""
    db_path = tmp_path / "test.sqlite"

    def factory():
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        return conn

    # Seed a base table the tests will mutate
    with factory() as c:
        c.execute("CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)")
        c.commit()

    return factory


def test_apply_first_run_runs_all_migrations(db_factory):
    migs = [
        (2, "ALTER TABLE widgets ADD COLUMN color TEXT NOT NULL DEFAULT 'gray'"),
        (3, "ALTER TABLE widgets ADD COLUMN size INTEGER NOT NULL DEFAULT 0"),
    ]
    applied = apply_migrations(db_factory, "widgets", migs)
    assert applied == [2, 3]
    # Both columns now exist
    with db_factory() as c:
        cols = [r[1] for r in c.execute("PRAGMA table_info(widgets)").fetchall()]
    assert "color" in cols
    assert "size" in cols


def test_apply_idempotent_on_second_run(db_factory):
    migs = [
        (2, "ALTER TABLE widgets ADD COLUMN color TEXT"),
    ]
    apply_migrations(db_factory, "widgets", migs)
    # Second run — nothing new
    applied2 = apply_migrations(db_factory, "widgets", migs)
    assert applied2 == []


def test_new_migration_added_later_is_picked_up(db_factory):
    initial = [(2, "ALTER TABLE widgets ADD COLUMN color TEXT")]
    apply_migrations(db_factory, "widgets", initial)

    # Operator adds a new migration in code; redeploys
    extended = initial + [
        (3, "ALTER TABLE widgets ADD COLUMN size INTEGER NOT NULL DEFAULT 0"),
    ]
    applied = apply_migrations(db_factory, "widgets", extended)
    assert applied == [3]


def test_versions_applied_in_order(db_factory):
    """Even when caller passes them out of order, migrations
    apply in version order."""
    migs = [
        (3, "ALTER TABLE widgets ADD COLUMN c TEXT"),
        (2, "ALTER TABLE widgets ADD COLUMN b TEXT"),
        (4, "ALTER TABLE widgets ADD COLUMN d TEXT"),
    ]
    applied = apply_migrations(db_factory, "widgets", migs)
    assert applied == [2, 3, 4]


def test_duplicate_column_already_exists_is_recorded_not_retried(db_factory):
    """Operator may have manually added a column; the migration
    runner should record the version as applied so the next
    redeploy doesn't retry forever."""
    # Manually add a column
    with db_factory() as c:
        c.execute("ALTER TABLE widgets ADD COLUMN flag INTEGER")
        c.commit()

    migs = [(2, "ALTER TABLE widgets ADD COLUMN flag INTEGER")]
    applied = apply_migrations(db_factory, "widgets", migs)
    # Recorded as applied even though the SQL would have raised
    assert applied_versions(db_factory, "widgets") == [2]
    # And subsequent runs don't retry
    applied2 = apply_migrations(db_factory, "widgets", migs)
    assert applied2 == []


def test_migration_failure_partial_state_leaves_earlier_recorded(db_factory):
    """v2 succeeds, v3 fails (real syntax error) — v2 stays
    recorded so a re-run picks up at v3 with the operator's fix."""
    migs = [
        (2, "ALTER TABLE widgets ADD COLUMN ok TEXT"),
        (3, "THIS IS NOT VALID SQL"),
    ]
    with pytest.raises(sqlite3.OperationalError):
        apply_migrations(db_factory, "widgets", migs)
    # v2 was recorded before v3 blew up
    assert applied_versions(db_factory, "widgets") == [2]


def test_empty_migrations_list_is_noop(db_factory):
    assert apply_migrations(db_factory, "widgets", []) == []


def test_applied_versions_returns_sorted(db_factory):
    apply_migrations(db_factory, "widgets", [
        (4, "ALTER TABLE widgets ADD COLUMN d TEXT"),
        (2, "ALTER TABLE widgets ADD COLUMN b TEXT"),
        (3, "ALTER TABLE widgets ADD COLUMN c TEXT"),
    ])
    assert applied_versions(db_factory, "widgets") == [2, 3, 4]


def test_migrations_isolated_per_table_name(db_factory):
    """Two tables can share version numbers without cross-talk."""
    with db_factory() as c:
        c.execute("CREATE TABLE other (id INTEGER PRIMARY KEY)")
        c.commit()

    apply_migrations(db_factory, "widgets", [
        (1, "ALTER TABLE widgets ADD COLUMN x TEXT"),
    ])
    apply_migrations(db_factory, "other", [
        (1, "ALTER TABLE other ADD COLUMN y TEXT"),
    ])
    assert applied_versions(db_factory, "widgets") == [1]
    assert applied_versions(db_factory, "other") == [1]
