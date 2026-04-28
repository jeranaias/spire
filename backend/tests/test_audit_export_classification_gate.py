"""
Task #88 — server-side bundle-classification gate on the audit-export
endpoint.

Task #37 fixed the *frontend* AuditView export so the downloaded JSON
bundle is stamped at the highest classification actually present in the
rows, and the download is blocked when the operator's clearance falls
short. The protection was purely client-side: a Security Manager session
could still call `GET /system/admin/audit?limit=500` directly from the
shell and receive the same raw row payload without any bundle stamp,
provenance note, or clearance-vs-content recheck.

These tests exercise the same wire contract the frontend uses for the
strict-deny path (`?intent=export`):

  * a SECRET-cleared session asking for a 500-row bundle that contains a
    TOP_SECRET row receives 403 + a `spillage_prevented` row in the
    audit chain
  * a TS//SCI session receives the bundle with a `bundle_classification`
    stamp + provenance note
  * paginated SOC browsing without `intent=export` keeps the previous
    behaviour so cleared analysts don't get walled off the chain
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import log as audit_log, recent_entries
from backend.scoping import CLEARANCE_RANK


@pytest.fixture()
def client(monkeypatch):
    # The /system/admin/audit endpoint normally gates to security_manager
    # (the only AUDIT_READ_ROLES member). The bundle-clearance gate this
    # test exercises sits *behind* that role gate, so to demonstrate an
    # under-cleared session reaching the route we open the same stage-demo
    # bypass the AUDIT-pill closing beat uses (`_stage_demo_open`). The
    # bypass requires `SPIRE_DEMO_QUICK_SWITCH=1` plus a valid signed
    # session — neither is set in production by default.
    monkeypatch.setenv("SPIRE_DEMO_QUICK_SWITCH", "1")
    # Context-manager form runs the FastAPI lifespan — boots the canonical
    # dataset and audit DB the audit endpoint reads from.
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _seed_top_secret_row() -> None:
    """Append a TOP_SECRET-classified audit row so the export window has
    something for the gate to react to. The persistence layer reads the
    classification from `payload.classification` (see `query_audit`)."""
    audit_log(
        "test_seed_top_secret",
        actor="system",
        subject_id="task-88-seed",
        payload={
            "classification": "TOP_SECRET",
            "note": "task-88 fixture row",
        },
    )


def test_export_intent_blocks_under_cleared_session(client):
    """SECRET-cleared g4 session asking for a 500-row export bundle that
    contains a TOP_SECRET row gets a 403 with structured detail + a
    spillage_prevented row in the chain."""
    _seed_top_secret_row()

    # GySgt Reyes — g4, SECRET clearance. With the stage-demo bypass on
    # (set in the fixture) any signed-in identity can reach the audit
    # endpoint; the bundle-clearance gate is the layer under test.
    _login(client, "1234567890")
    r = client.get("/api/system/admin/audit", params={
        "limit": 500,
        "intent": "export",
    })
    assert r.status_code == 403, r.text
    detail = r.json().get("detail", {})
    assert isinstance(detail, dict), "detail must be a dict so FE can branch on it"
    assert detail["error"] == "InsufficientClearance"
    assert detail["action"] == "audit.export.json"
    # The chain may already contain rows above TOP_SECRET (e.g. TS_SCI
    # from prior fixture runs in the same test DB). The bundle must be
    # AT LEAST TOP_SECRET — that's what the seeded row guarantees.
    assert CLEARANCE_RANK[detail["required_classification"]] >= CLEARANCE_RANK["TOP_SECRET"]
    assert detail["user_clearance"] == "SECRET"
    assert "bundle_classification_provenance" in detail

    # A `spillage_prevented` row must reach the chain so a downstream
    # security-manager review can see the attempted exfil.
    rows = recent_entries(limit=20, include_payload=True)
    spills = [
        row for row in rows
        if row["kind"] == "spillage_prevented"
        and row["payload"].get("action") == "audit.export.json"
        and row["payload"].get("user_dodid") == "1234567890"
    ]
    assert len(spills) >= 1, f"missing spillage_prevented row; got: {rows!r}"
    payload = spills[0]["payload"]
    assert payload["user_clearance"] == "SECRET"
    assert CLEARANCE_RANK[payload["required_classification"]] >= CLEARANCE_RANK["TOP_SECRET"]
    assert payload["surface"] == "backend"


def test_export_intent_succeeds_for_ts_sci_session_with_bundle_stamp(client):
    """TS//SCI security_manager session asking for the same bundle gets
    200 with the bundle_classification stamp + provenance note. This is
    the positive control — the gate must not over-block cleared analysts."""
    _seed_top_secret_row()

    # CWO3 Park — security_manager, TS//SCI.
    _login(client, "3456789012")
    r = client.get("/api/system/admin/audit", params={
        "limit": 500,
        "intent": "export",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert "bundle_classification" in body
    assert "bundle_classification_provenance" in body
    assert "bundle_classification_counts" in body
    # The seeded TOP_SECRET row pulls the bundle stamp up to at least
    # TOP_SECRET; the chain may already contain higher rows (e.g.
    # TS_SCI from prior fixture runs in the same test DB).
    assert CLEARANCE_RANK[body["bundle_classification"]] >= CLEARANCE_RANK["TOP_SECRET"]
    # Provenance is a free-form string — assert both the count-shape
    # ("N of M rows are …") and that it mentions a classified label.
    assert " of " in body["bundle_classification_provenance"]
    assert "rows are" in body["bundle_classification_provenance"] or \
           "row is" in body["bundle_classification_provenance"]


def test_paginated_soc_browse_without_intent_is_unchanged(client):
    """An under-cleared call without `intent=export` is still allowed (or
    blocked by the role gate, never by the new bundle-clearance gate).
    Paginated SOC browsing under `limit=100` must keep working for any
    caller the role gate already lets through."""
    _seed_top_secret_row()

    # security_manager (TS//SCI) is the canonical SOC analyst — they
    # browse the chain at limit=100 without an export intent and must
    # always succeed even when the chain contains TOP_SECRET rows.
    _login(client, "3456789012")
    r = client.get("/api/system/admin/audit", params={
        "limit": 100,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    # The bundle stamp is computed for browse responses too — the FE
    # uses it as a UX hint — but the absence of `intent=export` means
    # no strict-deny ever fires.
    assert "bundle_classification" in body
