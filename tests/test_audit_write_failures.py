"""Audit-write failures surface instead of vanishing (WI-9 residual).

Deny paths guard their audit write so an audit outage cannot mask the 403 they
are in the middle of raising. That guard is correct and it is also how a broken
audit layer stays invisible for months. log_or_flag keeps the guard, counts the
failure, logs it loudly, and fails the request under the event profile.
"""
from __future__ import annotations

import logging

import pytest

from backend import persistence
from backend.routes.system import _audit_failure_summary


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    persistence.reset_audit_failures()
    monkeypatch.delenv("SPIRE_PROFILE", raising=False)
    yield
    persistence.reset_audit_failures()


def _break_the_chain(monkeypatch):
    def boom(*_a, **_kw):
        raise RuntimeError("audit table is gone")
    monkeypatch.setattr(persistence, "log", boom)


def test_a_healthy_write_is_not_counted():
    entry = persistence.log_or_flag("system_boot", actor="test", payload={"t": 1})
    assert entry["self_hash"]
    assert persistence.audit_failures()["count"] == 0


def test_failure_is_counted_and_logged_not_swallowed(monkeypatch, caplog):
    _break_the_chain(monkeypatch)
    with caplog.at_level(logging.ERROR):
        assert persistence.log_or_flag("role_denied", actor="test") is None
    failures = persistence.audit_failures()
    assert failures["count"] == 1
    assert failures["last_kind"] == "role_denied"
    assert "audit table is gone" in failures["last_error"]
    assert any("audit write failed" in r.message for r in caplog.records)


def test_event_profile_fails_closed(monkeypatch):
    _break_the_chain(monkeypatch)
    monkeypatch.setenv("SPIRE_PROFILE", "event")
    with pytest.raises(persistence.AuditWriteFailure):
        persistence.log_or_flag("role_denied", actor="test")
    # Still counted on the way out - the counter is not conditional on
    # whether anyone caught the exception.
    assert persistence.audit_failures()["count"] == 1


def test_status_surfaces_the_counter(monkeypatch):
    _break_the_chain(monkeypatch)
    persistence.log_or_flag("view_scope_denied", actor="test")
    summary = _audit_failure_summary()
    assert summary["count"] == 1
    assert summary["last_kind"] == "view_scope_denied"
    assert summary["last_at"].endswith("Z")
