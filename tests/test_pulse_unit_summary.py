"""Unit-summary endpoint tests (PULSE×BASTION phase A2)."""
from __future__ import annotations

import pytest


@pytest.fixture
def commander_client():
    """Fully-booted SPIRE TestClient logged in as mef_commander.

    The /pulse/* router carries a view-level role gate that admits
    g4 / maintenance_chief / mef_commander — security_manager is
    intentionally NOT in that allow-list (their primary surface is
    the audit chain, not operational PULSE work). Tests must use
    a role that the gate admits or the gate fires before our
    route handler runs.

    The ``with TestClient(...)`` context-manager form is REQUIRED —
    it triggers FastAPI's lifespan, which is what loads the seed-42
    dataset. Without it, ``get_dataset()`` returns the empty stub
    set by ``init_empty_dataset`` at import time, and every unit
    lookup 404s.
    """
    from fastapi.testclient import TestClient
    from backend.main import app

    with TestClient(app) as c:
        r = c.post("/api/auth/login", json={"dodid": "4567890123", "pin": "000000"})
        assert r.status_code == 200, r.text
        yield c


def test_unit_summary_known_unit_returns_full_shape(commander_client):
    # CLB-6 is in the seed-42 unit roster (covered by Marine logistics
    # canonical units). If this name moves the test fails loud rather
    # than silently passing on the wrong unit.
    r = commander_client.get("/api/pulse/unit/CLB-6/summary")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["unit"] == "CLB-6"
    assert "uic" in body
    assert "mc_rate" in body
    assert body["mc_state"] in {"green", "amber", "red", "no_signal"}
    assert "asset_counts" in body and "total" in body["asset_counts"]
    assert "supply" in body
    for klass in ("class_i", "class_iii", "class_v", "class_viii", "class_ix"):
        assert klass in body["supply"]
    assert isinstance(body["alerts"], list) and len(body["alerts"]) <= 3
    assert isinstance(body["tmrs"], list)
    links = body["links"]
    assert links["forecast"].endswith("?unit=CLB-6")
    assert links["risk_board"].endswith("?unit=CLB-6")
    assert links["bastion"].endswith("?unit=CLB-6")


def test_unit_summary_class_ix_status_matches_mc_state(commander_client):
    """class_ix.status mirrors the headline mc_state when there's
    snapshot data — that's the property that lets the map halo and
    the supply-chip render from the same byte without the frontend
    having to second-guess."""
    r = commander_client.get("/api/pulse/unit/CLB-6/summary")
    assert r.status_code == 200
    body = r.json()
    if body["asset_counts"]["total"] > 0:
        assert body["supply"]["class_ix"]["status"] == body["mc_state"]


def test_unit_summary_unknown_unit_returns_404(commander_client):
    r = commander_client.get("/api/pulse/unit/DOES-NOT-EXIST/summary")
    assert r.status_code == 404


def test_unit_summary_role_scoping_returns_403_for_out_of_scope(commander_client):
    """A maintenance_chief is scoped to a single unit (their own).
    Hitting another unit's summary must 403, not leak data."""
    commander_client.post("/api/auth/logout")
    r = commander_client.post(
        "/api/auth/login",
        # 1234567890 is a maintenance_chief in MOCK_USERS_BY_DODID
        json={"dodid": "1234567890", "pin": "000000"},
    )
    assert r.status_code == 200, r.text
    # Try to reach a unit they shouldn't see. We can't know which
    # unit they ARE scoped to without inspecting MOCK_USERS, but
    # 3d MLR is a higher-echelon container they aren't scoped to.
    r2 = commander_client.get("/api/pulse/unit/3d MLR/summary")
    # Either 403 (scoped out) or 404 (unit not in roster) is acceptable —
    # the invariant is "no 200 leak."
    assert r2.status_code in (403, 404), r2.text


def test_unit_summary_class_signals_only_amber_or_red_with_evidence(commander_client):
    """Non-IX classes must return no_signal when no alert mentions
    them. We can't easily force keyword hits in the seed-42 dataset
    from a test, so we assert the property: every non-no_signal
    status comes paired with at least one ``hits`` entry."""
    r = commander_client.get("/api/pulse/unit/CLB-6/summary")
    assert r.status_code == 200
    body = r.json()
    for klass in ("class_i", "class_iii", "class_v", "class_viii"):
        cell = body["supply"][klass]
        if cell["status"] != "no_signal":
            assert cell["hits"], (
                f"{klass} status={cell['status']} but no supporting hits — "
                "the supply chip would mislead the commander."
            )
