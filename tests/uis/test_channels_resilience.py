"""Resilience primitive tests — retry, circuit breaker, integrity."""
from __future__ import annotations

import time
from unittest.mock import MagicMock

import pytest

from backend.uis.channels.resilience import (
    CircuitBreaker,
    CircuitState,
    IntegrityMismatchError,
    RetryPolicy,
    compute_sha256,
    get_breaker,
    list_breakers,
    reset_breaker,
    verify_against_declared,
    with_retry,
)


# ---------------------------------------------------------------------------
# RetryPolicy + with_retry
# ---------------------------------------------------------------------------


def test_retry_returns_immediately_on_success():
    calls = {"count": 0}

    def fn():
        calls["count"] += 1
        return "ok"

    result = with_retry(fn)
    assert result == "ok"
    assert calls["count"] == 1


def test_retry_recovers_from_transient_failure():
    calls = {"count": 0}

    def fn():
        calls["count"] += 1
        if calls["count"] < 3:
            raise ConnectionError("transient")
        return "ok"

    sleeps = []
    result = with_retry(
        fn,
        policy=RetryPolicy(max_attempts=5, base_delay_seconds=0.01, jitter=0.0),
        sleep=sleeps.append,
    )
    assert result == "ok"
    assert calls["count"] == 3
    # Sleeps fire only on attempts 2+ (attempt 1 has zero delay).
    # Attempts 2 and 3 → 2 non-zero sleeps recorded.
    assert len(sleeps) == 2
    assert all(s > 0 for s in sleeps)


def test_retry_reraises_after_max_attempts():
    def fn():
        raise RuntimeError("persistent")

    with pytest.raises(RuntimeError, match="persistent"):
        with_retry(
            fn,
            policy=RetryPolicy(max_attempts=2, base_delay_seconds=0.0, jitter=0.0),
            sleep=lambda _: None,
        )


def test_retry_calls_on_retry_callback():
    callbacks = []

    def fn():
        raise IOError("nope")

    try:
        with_retry(
            fn,
            policy=RetryPolicy(max_attempts=3, base_delay_seconds=0.0, jitter=0.0),
            on_retry=lambda attempt, exc: callbacks.append((attempt, str(exc))),
            sleep=lambda _: None,
        )
    except IOError:
        pass
    # Three failures → three callbacks
    assert [c[0] for c in callbacks] == [1, 2, 3]


def test_retry_policy_delay_for_exponential():
    p = RetryPolicy(
        max_attempts=5, base_delay_seconds=1.0, backoff_factor=2.0,
        max_delay_seconds=10.0, jitter=0.0,
    )
    assert p.delay_for(1) == 0.0
    assert p.delay_for(2) == 1.0
    assert p.delay_for(3) == 2.0
    assert p.delay_for(4) == 4.0
    assert p.delay_for(5) == 8.0


def test_retry_policy_caps_at_max_delay():
    p = RetryPolicy(
        max_attempts=10, base_delay_seconds=1.0, backoff_factor=10.0,
        max_delay_seconds=5.0, jitter=0.0,
    )
    assert p.delay_for(2) == 1.0
    assert p.delay_for(3) == 5.0  # capped
    assert p.delay_for(10) == 5.0


# ---------------------------------------------------------------------------
# CircuitBreaker
# ---------------------------------------------------------------------------


def test_breaker_starts_closed_and_allows_calls():
    br = CircuitBreaker(failure_threshold=3, cooldown_seconds=60)
    assert br.allow() is True
    assert br.state == CircuitState.CLOSED


def test_breaker_opens_after_threshold_failures():
    br = CircuitBreaker(failure_threshold=3, cooldown_seconds=60)
    br.record_failure("err 1")
    br.record_failure("err 2")
    assert br.state == CircuitState.CLOSED
    assert br.allow() is True
    br.record_failure("err 3")
    assert br.state == CircuitState.OPEN
    assert br.allow(now=br.opened_at + 1) is False  # still in cooldown


