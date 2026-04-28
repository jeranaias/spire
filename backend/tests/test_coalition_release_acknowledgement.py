"""
Task #154 — Coalition release over-ceiling acknowledgement.

Asserts the wire contract the frontend depends on:

  * `coalition_view` returns a `sample_srs_over_ceiling_list` array (SR
    number + classification) alongside the existing `sample_srs_over_ceiling`
    count, so the confirmation modal can show *which* records the operator
    is acknowledging instead of just a number.

  * `coalition_release` accepts an `acknowledged_over_ceiling` flag in the
    POST payload and records it on the `sentry_coalition_release` audit
    row alongside the manifest hash. After-action review can then tell
    "warning was shown and acknowledged" from "warning never applied"
    (count == 0) and from "warning shown but not acknowledged" (legacy
    clients pre-#154).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import entries_for_subject


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def test_coalition_view_surfaces_over_ceiling_sr_list(client):
    """JPN_COALITION ceiling is UNCLASSIFIED, so any SECRET/CUI sample
    record is over-ceiling. The view must surface both the count and a
    capped drill-down list so the modal can render SR numbers."""
    # CWO3 Park (security_manager, TS//SCI) — cleared to see the view.
    _login(client, "3456789012")
    r = client.get("/api/sentry/coalition/JPN_COALITION")
    assert r.status_code == 200, r.text
    body = r.json()
    scope = body["scope"]
    assert "sample_srs_over_ceiling" in scope
    assert "sample_srs_over_ceiling_list" in scope
    over_list = scope["sample_srs_over_ceiling_list"]
    assert isinstance(over_list, list)
    # If the count is positive, the list must be non-empty (capped at 25)
    # and each entry must carry the SR number + classification the modal
    # renders.
    if scope["sample_srs_over_ceiling"] > 0:
        assert len(over_list) >= 1
        assert len(over_list) <= 25
        for entry in over_list:
            assert "sr_number" in entry and entry["sr_number"]
            assert "classification" in entry and entry["classification"]


def test_coalition_release_records_acknowledgement_on_audit_row(client):
    """POST with acknowledged_over_ceiling=true must land in the audit
    payload so a security manager reviewing the chain can see the operator
    explicitly ticked the gate. The count stamped onto the row is the
    server-derived value (FVEY_BASE has the highest ceiling, so 0)."""
    _login(client, "3456789012")
    r = client.post(
        "/api/sentry/coalition/FVEY_BASE/release",
        json={
            "actor_role": "security_manager",
            "acknowledged_over_ceiling": True,
            # Client claims 4, but server should authoritatively say 0
            # for FVEY_BASE (its ceiling is the highest authorized class)
            # and stamp the divergence onto the audit row.
            "over_ceiling_count": 4,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    # Response surfaces the server-derived count, not the client's claim.
    assert body.get("over_ceiling_acknowledged") is True
    server_count = body.get("over_ceiling_sample_count")
    assert isinstance(server_count, int)
    assert server_count == 0, (
        f"FVEY_BASE has the highest authorized ceiling, server should "
        f"derive 0 over-ceiling records; got {server_count}"
    )

    rows = entries_for_subject(body["release_id"], limit=10)
    releases = [r for r in rows if r.get("kind") == "sentry_coalition_release"]
    assert len(releases) == 1, f"expected 1 release row in chain; got: {rows!r}"
    payload = releases[0]["payload"]
    assert payload.get("over_ceiling_acknowledged") is True
    assert payload.get("over_ceiling_sample_count") == 0
    # Divergence between client and server count is recorded so an
    # auditor can later see the operator may have acknowledged against
    # a stale view.
    assert payload.get("over_ceiling_client_reported_count") == 4


def test_coalition_release_audit_count_for_low_ceiling_partner(client):
    """Server-derived count is non-zero when the profile ceiling is
    low enough for the dataset to exceed it. JPN_COALITION ceiling is
    UNCLASSIFIED, so the audit row must record a positive count even
    when the client doesn't supply one."""
    _login(client, "3456789012")
    r = client.post(
        "/api/sentry/coalition/JPN_COALITION/release",
        json={
            "actor_role": "security_manager",
            "acknowledged_over_ceiling": True,
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    server_count = body.get("over_ceiling_sample_count")
    assert isinstance(server_count, int) and server_count > 0, (
        f"JPN_COALITION ceiling is UNCLASSIFIED, expected server-derived "
        f"over-ceiling count > 0; got {server_count}"
    )

    rows = entries_for_subject(body["release_id"], limit=10)
    releases = [r for r in rows if r.get("kind") == "sentry_coalition_release"]
    payload = releases[0]["payload"]
    assert payload.get("over_ceiling_sample_count") == server_count
    assert payload.get("over_ceiling_acknowledged") is True
    # Client didn't supply over_ceiling_count → no divergence field stamped.
    assert "over_ceiling_client_reported_count" not in payload


def test_coalition_release_defaults_acknowledgement_to_false(client):
    """Legacy callers (no payload, or no acknowledgement key) record
    acknowledged=False / count=0 so the audit row stays unambiguous."""
    _login(client, "3456789012")
    r = client.post(
        "/api/sentry/coalition/FVEY_BASE/release",
        json={"actor_role": "security_manager"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("over_ceiling_acknowledged") is False
    assert body.get("over_ceiling_sample_count") == 0

    rows = entries_for_subject(body["release_id"], limit=10)
    releases = [r for r in rows if r.get("kind") == "sentry_coalition_release"]
    assert len(releases) == 1
    payload = releases[0]["payload"]
    assert payload.get("over_ceiling_acknowledged") is False
    assert payload.get("over_ceiling_sample_count") == 0
