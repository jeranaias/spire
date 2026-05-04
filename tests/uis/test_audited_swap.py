"""Two-phase audited_swap context manager tests."""
from __future__ import annotations

from typing import List

import pytest

from backend.uis.audited_swap import (
    audited_swap,
    find_orphaned_attempts,
    set_audit_func,
)


@pytest.fixture
def audit_log():
    """Capture audit emissions in a list."""
    captured: List[dict] = []
    set_audit_func(lambda **kw: captured.append(dict(kw)))
    yield captured
    set_audit_func(lambda **kw: None)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_attempt_and_commit_emitted_on_success(audit_log):
    with audited_swap(
        kind="ingest.test",
        actor="user/123",
        subject_id="token-abc",
        payload={"foo": "bar"},
    ) as ctx:
        # Caller's mutation goes here
        pass

    kinds = [e["kind"] for e in audit_log]
    assert kinds == ["ingest.test.attempt", "ingest.test.commit"]
    # Both phases share the same attempt_id
    aid = audit_log[0]["payload"]["attempt_id"]
    assert audit_log[1]["payload"]["attempt_id"] == aid
    assert audit_log[1]["payload"]["outcome"] == "ok"
    # Original payload preserved
    assert audit_log[0]["payload"]["foo"] == "bar"


def test_attempt_id_is_in_yielded_context(audit_log):
    with audited_swap(
        kind="x", actor="a", subject_id="s",
    ) as ctx:
        assert isinstance(ctx.attempt_id, str)
        assert len(ctx.attempt_id) == 16  # 8 hex bytes
        assert ctx.attempt_id == audit_log[0]["payload"]["attempt_id"]


# ---------------------------------------------------------------------------
# Failure path
# ---------------------------------------------------------------------------


def test_exception_in_block_emits_failed_commit(audit_log):
    with pytest.raises(RuntimeError, match="boom"):
        with audited_swap(
            kind="ingest.test", actor="a", subject_id="s",
        ):
            raise RuntimeError("boom")

    kinds = [e["kind"] for e in audit_log]
    assert kinds == ["ingest.test.attempt", "ingest.test.commit"]
    assert audit_log[1]["payload"]["outcome"] == "failed"
    assert "boom" in audit_log[1]["payload"]["error"]


def test_exception_propagates_to_caller(audit_log):
    """The wrapped block's exception is re-raised; the route
    layer surfaces it to the caller as a 500."""
    class CustomError(Exception):
        pass

    with pytest.raises(CustomError):
        with audited_swap(kind="x", actor="a", subject_id="s"):
            raise CustomError("custom")


# ---------------------------------------------------------------------------
# Audit failure resilience
# ---------------------------------------------------------------------------


def test_attempt_phase_audit_failure_aborts_swap():
    """If the attempt-phase audit_log raises, the wrapped block
    NEVER runs (we haven't recorded intent so we shouldn't mutate)."""
    block_ran = {"called": False}

    def boom(**_kw):
        raise IOError("audit chain unreachable")

    set_audit_func(boom)
    try:
        with pytest.raises(IOError):
            with audited_swap(kind="x", actor="a", subject_id="s"):
                block_ran["called"] = True
        assert not block_ran["called"]
    finally:
        set_audit_func(lambda **kw: None)


def test_commit_phase_audit_failure_after_success_does_not_raise():
    """The wrapped mutation already succeeded; if the commit-phase
    audit fails, we log to stderr but DON'T re-raise (would
    mislead the caller about whether the mutation landed)."""
    calls = {"count": 0}

    def fail_on_commit(**kw):
        calls["count"] += 1
        if "commit" in kw["kind"]:
            raise IOError("audit failed on commit")

    set_audit_func(fail_on_commit)
    try:
        # No exception even though commit-audit raised
        with audited_swap(kind="x", actor="a", subject_id="s"):
            pass  # mutation succeeds
        assert calls["count"] == 2  # attempt + commit both attempted
    finally:
        set_audit_func(lambda **kw: None)


def test_commit_phase_audit_failure_after_block_exception_does_not_swallow_original():
    """If the wrapped block raised AND the commit-phase audit
    also raised, the ORIGINAL exception propagates, not the
    audit error."""
    def fail_on_commit(**kw):
        if "commit" in kw["kind"]:
            raise IOError("audit failed on commit")

    set_audit_func(fail_on_commit)
    try:
        with pytest.raises(ValueError, match="original"):
            with audited_swap(kind="x", actor="a", subject_id="s"):
                raise ValueError("original")
    finally:
        set_audit_func(lambda **kw: None)


# ---------------------------------------------------------------------------
# Reconciliation — orphaned attempts
# ---------------------------------------------------------------------------


def test_find_orphaned_attempts_returns_empty_when_paired(audit_log):
    with audited_swap(kind="x", actor="a", subject_id="s"):
        pass
    orphans = find_orphaned_attempts(audit_log)
    assert orphans == []


def test_find_orphaned_attempts_surfaces_unpaired_attempt(audit_log):
    """Simulate a process killed between attempt and commit:
    only the attempt entry is present in the chain. Reconciliation
    finds it for operator review."""
    audit_log.append({
        "kind": "ingest.ecp.apply.attempt",
        "actor": "u",
        "subject_id": "tok",
        "payload": {"attempt_id": "deadbeef" * 2},
    })
    # No matching commit entry
    orphans = find_orphaned_attempts(audit_log)
    assert len(orphans) == 1
    assert orphans[0]["payload"]["attempt_id"] == "deadbeef" * 2


def test_find_orphaned_attempts_filters_by_kind_prefix(audit_log):
    audit_log.extend([
        {"kind": "ingest.ecp.apply.attempt",
         "payload": {"attempt_id": "aaa11111aaa11111"}},
        {"kind": "channel.apply.x.attempt",
         "payload": {"attempt_id": "bbb22222bbb22222"}},
    ])
    only_ecp = find_orphaned_attempts(audit_log, kind_prefixes=["ingest.ecp"])
    assert len(only_ecp) == 1
    assert only_ecp[0]["payload"]["attempt_id"] == "aaa11111aaa11111"


def test_find_orphaned_attempts_ignores_attempts_with_matching_commits(audit_log):
    audit_log.extend([
        {"kind": "ingest.ecp.apply.attempt",
         "payload": {"attempt_id": "aaa11111aaa11111"}},
        {"kind": "ingest.ecp.apply.commit",
         "payload": {"attempt_id": "aaa11111aaa11111", "outcome": "ok"}},
        {"kind": "ingest.ecp.apply.attempt",
         "payload": {"attempt_id": "bbb22222bbb22222"}},
        # bbb has no commit
    ])
    orphans = find_orphaned_attempts(audit_log)
    assert len(orphans) == 1
    assert orphans[0]["payload"]["attempt_id"] == "bbb22222bbb22222"
