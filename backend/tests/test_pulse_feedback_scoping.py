"""
Task-84 — focused integration test for POST /api/pulse/feedback/{asset_id}.

Before this task the handler accepted any asset_id, did no role check, and
silently wrote a row even for nonexistent ids. A unit-scoped role
(g4 → 2d MLG) could therefore attach a "correct/incorrect" judgement
(with free-text remark) to a MALS-31 asset they aren't allowed to see, and
that row would feed the fleet-wide `feedback_summary` as if it were
authoritative ground truth. Companion bug to the asset-deep-dive scope
leak (task 63).

This test asserts the three guarantees the fix promises:

  1. POST against an unknown asset_id returns 404 and writes no row.
  2. POST as g4 (Reyes) against a MALS-31 asset (3d MAW, outside 2d MLG)
     returns 403 "asset out of scope" and writes no row.
  3. POST as g4 against an in-scope 2d MLG asset still works (200 OK,
     row appended).
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import conn
from backend.scoping import ROLE_TO_UNITS_FILTER, allowed_units
from backend.state import get_dataset


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _login(c: TestClient, dodid: str) -> None:
    r = c.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _logout(c: TestClient) -> None:
    c.post("/api/auth/logout")


def _feedback_row_count(asset_id: str) -> int:
    with conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n FROM pulse_feedback WHERE asset_id = ?",
            (asset_id,),
        ).fetchone()
    return int(row["n"])


def _pick_asset_outside_g4_scope() -> str:
    """Find a real asset whose unit is NOT in g4's allowed_units. The task
    calls out MALS-31 specifically (3d MAW, outside 2d MLG); fall back to
    any other out-of-scope unit if the seed dataset ever shifts."""
    ds = get_dataset()
    g4_allowed = allowed_units(ds, "g4") or set()
    # Sanity: the role rule must actually filter — if a future edit removes
    # the parent rule for g4 the rest of this test is meaningless.
    assert g4_allowed, "g4 role expected to have a non-empty unit allowlist"
    # Prefer MALS-31 to keep the test text faithful to the bug report.
    for a in ds.assets:
        if a.unit_name == "MALS-31" and a.unit_name not in g4_allowed:
            return a.asset_id
    for a in ds.assets:
        if a.unit_name not in g4_allowed:
            return a.asset_id
    pytest.skip("dataset has no asset outside g4's allowed_units")


def _pick_asset_inside_g4_scope() -> str:
    ds = get_dataset()
    g4_allowed = allowed_units(ds, "g4") or set()
    for a in ds.assets:
        if a.unit_name in g4_allowed:
            return a.asset_id
    pytest.skip("dataset has no asset inside g4's allowed_units")


def test_feedback_unknown_asset_returns_404_and_writes_no_row(client: TestClient):
    _logout(client)
    _login(client, "1234567890")  # g4 — Reyes
    bogus = "ASSET-DOES-NOT-EXIST-XYZ"
    before = _feedback_row_count(bogus)
    r = client.post(
        f"/api/pulse/feedback/{bogus}",
        json={"correct": True, "note": "should not land"},
    )
    assert r.status_code == 404, r.text
    after = _feedback_row_count(bogus)
    assert after == before, (
        "feedback row was written for a nonexistent asset "
        f"(before={before}, after={after})"
    )


def test_feedback_out_of_scope_asset_returns_403_and_writes_no_row(client: TestClient):
    """The headline regression from task 84 — g4 must not be able to attach
    a judgement to a MALS-31 (or any non-2d-MLG) asset they cannot see."""
    target = _pick_asset_outside_g4_scope()
    _logout(client)
    _login(client, "1234567890")  # g4 — Reyes
    before = _feedback_row_count(target)
    r = client.post(
        f"/api/pulse/feedback/{target}",
        json={"correct": False, "note": "out-of-scope poison attempt"},
    )
    assert r.status_code == 403, r.text
    body = r.json()
    detail = body.get("detail")
    if isinstance(detail, dict):
        # Some routes return a structured error envelope; tolerate both.
        assert "out of scope" in str(detail).lower()
    else:
        assert "out of scope" in str(detail).lower()
    after = _feedback_row_count(target)
    assert after == before, (
        "feedback row was written despite a 403 "
        f"(before={before}, after={after})"
    )


def test_feedback_in_scope_asset_still_succeeds(client: TestClient):
    """Positive control: the fix must not break legitimate feedback from a
    role that is properly scoped to the asset's unit."""
    target = _pick_asset_inside_g4_scope()
    _logout(client)
    _login(client, "1234567890")  # g4 — Reyes
    before = _feedback_row_count(target)
    r = client.post(
        f"/api/pulse/feedback/{target}",
        json={"correct": True, "note": "in-scope sanity check"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    assert body.get("asset_id") == target
    after = _feedback_row_count(target)
    assert after == before + 1, (
        f"in-scope feedback row was not appended (before={before}, after={after})"
    )


def test_g4_role_rule_still_filters_2d_mlg():
    """Sanity guard: the test above relies on g4 being scoped to 2d MLG.
    If a future edit to ROLE_TO_UNITS_FILTER changes that, fail loudly so
    the scoping assertion above can be revisited."""
    assert ROLE_TO_UNITS_FILTER["g4"]["parents"] == {"2d MLG"}
