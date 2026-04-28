"""
Task #96 — the SENTRY Review Queue card must surface the reviewer's name,
unit, role, and timestamp on held / flagged records that already carry a
persisted decision.

Before this task the queue endpoint returned only the engine's per-record
output; the FE displayed "decision: approve · g4" because that was all
the inspector's audit-chain modal had on hand. The persisted decision now
carries actor_name + actor_unit + actor_cert_serial (task #25), so a
judge looking at a cleared card can attribute the action without opening
the modal.

These tests lock in:

* GET /api/sentry/review-queue/{batch_id} attaches a `decision` block to
  any held / flagged row that already has a persisted decision, with the
  full reviewer identity (action, actor_name, actor_unit, actor_role, ts).
* Auto-cleared records are NOT decorated — they aren't human-reviewed.
* Rows without a persisted decision do not gain a `decision` key (so the
  FE can rely on `record.decision` truthiness).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _seed_processed_batch(client: TestClient) -> tuple[str, dict]:
    """Create a demo batch and run the SENTRY pipeline against it. Returns
    (batch_id, review_queue_response)."""
    r = client.get("/api/sentry/demo-batch", params={"limit": 200})
    assert r.status_code == 200, r.text
    batch_id = r.json()["batch_id"]

    r = client.post(f"/api/sentry/process/{batch_id}")
    assert r.status_code == 200, r.text

    r = client.get(f"/api/sentry/review-queue/{batch_id}")
    assert r.status_code == 200, r.text
    return batch_id, r.json()


def test_review_queue_attaches_reviewer_identity_to_cleared_card(client):
    # CWO3 James Park is the security_manager and is in SENTRY_REVIEW_ROLES.
    _login(client, "3456789012")
    batch_id, queue = _seed_processed_batch(client)

    # Pick a held record (or a flagged one) to clear so the persisted
    # decision can flow back through the next /review-queue call. The dev
    # SQLite DB is shared across test runs, so we deliberately pick the
    # first candidate WITHOUT an existing `decision` block — that lets the
    # negative assertion below stay meaningful even after prior runs have
    # decisioned other SRs.
    candidates = queue["held"] + queue["flagged"]
    assert candidates, "demo batch produced no held or flagged records to test"
    fresh = [c for c in candidates if "decision" not in c]
    assert fresh, (
        "every held/flagged candidate already has a persisted decision — "
        "expected at least one virgin SR. Wipe spire.db or expand the demo "
        "batch limit if this fires."
    )
    target = fresh[0]
    sr = target["sr_number"]

    # Sanity: the chosen record has no persisted decision yet.
    assert "decision" not in target, (
        "review-queue must not invent a decision block for an un-reviewed record"
    )

    # Approve the record. The actor's name/unit/cert come from the session.
    r = client.post(f"/api/sentry/review/{sr}/approve", json={"note": "looks good"})
    assert r.status_code == 200, r.text

    # Re-fetch the queue. The same SR is still in held/flagged (the queue is
    # built from the engine's predicates, not the decision table); it should
    # now carry a `decision` block stamped with CWO3 Park's identity.
    r = client.get(f"/api/sentry/review-queue/{batch_id}")
    assert r.status_code == 200, r.text
    queue2 = r.json()
    rerun = next(
        (rec for rec in queue2["held"] + queue2["flagged"] if rec["sr_number"] == sr),
        None,
    )
    assert rerun is not None, "reviewed SR vanished from the queue"

    decision = rerun.get("decision")
    assert decision is not None, "reviewed card must carry a `decision` block"
    assert decision["action"] == "approve"
    # Task #25 fields — name + unit + role + timestamp.
    assert decision["actor_name"] == "CWO3 James Park"
    assert decision["actor_unit"] == "3d MLR"
    assert decision["actor_role"] == "security_manager"
    assert decision["ts"], "decision must carry an ISO timestamp"
    assert decision["ts"].endswith("Z"), "timestamp should be UTC ISO with trailing Z"


def test_review_queue_does_not_decorate_auto_cleared(client):
    """Auto-cleared records aren't human-reviewed, so they must never carry
    a `decision` block — even if some accidental row exists in the
    sentry_decisions table for that SR."""
    _login(client, "3456789012")
    _, queue = _seed_processed_batch(client)
    for rec in queue["auto_cleared"]:
        assert "decision" not in rec, (
            f"auto_cleared record {rec.get('sr_number')} unexpectedly "
            f"carries a decision block: {rec.get('decision')}"
        )
