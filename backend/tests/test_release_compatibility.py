"""
Task-69 — release-compatibility gate at /api/sentry/export.

Asserts that the doctrinal release-compatibility validator extracted from
/sentry/mark also runs at the actual release step (/sentry/export), so a
SECRET // NOFORN bundle to FVEY is hard-blocked, a SECRET → FVEY bundle
without an explicit downgrade caveat returns a warning the FE can surface,
and the previously-silent batch_not_found and invalid_release_authority
paths return structured 404 / 400 responses instead of falling through to
the full canonical dataset / KeyErroring into a 500.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import entries_for_subject
from backend.routes import sentry as sentry_route


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Helper unit tests against the extracted validator
# ---------------------------------------------------------------------------

def test_evaluate_release_compatibility_blocks_secret_noforn_to_fvey():
    out = sentry_route.evaluate_release_compatibility("SECRET", "FVEY", ["NOFORN"])
    assert out["status"] == "block"
    assert any("NOFORN" in m for m in out["issues"])


def test_evaluate_release_compatibility_warns_secret_to_fvey_without_downgrade():
    out = sentry_route.evaluate_release_compatibility("SECRET", "FVEY", [])
    assert out["status"] == "warn"
    assert any("downgrade" in m.lower() for m in out["issues"])


def test_evaluate_release_compatibility_ok_for_us_only():
    out = sentry_route.evaluate_release_compatibility("SECRET", "US_ONLY", ["NOFORN"])
    assert out["status"] == "ok"
    assert out["issues"] == []


# ---------------------------------------------------------------------------
# /sentry/export integration tests — block / warn / 404 / 400
# ---------------------------------------------------------------------------

def test_export_invalid_release_authority_returns_400(client):
    _login(client, "3456789012")  # security_manager (TS//SCI) — clears the clearance gate
    r = client.post(
        "/api/sentry/export",
        json={
            "release_authority": "EYES_ONLY",
            "format": "xlsx",
            "include_audit": True,
            "batch_id": None,
        },
    )
    assert r.status_code == 400, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "invalid_release_authority"
    assert detail["release_authority"] == "EYES_ONLY"
    assert "US_ONLY" in detail["allowed"]


def test_export_unknown_batch_id_returns_404(client):
    _login(client, "3456789012")
    r = client.post(
        "/api/sentry/export",
        json={
            "release_authority": "US_ONLY",
            "format": "xlsx",
            "include_audit": True,
            "batch_id": "BATCH-DOES-NOT-EXIST",
        },
    )
    assert r.status_code == 404, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "batch_not_found"
    assert detail["batch_id"] == "BATCH-DOES-NOT-EXIST"


def test_export_no_batch_id_still_works(client):
    """Regression: the legitimate 'no batch supplied' path must keep working."""
    _login(client, "3456789012")
    r = client.post(
        "/api/sentry/export",
        json={"release_authority": "US_ONLY", "format": "xlsx", "include_audit": True, "batch_id": None},
    )
    assert r.status_code == 200, r.text


def test_export_secret_noforn_to_fvey_is_blocked_and_audited(client):
    """The canonical dataset contains classified-TM (NOFORN-bearing) records.
    Requesting FVEY release at SECRET must hard-block + write a
    `release_blocked` audit row, not build a SECRET // REL TO USA, AUS, ...
    bundle.
    """
    _login(client, "3456789012")
    r = client.post(
        "/api/sentry/export",
        json={"release_authority": "FVEY", "format": "xlsx", "include_audit": True, "batch_id": None},
    )
    assert r.status_code == 403, r.text
    detail = r.json()["detail"]
    assert detail["error"] == "release_blocked"
    assert detail["release_authority"] == "FVEY"
    assert detail["classification"] in {"SECRET", "TOP_SECRET", "TS_SCI"}
    assert "NOFORN" in detail["caveats"]
    assert detail["issues"], "issues array must explain the doctrinal block"

    # Audit row landed in the chain. The /export step uses the source label
    # ("canonical_dataset") as the subject_id when no batch_id is supplied.
    rows = entries_for_subject("canonical_dataset", limit=20)
    blocks = [
        e for e in rows
        if e.get("kind") == "release_blocked"
        and e["payload"].get("release_authority") == "FVEY"
    ]
    assert blocks, f"expected a release_blocked audit row; got kinds: {[e.get('kind') for e in rows[:10]]}"
    last = blocks[0]["payload"]  # ORDER BY id DESC → newest first
    assert "NOFORN" in last["caveats"]
    assert last["classification"] in {"SECRET", "TOP_SECRET", "TS_SCI"}
    assert last["surface"] == "backend"


def test_export_warn_path_surfaces_release_warnings(client, monkeypatch):
    """SECRET → FVEY *without* NOFORN must build the bundle (status="warn")
    and surface the warning string the FE renders as a yellow banner above
    the result panel.

    We isolate the warn path by registering a synthetic single-record batch
    whose source_classification is SECRET but which carries no `classified`
    sensitive flag (so the aggregated caveat set excludes NOFORN).
    """
    _login(client, "3456789012")
    batch_id = "BATCH-T69-WARN-001"
    sentry_route._BATCHES[batch_id] = {
        "batch_id": batch_id,
        "source": "synthetic_warn_path",
        "records": [
            {
                "sr_number": "SR-T69-W-1",
                "unit_name": "CLB-6",
                "equipment_type": "MTVR",
                "source_classification": "SECRET",
                "detected_classification_oracle": "SECRET",
                # No `classified` flag → no NOFORN aggregated → SECRET→FVEY warns.
                "sensitive_flags_oracle": [],
                "remark": "Routine fault, no PII or geo.",
            }
        ],
    }
    try:
        r = client.post(
            "/api/sentry/export",
            json={"release_authority": "FVEY", "format": "xlsx", "include_audit": True, "batch_id": batch_id},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["release_compatibility"]["status"] == "warn"
        assert body["release_warnings"], "warn path must populate release_warnings for the FE banner"
        assert any("downgrade" in msg.lower() for msg in body["release_warnings"])
    finally:
        sentry_route._BATCHES.pop(batch_id, None)
