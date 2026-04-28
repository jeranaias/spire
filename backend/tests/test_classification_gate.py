"""
Task-22 — focused integration test for the SENTRY export deny path.

Asserts that an export attempted by a user whose clearance is below the
bundle's auto-inherited classification produces:

  * HTTP 403
  * a structured JSON body with detail.error == "InsufficientClearance"
    plus the action / required_classification / user_clearance fields
    that the frontend ExportTab now consumes via api.ts ApiError
  * a `spillage_prevented` row in the audit chain

Plus a positive control: a TS//SCI operator (security_manager) is allowed.

The test boots the FastAPI app via TestClient, logs in as one of the four
mock CAC identities, and exercises only public endpoints — no internal
helpers — so it tracks the same wire contract the frontend depends on.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import entries_for_subject
from backend.scoping import require_clearance


@pytest.fixture()
def client():
    # Context-manager form is required so FastAPI runs the lifespan handler
    # that loads the canonical dataset — /sentry/export needs it.
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def test_require_clearance_blocks_under_cleared_user_with_structured_detail():
    """Direct unit test of the gate function — same shape the route uses."""
    from fastapi import HTTPException

    secret_user = {
        "dodid": "1234567890",
        "clearance": "SECRET",
        "role": "g4",
    }

    with pytest.raises(HTTPException) as exc_info:
        require_clearance(
            secret_user,
            "TS//SCI",
            action="sentry.export",
            audit_subject="EXP-TEST-001",
        )

    assert exc_info.value.status_code == 403
    detail = exc_info.value.detail
    assert isinstance(detail, dict), "detail must be a dict so FE can branch on it"
    assert detail["error"] == "InsufficientClearance"
    assert detail["action"] == "sentry.export"
    # `_normalize_classification` canonicalizes "TS//SCI" → "TS_SCI".
    assert detail["required_classification"] == "TS_SCI"
    assert detail["user_clearance"] == "SECRET"

    # Spillage row must reach the persistent audit chain so a downstream
    # security-manager review can see it. Filter by subject_id so multiple
    # test runs in the same DB don't interfere.
    rows = entries_for_subject("EXP-TEST-001", limit=10)
    spills = [
        r for r in rows
        if r.get("kind") == "spillage_prevented"
        and r["payload"].get("user_dodid") == "1234567890"
        and r["payload"].get("required_classification") == "TS_SCI"
    ]
    assert len(spills) >= 1, (
        f"expected a spillage_prevented row in audit chain; got: {rows!r}"
    )
    payload = spills[0]["payload"]
    assert payload["user_clearance"] == "SECRET"
    assert payload["action"] == "sentry.export"
    assert payload["surface"] == "backend"


def test_require_clearance_allows_user_at_or_above_classification():
    """Positive control: TS//SCI operator can read SECRET artifact."""
    ts_user = {"dodid": "3456789012", "clearance": "TS//SCI", "role": "security_manager"}
    # No exception should be raised.
    require_clearance(ts_user, "SECRET", action="sentry.download", audit_subject="EXP-OK")


def test_export_route_for_security_manager_returns_classification_field(client):
    """End-to-end: security_manager (TS//SCI) hits /sentry/export and gets
    back an ExportResult including the auto-inherited classification field
    that the FE badge + clearance gate consumes."""
    _login(client, "3456789012")  # CWO3 Park
    r = client.post(
        "/api/sentry/export",
        json={
            "release_authority": "US_ONLY",
            "format": "xlsx",
            "include_audit": True,
            "batch_id": None,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert "classification" in body, "ExportResult must include classification"
    assert body["classification"] in {"CUI", "SECRET", "TS//SCI", "TOP_SECRET"}
    assert body["download_url"].startswith("/api/sentry/download/")


def test_export_route_blocks_unclassified_persona_with_spillage_audit_row(client):
    """Task #86 — drives the live stage spillage drill end-to-end.

    LCpl Avery Tran (DODID 5678901234) is the UNCLASSIFIED-only records
    clerk seeded into MOCK_USERS specifically so slide 6's 'demonstrated
    end-to-end' claim is honest. She has the `data_custodian` role so the
    SENTRY export role gate (`SENTRY_EXPORT_ROLES`) lets her through to
    the classification gate — at which point the canonical dataset's
    SECRET-or-higher bundle exceeds her UNCLASSIFIED clearance and
    `require_clearance` must fire 403 + write a `spillage_prevented`
    audit row tagged with her DODID. The presenter narrates this exact
    flow on stage; if this test goes red, the slide-6 invitation is no
    longer truthful and the demo script must be pulled back.
    """
    _login(client, "5678901234")  # LCpl Avery Tran — UNCLASSIFIED records clerk
    r = client.post(
        "/api/sentry/export",
        json={
            "release_authority": "US_ONLY",
            "format": "xlsx",
            "include_audit": True,
            "batch_id": None,
        },
    )
    # Classification gate must fire — not the role gate. If we ever see
    # a 403 with `InsufficientPrivilege` here it means the persona
    # drifted off `data_custodian` and the spillage drill no longer
    # exercises the clearance lattice we're claiming on stage.
    assert r.status_code == 403, r.text
    body = r.json()
    detail = body.get("detail") if isinstance(body.get("detail"), dict) else body
    assert detail.get("error") == "InsufficientClearance", (
        f"Expected the classification gate to fire, not the role gate; "
        f"got detail={detail!r}. If `error` is `InsufficientPrivilege`, "
        f"the LCpl Tran persona's role is no longer in SENTRY_EXPORT_ROLES."
    )
    assert detail.get("action") == "sentry.export"
    assert detail.get("user_clearance") == "UNCLASSIFIED"
    assert detail.get("user_role") == "data_custodian"
    # Bundle classification on the canonical dataset is at least SECRET;
    # don't pin the exact value (it can shift with seed updates) but
    # require it to be strictly above UNCLASSIFIED.
    required = detail.get("required_classification")
    assert required in {"CUI", "CONFIDENTIAL", "SECRET", "TOP_SECRET", "TS_SCI"}, (
        f"required_classification must be canonicalized and > UNCLASSIFIED; got {required!r}"
    )

    # Audit chain side effect: the matching `spillage_prevented` row
    # must be reachable from the audit-ledger view the presenter opens
    # next. `require_clearance` writes the row with subject_id=action
    # ("sentry.export") when no explicit audit_subject is passed, so
    # we look it up by subject and filter on user_dodid to avoid
    # false-positives from other test runs sharing the same DB.
    rows = entries_for_subject("sentry.export", limit=50)
    matching = [
        r for r in rows
        if r.get("kind") == "spillage_prevented"
        and r.get("payload", {}).get("user_dodid") == "5678901234"
        and r.get("payload", {}).get("user_clearance") == "UNCLASSIFIED"
        and r.get("payload", {}).get("action") == "sentry.export"
    ]
    assert matching, (
        f"expected a spillage_prevented audit row for LCpl Tran's "
        f"sentry.export attempt; got rows for subject=sentry.export={rows!r}"
    )
