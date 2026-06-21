"""SENTRY aggregation re-mark — audit-persistence regression (Wave 1 / H1).

The aggregation-remark handler used to call ``record_sentry_decision``
with kwargs that didn't exist in its signature (``batch_id=``,
``actor=``, ``target_classification=``, ``notes=``). Every call raised
``TypeError``, which a bare ``except TypeError: pass`` swallowed — so
aggregation re-mark decisions were NEVER persisted to the audit chain.
For an IL5 tamper-evident-audit posture that's the worst class of bug.

These tests drive the real HTTP route end-to-end and assert the
per-SR decision rows actually land in ``sentry_decisions``.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


# security_manager — in BOTH SENTRY_MARK_ROLES (can ingest/process) and
# SENTRY_REVIEW_ROLES (can aggregation-remark), so it drives the full flow.
SECURITY_MANAGER_DODID = "3456789012"
# maintenance_chief — in NEITHER set; used to prove the gates 403.
MAINT_CHIEF_DODID = "2345678901"


@pytest.fixture
def sentry_client():
    """Fully-booted client (lifespan loads the seed-42 dataset) logged in
    as security_manager, with a processed canonical batch ready to re-mark."""
    from backend.main import app

    with TestClient(app) as c:
        r = c.post(
            "/api/auth/login",
            json={"dodid": SECURITY_MANAGER_DODID, "pin": "000000"},
        )
        assert r.status_code == 200, r.text
        yield c


def _seed_processed_batch(client: TestClient) -> str:
    r = client.get("/api/sentry/demo-batch?limit=300")
    assert r.status_code == 200, r.text
    batch_id = r.json()["batch_id"]
    r = client.post(f"/api/sentry/process/{batch_id}")
    assert r.status_code == 200, r.text
    return batch_id


def _a_unit_equipment_pair() -> tuple[str, str]:
    """A (unit, equipment) pair guaranteed to be in the demo batch — the
    first non-PMCS SR, which `_records_from_canonical` always includes."""
    from backend.state import get_dataset
    ds = get_dataset()
    sr = next(s for s in ds.srs if not s.is_pmcs)
    return sr.unit_name, sr.equipment_type


def test_aggregation_remark_persists_decisions(sentry_client):
    batch_id = _seed_processed_batch(sentry_client)
    unit, equipment = _a_unit_equipment_pair()

    r = sentry_client.post(
        "/api/sentry/aggregation/remark",
        json={
            "batch_id": batch_id,
            "unit": unit,
            "equipment": equipment,
            "target_classification": "CUI",
            "note": "agg regression test",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    matched = body["matched_sr_ids"]
    assert body["matched_sr_count"] >= 1
    assert matched, "expected at least one matching SR for the first canonical pair"

    # The actual regression assertion: decisions must be persisted, not
    # silently dropped by a swallowed TypeError.
    from backend.persistence import decisions_for_batch
    rows = decisions_for_batch(matched)
    assert rows, "aggregation re-mark decisions were not persisted (H1 regression)"
    for sr_num in matched:
        assert sr_num in rows
        assert rows[sr_num]["action"] == "aggregation_remark"
        assert rows[sr_num]["actor_role"] == "security_manager"
        # actor identity must be anchored to the Marine, not blank.
        assert rows[sr_num]["actor_dodid"] == SECURITY_MANAGER_DODID


def test_aggregation_remark_requires_review_role(sentry_client):
    batch_id = _seed_processed_batch(sentry_client)
    unit, equipment = _a_unit_equipment_pair()

    # Re-auth as a maintenance_chief, who is not in SENTRY_REVIEW_ROLES.
    sentry_client.post("/api/auth/logout")
    r = sentry_client.post(
        "/api/auth/login", json={"dodid": MAINT_CHIEF_DODID, "pin": "000000"}
    )
    assert r.status_code == 200, r.text

    r = sentry_client.post(
        "/api/sentry/aggregation/remark",
        json={
            "batch_id": batch_id,
            "unit": unit,
            "equipment": equipment,
            "target_classification": "CUI",
        },
    )
    assert r.status_code == 403, r.text
