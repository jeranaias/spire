"""Resilience primitives for channel polls.

Three concerns, kept independent so each can be tested + reused:

  1. **Retry/backoff** — exponential backoff with jitter for
     transient channel failures (network blips, momentary auth
     timeouts). ``RetryPolicy`` + ``with_retry`` wrapper.
  2. **Circuit breaker** — after N consecutive cycles fail, "open"
     the circuit so the scheduler skips that channel for a
     cooldown window. Half-open after cooldown — one trial poll
     decides whether to close (success) or re-open (failure).
  3. **File integrity** — verify a fetched file against a declared
     sha256, when one is supplied (sidecar file, HTTP header,
     channel-config field). Refuses corrupted bytes.

Failure semantics: every primitive raises a typed exception that
the runner catches and routes to audit + quarantine. None of these
silently swallow errors.
"""
from __future__ import annotations

import hashlib
import logging
import random
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional, TypeVar


log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Retry / backoff
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RetryPolicy:
    """Exponential backoff with jitter.

    Defaults are tuned for SFTP/IMAP transient failures: 3 attempts
    with delays around [0.5, 1.0, 2.0] seconds. Channels can
    override (e.g. fileshare polling rarely benefits from retries
    since the file is local — set max_attempts=1 to disable).
    """

    max_attempts: int = 3
    base_delay_seconds: float = 0.5
    backoff_factor: float = 2.0
    max_delay_seconds: float = 30.0
    jitter: float = 0.2  # +/- 20% jitter on each delay

    def delay_for(self, attempt: int) -> float:
        """Compute delay before attempt N (1-indexed). Attempt 1 = no
        delay (first try); attempt 2+ = computed backoff."""
        if attempt <= 1:
            return 0.0
        raw = self.base_delay_seconds * (self.backoff_factor ** (attempt - 2))
        raw = min(raw, self.max_delay_seconds)
        # +/- jitter
        if self.jitter > 0:
            spread = raw * self.jitter
            raw = raw + random.uniform(-spread, spread)
        return max(0.0, raw)


T = TypeVar("T")


