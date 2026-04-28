"""
Task-168 — pin the single-entry guarantee for SENTRY bulk review.

The Review Queue's headline fix is that "Approve all 357" writes ONE
``sentry_bulk_review`` chained audit row carrying every SR in its payload —
not 357 independent rows that would make a single click indistinguishable
from 357 deliberate one-by-one approvals. Today that invariant is enforced
only by the helper ``record_sentry_bulk_decision`` and verified manually
via curl.

This test boots the FastAPI app via TestClient, drives a 60-SR bulk
approve through the public ``POST /api/sentry/review/bulk`` endpoint, and
pins:

  * exactly ONE new ``audit_log`` row appears with kind=``sentry_bulk_review``
  * that row's payload carries an ``sr_numbers`` array of length 60 whose
    contents match the request exactly (and in order)
  * the hash chain stays intact across the bulk write — the new row's
    ``prev_hash`` matches the previous head's ``self_hash`` and its
    ``self_hash`` recomputes correctly under the same canonical-bytes
    rule the chain verifier uses
  * exactly 60 rows land in ``sentry_decisions`` with the requested action
    (i.e. the per-record state still exists for downstream gates like
    ``decisions_for_batch`` — the bulk row is in addition to, not instead
    of, the durable decision rows)

If a future refactor of the bulk endpoint or the helper reverts to a
per-row audit-write loop, this test fails with a clear count mismatch.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import (
    DB_PATH,
    _GENESIS,
    _canonical,
    decisions_for_batch,
)


# Park — security_manager, TS//SCI. Bulk review requires a valid session
# (the auth middleware gates /api/*); Park is the canonical reviewer used
# elsewhere in the suite.
DODID_PARK = "3456789012"


@pytest.fixture()
def client():
    # Context-manager form runs the lifespan handler so the canonical
    # dataset is loaded before any /sentry/* call lands.
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _audit_head() -> tuple[int, str]:
    """Return (max_id, head_self_hash) for the audit_log so the test can
    reason only about rows it appended."""
    with sqlite3.connect(str(DB_PATH)) as c:
        c.row_factory = sqlite3.Row
        row = c.execute(
            "SELECT id, self_hash FROM audit_log ORDER BY id DESC LIMIT 1"
        ).fetchone()
    if row is None:
        return (0, _GENESIS)
    return (int(row["id"]), str(row["self_hash"]))


def _audit_rows_after(after_id: int) -> list[dict]:
    with sqlite3.connect(str(DB_PATH)) as c:
        c.row_factory = sqlite3.Row
        rows = c.execute(
            "SELECT id, ts, actor, kind, subject_id, payload, prev_hash, self_hash "
            "FROM audit_log WHERE id > ? ORDER BY id ASC",
            (after_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def _decision_count(sr_numbers: list[str]) -> int:
    """Count rows in sentry_decisions for the given SRs."""
    if not sr_numbers:
        return 0
    placeholders = ",".join("?" for _ in sr_numbers)
    with sqlite3.connect(str(DB_PATH)) as c:
        n = c.execute(
            f"SELECT COUNT(*) FROM sentry_decisions WHERE sr_number IN ({placeholders})",
            tuple(sr_numbers),
        ).fetchone()[0]
    return int(n)


def test_bulk_review_writes_exactly_one_chained_audit_row_for_n_srs(client):
    _login(client, DODID_PARK)

    # 60 SRs — comfortably above the FE's 50-record typed-confirmation
    # threshold, so the test exercises the "operator clicks once on a big
    # selection" path the critique was about. Pinned namespace
    # (BULK168-…) keeps the SRs disjoint from the canonical batch and from
    # other tests so re-runs don't collide on UNIQUE constraints in
    # sentry_decisions.
    sr_numbers = [f"BULK168-{i:04d}" for i in range(60)]
    assert len(sr_numbers) >= 60

    before_max_id, before_head_hash = _audit_head()

    r = client.post(
        "/api/sentry/review/bulk",
        json={
            "action": "approve",
            "sr_numbers": sr_numbers,
            "column": "held",
            "note": "task-168 pinning test",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["action"] == "approve"
    assert body["count"] == len(sr_numbers)
    assert body["audit_kind"] == "sentry_bulk_review"
    # Endpoint echoes the SR list back so the FE can reconcile its
    # selection against what the server actually persisted.
    assert body["sr_numbers"] == sr_numbers

    # ---- The single-entry invariant ---------------------------------------
    new_rows = _audit_rows_after(before_max_id)

    # Per-record decisions must NOT each emit their own chain row. The
    # whole point of record_sentry_bulk_decision is that a bulk click
    # collapses to one chained intent. If a future refactor reverts to a
    # per-row loop this assertion fails loudly with N+ rows.
    bulk_rows = [r for r in new_rows if r["kind"] == "sentry_bulk_review"]
    assert len(bulk_rows) == 1, (
        f"expected exactly 1 sentry_bulk_review row; got {len(bulk_rows)} "
        f"out of {len(new_rows)} new audit rows: "
        f"{[(r['id'], r['kind'], r['subject_id']) for r in new_rows]}"
    )
    assert all(r["kind"] != "sentry_review" for r in new_rows), (
        "per-record sentry_review rows must not be emitted on the bulk "
        "path — that would make 'approve all N' indistinguishable from "
        "N deliberate one-by-one approvals: "
        f"{[(r['id'], r['kind']) for r in new_rows if r['kind'] == 'sentry_review']}"
    )

    bulk = bulk_rows[0]
    payload = json.loads(bulk["payload"])
    assert payload["action"] == "approve"
    assert payload["column"] == "held"
    assert payload["note"] == "task-168 pinning test"
    assert payload["count"] == len(sr_numbers)
    # The full SR list must be in the payload — that is the IG-reproducible
    # artifact behind the single click. Order matters: the helper preserves
    # the request order so a reviewer can replay the exact selection.
    assert payload["sr_numbers"] == sr_numbers, (
        "audit payload must carry every SR the bulk action touched, in "
        "request order"
    )
    assert len(payload["sr_numbers"]) == len(sr_numbers)

    # ---- Hash-chain linkage ----------------------------------------------
    # The new bulk row's prev_hash must equal the prior head's self_hash
    # (or genesis if the test runs against a fresh DB). Recompute the
    # row's self_hash from canonical inputs and compare to what's stored —
    # that's the same arithmetic verify_chain() does, just scoped to the
    # row this test wrote.
    assert bulk["prev_hash"] == before_head_hash, (
        f"bulk row prev_hash must match prior chain head: "
        f"{bulk['prev_hash']} vs {before_head_hash}"
    )
    entry = {
        "ts": bulk["ts"],
        "actor": bulk["actor"],
        "kind": bulk["kind"],
        "subject_id": bulk["subject_id"],
        "payload": bulk["payload"],
        "prev_hash": bulk["prev_hash"],
    }
    expected_self = hashlib.sha256(
        (bulk["prev_hash"] + _canonical(entry)).encode()
    ).hexdigest()
    assert bulk["self_hash"] == expected_self, (
        "bulk row self_hash must be SHA-256(prev_hash || canonical(row))"
    )

    # ---- Per-record durability still happens ------------------------------
    # The decisions table must reflect each SR — that's what the export
    # gate and decisions_for_batch read. The bulk row is *additional*
    # provenance, not a replacement.
    assert _decision_count(sr_numbers) == len(sr_numbers), (
        "every SR in the bulk request must land in sentry_decisions"
    )
    decisions = decisions_for_batch(sr_numbers)
    assert len(decisions) == len(sr_numbers)
    for sr in sr_numbers:
        assert sr in decisions, f"missing sentry_decisions row for {sr}"
        assert decisions[sr]["action"] == "approve"