def test_breaker_transitions_to_half_open_after_cooldown():
    br = CircuitBreaker(failure_threshold=2, cooldown_seconds=60)
    br.record_failure("a", now=100)
    br.record_failure("b", now=101)
    assert br.state == CircuitState.OPEN
    # Inside cooldown — denied
    assert br.allow(now=130) is False
    # After cooldown — half-open, one trial allowed
    assert br.allow(now=200) is True
    assert br.state == CircuitState.HALF_OPEN


def test_breaker_half_open_success_closes():
    br = CircuitBreaker(failure_threshold=1, cooldown_seconds=60)
    br.record_failure("a", now=100)
    assert br.state == CircuitState.OPEN
    br.allow(now=200)  # transitions to HALF_OPEN
    br.record_success()
    assert br.state == CircuitState.CLOSED
    assert br.consecutive_failures == 0


def test_breaker_half_open_failure_reopens():
    br = CircuitBreaker(failure_threshold=1, cooldown_seconds=60)
    br.record_failure("a", now=100)
    br.allow(now=200)
    assert br.state == CircuitState.HALF_OPEN
    br.record_failure("b", now=201)
    assert br.state == CircuitState.OPEN
    assert br.opened_at == 201


def test_breaker_record_success_clears_failures():
    br = CircuitBreaker(failure_threshold=5, cooldown_seconds=60)
    br.record_failure("a")
    br.record_failure("b")
    br.record_success()
    assert br.consecutive_failures == 0
    assert br.last_error is None


def test_module_breakers_registry_lazy_creates():
    # Use a fresh channel id so we don't collide with other tests
    br1 = get_breaker("test-resilience/A")
    br2 = get_breaker("test-resilience/A")
    assert br1 is br2


def test_reset_breaker_clears_state():
    br = get_breaker("test-resilience/B", failure_threshold=2, cooldown_seconds=60)
    br.record_failure("x")
    br.record_failure("y")
    assert br.state == CircuitState.OPEN
    reset_breaker("test-resilience/B")
    br_after = get_breaker("test-resilience/B")
    assert br_after.state == CircuitState.CLOSED
    assert br_after.consecutive_failures == 0


def test_list_breakers_snapshot():
    get_breaker("test-resilience/snap-1")
    snapshot = list_breakers()
    assert "test-resilience/snap-1" in snapshot
    entry = snapshot["test-resilience/snap-1"]
    assert "state" in entry
    assert "consecutive_failures" in entry


# ---------------------------------------------------------------------------
# File integrity
# ---------------------------------------------------------------------------


def test_compute_sha256_matches_hashlib():
    body = b"hello world\n"
    expected = "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447"
    assert compute_sha256(body) == expected


def test_verify_against_declared_returns_hash_when_ok():
    body = b"correct payload"
    h = compute_sha256(body)
    result = verify_against_declared(body, h)
    assert result == h


def test_verify_against_declared_accepts_uppercase():
    """Sidecar files generated by Windows tooling often emit
    uppercase hashes — comparison is case-insensitive."""
    body = b"x"
    h = compute_sha256(body)
    result = verify_against_declared(body, h.upper())
    assert result == h


def test_verify_against_declared_raises_on_mismatch():
    body = b"actual content"
    bogus = "0" * 64
    with pytest.raises(IntegrityMismatchError) as exc:
        verify_against_declared(body, bogus, filename="dla_export.csv")
    e = exc.value
    assert e.expected == bogus
    assert e.actual == compute_sha256(body)
    assert "dla_export.csv" in str(e)


def test_verify_returns_hash_when_no_declared_hash():
    """No declared hash → no verification, just compute + return."""
    body = b"unverified"
    result = verify_against_declared(body, None)
    assert result == compute_sha256(body)
    result2 = verify_against_declared(body, "")  # empty also OK
    assert result2 == compute_sha256(body)