def with_retry(
    fn: Callable[[], T],
    *,
    policy: RetryPolicy = RetryPolicy(),
    on_retry: Optional[Callable[[int, Exception], None]] = None,
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Run ``fn`` under the retry policy. ``sleep`` is injectable for
    tests to skip real delays.

    Re-raises the LAST exception when all attempts fail; the caller
    sees a normal exception with context that retries were tried.
    """
    last_exc: Optional[Exception] = None
    for attempt in range(1, max(1, policy.max_attempts) + 1):
        delay = policy.delay_for(attempt)
        if delay > 0:
            sleep(delay)
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            last_exc = e
            if on_retry is not None:
                try:
                    on_retry(attempt, e)
                except Exception:  # noqa: BLE001
                    log.warning("on_retry callback raised; ignoring")
            if attempt >= policy.max_attempts:
                raise
    # Unreachable but mypy-friendly
    if last_exc is not None:
        raise last_exc
    raise RuntimeError("with_retry exited without attempting")


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------


class CircuitState:
    CLOSED = "closed"        # Normal — calls flow through
    OPEN = "open"            # Failing — calls short-circuit until cooldown
    HALF_OPEN = "half_open"  # Trial — one call decides next state


@dataclass
class CircuitBreaker:
    """Per-channel circuit state machine.

    Tracks consecutive failures. Once ``failure_threshold`` is hit,
    transitions CLOSED → OPEN and refuses calls for ``cooldown_seconds``.
    After cooldown, transitions to HALF_OPEN — the next call is a
    "trial". Trial success → CLOSED; trial failure → OPEN again
    (with a fresh cooldown).

    Thread-safe — channels may be polled from a scheduler thread
    + an on-demand /poll request concurrently.
    """

    failure_threshold: int = 5
    cooldown_seconds: float = 300.0  # 5 minutes
    state: str = CircuitState.CLOSED
    consecutive_failures: int = 0
    opened_at: Optional[float] = None
    last_error: Optional[str] = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def allow(self, *, now: Optional[float] = None) -> bool:
        """Should the next call be allowed? Transitions OPEN→HALF_OPEN
        when cooldown has elapsed."""
        with self._lock:
            t = now if now is not None else time.time()
            if self.state == CircuitState.OPEN:
                if self.opened_at is None or (t - self.opened_at) >= self.cooldown_seconds:
                    self.state = CircuitState.HALF_OPEN
                    return True
                return False
            return True

    def record_success(self) -> None:
        with self._lock:
            self.state = CircuitState.CLOSED
            self.consecutive_failures = 0
            self.opened_at = None
            self.last_error = None

    def record_failure(self, reason: str, *, now: Optional[float] = None) -> None:
        with self._lock:
            t = now if now is not None else time.time()
            self.last_error = reason
            self.consecutive_failures += 1
            if (
                self.state == CircuitState.HALF_OPEN
                or self.consecutive_failures >= self.failure_threshold
            ):
                self.state = CircuitState.OPEN
                self.opened_at = t

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "state": self.state,
                "consecutive_failures": self.consecutive_failures,
                "failure_threshold": self.failure_threshold,
                "cooldown_seconds": self.cooldown_seconds,
                "opened_at": self.opened_at,
                "last_error": self.last_error,
            }


# Module-level registry: channel_id → CircuitBreaker. Lazy-init —
# first call to get_breaker(id) creates one with default thresholds.
_BREAKERS: Dict[str, CircuitBreaker] = {}
_BREAKERS_LOCK = threading.Lock()


def get_breaker(
    channel_id: str,
    *,
    failure_threshold: int = 5,
    cooldown_seconds: float = 300.0,
) -> CircuitBreaker:
    with _BREAKERS_LOCK:
        if channel_id not in _BREAKERS:
            _BREAKERS[channel_id] = CircuitBreaker(
                failure_threshold=failure_threshold,
                cooldown_seconds=cooldown_seconds,
            )
        return _BREAKERS[channel_id]


def reset_breaker(channel_id: str) -> None:
    """Operator action — manually close a tripped breaker.

    After verifying the upstream issue is resolved, reset clears
    failure counts and re-opens the channel for normal polling.
    """
    with _BREAKERS_LOCK:
        if channel_id in _BREAKERS:
            br = _BREAKERS[channel_id]
            br.state = CircuitState.CLOSED
            br.consecutive_failures = 0
            br.opened_at = None
            br.last_error = None


def list_breakers() -> Dict[str, Dict[str, Any]]:
    """Snapshot of every channel's breaker state — for the channel
    admin tab."""
    with _BREAKERS_LOCK:
        return {
            channel_id: breaker.snapshot()
            for channel_id, breaker in _BREAKERS.items()
        }


# ---------------------------------------------------------------------------
# File integrity
# ---------------------------------------------------------------------------


class IntegrityMismatchError(ValueError):
    """Raised when a fetched file's sha256 doesn't match the
    declared hash. Routes catch this and quarantine the file."""

    def __init__(self, *, expected: str, actual: str, filename: str = ""):
        self.expected = expected
        self.actual = actual
        self.filename = filename
        super().__init__(
            f"Integrity check failed for {filename or 'file'}: "
            f"expected sha256={expected[:16]}..., "
            f"got sha256={actual[:16]}..."
        )


def compute_sha256(body: bytes) -> str:
    """Full-precision sha256 hex digest. Cheap enough at any
    realistic upload size that we always compute it (and surface
    in audit chain) — even when integrity check is off."""
    return hashlib.sha256(body).hexdigest()


def verify_against_declared(
    body: bytes,
    declared: Optional[str],
    *,
    filename: str = "",
) -> str:
    """Compute sha256(body); if ``declared`` is provided, raise
    IntegrityMismatchError on mismatch. Returns the computed hash
    so the caller can attach it to audit even when no declared
    hash was supplied.

    Comparison is case-insensitive (declared hashes commonly
    arrive uppercase from sidecar files generated by Windows
    tooling).
    """
    actual = compute_sha256(body)
    if declared:
        d = declared.strip().lower()
        a = actual.lower()
        if d != a:
            raise IntegrityMismatchError(
                expected=d, actual=a, filename=filename,
            )
    return actual


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
