"""Two-phase audit / swap context manager (UIS-P6.10).

The atomicity hole this closes: ``swap_dataset()`` is in-memory
mutation, ``audit_log()`` is a SQLite write. If audit_log raises
AFTER the swap succeeds (DB locked, disk full, sqlite corruption),
the dataset has changed but the audit chain has no entry — silent
state mutation.

Fix: split the audit emission into two phases.

  1. ``ingest.<kind>.attempt`` — emitted BEFORE the swap. Records
     intent + an `attempt_id` so the chain has a forward-looking
     marker even if the swap itself crashes.
  2. ``ingest.<kind>.commit`` — emitted AFTER the swap. Carries
     the same `attempt_id` plus an `outcome` field
     ("ok" | "failed") and any error.

A partial failure (process killed mid-swap, or audit_log fails
on the commit phase) leaves an `.attempt` with no matching
`.commit`. The reconciliation helper ``find_orphaned_attempts``
surfaces those for operator review on the next health check.

Usage
-----
::

    with audited_swap(
        kind="ingest.ecp.apply",
        actor=actor_dodid,
        subject_id=preview_token,
        payload={"counts": counts, "filename": file.filename},
    ) as ctx:
        swap_dataset(new_ds, source="ingest.ecp", ...)
        # `ctx.attempt_id` available if downstream wants it

The context manager swallows exceptions on the commit-phase
audit_log call (best-effort: we've done all we can if the
chain itself is broken). Exceptions from the wrapped block
DO propagate so the route layer surfaces 500 to the caller.
"""
from __future__ import annotations

import contextlib
import logging
import secrets
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterator, List, Optional


log = logging.getLogger(__name__)


# Audit emission is injected to keep this module decoupled from
# backend.persistence (mirrors uis/channels/runner.py's set_audit_func
# pattern). The SPIRE backend wires this on import; tests pass a stub.
AuditFunc = Callable[..., None]
_audit: AuditFunc = lambda **kwargs: None


def set_audit_func(fn: AuditFunc) -> None:
    """Wire the audit emitter. Production routes through
    ``backend.persistence.log``; tests inject list-appending stubs.
    """
    global _audit
    _audit = fn


@dataclass
class _SwapContext:
    """Handle returned from ``audited_swap``. Carries the
    attempt_id so callers can include it in their own audit
    payloads if needed.
    """
    attempt_id: str


def _new_attempt_id() -> str:
    """Cryptographically random 16-hex attempt id. Same length
    as our other tokens (preview_token, state_token) so the audit
    chain is readable.

    secrets.token_hex avoids the per-thread RNG state issues that
    affect uuid.uuid4 under heavy fork."""
    return secrets.token_hex(8)


@contextlib.contextmanager
def audited_swap(
    *,
    kind: str,
    actor: str,
    subject_id: str,
    payload: Optional[Dict[str, Any]] = None,
) -> Iterator[_SwapContext]:
    """Wrap a dataset-swap (or any state-mutating side effect)
    with a paired attempt/commit audit emission.

    Parameters
    ----------
    kind
        Audit kind prefix. The two emissions are
        ``<kind>.attempt`` and ``<kind>.commit``. Existing kinds
        like ``ingest.ecp.apply`` keep their semantics — the
        `.commit` entry replaces what was previously emitted as
        a single ``ingest.ecp.apply`` event.
    actor
        Who performed the action. Same value goes on both phases.
    subject_id
        What's being swapped (preview_token, channel_id, etc.).
    payload
        Extra context to include in both phases.

    Yields
    ------
    _SwapContext with ``attempt_id``.

    Raises
    ------
    Whatever the wrapped block raises — propagated unchanged so
    the route layer surfaces it to the caller. The commit-phase
    audit_log call is best-effort even on the failure branch.
    """
    attempt_id = _new_attempt_id()
    base_payload = dict(payload or {})
    base_payload["attempt_id"] = attempt_id

    # Phase 1: prepare — log intent BEFORE the mutation. If this
    # raises, the mutation never runs and the route surfaces 500.
    _audit(
        kind=f"{kind}.attempt",
        actor=actor,
        subject_id=subject_id,
        payload=dict(base_payload),
    )

    ctx = _SwapContext(attempt_id=attempt_id)
    try:
        yield ctx
    except Exception as e:
        # Phase 2 (failure): record the commit attempt failed. Best-
        # effort — if the audit chain itself is broken, we log to
        # stderr and re-raise so the operator sees both signals.
        try:
            _audit(
                kind=f"{kind}.commit",
                actor=actor,
                subject_id=subject_id,
                payload={
                    **base_payload,
                    "outcome": "failed",
                    "error": str(e)[:500],
                },
            )
        except Exception as audit_exc:  # noqa: BLE001
            log.error(
                "audited_swap commit-phase audit_log FAILED for kind=%s "
                "actor=%s subject_id=%s attempt_id=%s — original error: %s — "
                "audit error: %s",
                kind, actor, subject_id, attempt_id, e, audit_exc,
            )
        raise

    # Phase 2 (success): record the commit landed. Failure here is
    # a real concern — the swap happened but the chain doesn't know.
    # We log to stderr so the operator has SOMETHING to reconcile
    # against, but we don't re-raise (the caller's mutation already
    # succeeded; raising here would be misleading).
    try:
        _audit(
            kind=f"{kind}.commit",
            actor=actor,
            subject_id=subject_id,
            payload={
                **base_payload,
                "outcome": "ok",
            },
        )
    except Exception as audit_exc:  # noqa: BLE001
        log.error(
            "audited_swap commit-phase audit_log FAILED on success for "
            "kind=%s actor=%s subject_id=%s attempt_id=%s — swap landed but "
            "chain has no commit entry. Reconciliation needed. err: %s",
            kind, actor, subject_id, attempt_id, audit_exc,
        )


# ---------------------------------------------------------------------------
# Reconciliation — find orphaned .attempt entries
# ---------------------------------------------------------------------------


def find_orphaned_attempts(
    audit_entries: List[Dict[str, Any]],
    *,
    kind_prefixes: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """Walk a list of audit entries and return any ``.attempt``
    that has no matching ``.commit`` (same attempt_id).

    ``kind_prefixes`` (optional) filters which kinds to inspect —
    e.g. ``["ingest.ecp.apply"]``. Default checks every entry.

    Used by health endpoints / admin tools to surface in-flight
    or partially-failed swaps. Operationally: an orphaned attempt
    older than N minutes likely means the process died mid-swap
    or the audit chain wrote was lost; the operator reconciles
    against actual dataset state (was the change applied or not?)
    and emits a manual commit entry to close the chain.
    """
    attempts: Dict[str, Dict[str, Any]] = {}
    commits: set = set()
    for e in audit_entries:
        kind = e.get("kind", "")
        if kind_prefixes and not any(
            kind.startswith(p) for p in kind_prefixes
        ):
            continue
        payload = e.get("payload") or {}
        attempt_id = payload.get("attempt_id") if isinstance(payload, dict) else None
        if not attempt_id:
            continue
        if kind.endswith(".attempt"):
            attempts[attempt_id] = e
        elif kind.endswith(".commit"):
            commits.add(attempt_id)

    return [a for aid, a in attempts.items() if aid not in commits]
