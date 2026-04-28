"""
Task #198 — regression test for the Draft Action modal "Risk score 0" bug.

QA-Explorer reported that the PULSE Draft Action modal occasionally
rendered "Risk score 0" even when the originating Risk Board row had a
non-zero risk score (issue #54).

Root cause was in `backend/routes/pulse.py::recommend_actions`. The
fleet-wide branch seeded `risk_score` into each candidate dict from
`top_risk(...)`, but the asset-id branch (the path the Draft Action
modal hits) did not. Later in the same function:

    risk = c.get("risk_score") or 0
    ...
    "description": f"Risk score {risk}; PULSE predicts component failure ..."

… and the per-asset response field:

    "risk_score": c.get("risk_score"),

… both collapsed to 0 / None for the asset-id path. The "Risk score 0"
string was visible in the action description whenever the
`preposition_spares` fallback action fired, which is exactly the
"sometimes" QA observed.

This test pins the asset-id branch:
  * Pick the top-risk asset from /pulse/risk-board (a deliberately
    non-zero score on the synthetic dataset).
  * Call /pulse/recommend-actions?asset_id=<that asset> directly.
  * Assert the per-asset response carries a numeric, non-zero
    `risk_score`.
  * For every action in the response, assert the description does NOT
    contain "Risk score 0" (regardless of whether the description
    happens to render the score at all).

The dataset is deterministic under RANDOM_SEED=42, so a regression here
is real.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str = "4567890123") -> None:
    # MajGen Hayes (mef_commander) — fleet-wide scope so any top-risk
    # asset is reachable without unit-filtering surprises.
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def test_recommend_actions_with_asset_id_returns_real_risk_score(client):
    _login(client)

    # Pick the top-risk asset from the live Risk Board so the test rides
    # the same scoring path the operator would.
    rb = client.get("/api/pulse/risk-board", params={"top": 1})
    assert rb.status_code == 200, rb.text
    assets = rb.json()["assets"]
    assert assets, "risk board returned no assets — dataset regressed?"
    top = assets[0]
    asset_id = top["asset_id"]
    row_score = top["risk_score"]
    assert row_score is not None and row_score > 0, (
        f"Risk Board top row has no positive risk_score ({row_score}); "
        "fixture/data regression — pick a different anchor."
    )

    r = client.get(
        "/api/pulse/recommend-actions",
        params={"asset_id": asset_id, "top": 5},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assets_out = body["assets"]
    assert len(assets_out) == 1, "asset_id query should return exactly one row"
    out = assets_out[0]

    # The per-asset response field must reflect the row's score.
    # Equality is exact: both go through the same risk_score(...) path.
    assert out["asset_id"] == asset_id
    assert out["risk_score"] is not None, (
        "recommend_actions returned null risk_score for an asset_id query — "
        "regression of QA #54."
    )
    assert out["risk_score"] == row_score, (
        f"recommend_actions risk_score ({out['risk_score']}) does not match "
        f"Risk Board row ({row_score}) for {asset_id}."
    )

    # No action description should ever say "Risk score 0" for an asset
    # whose actual score is non-zero. That's the literal regression QA
    # filed under #54.
    for action in out["actions"]:
        desc = action.get("description", "")
        assert "Risk score 0" not in desc, (
            f"Action {action.get('kind')!r} for {asset_id} regressed to "
            f"'Risk score 0' description: {desc!r}"
        )
        # If the action embeds the trigger score in its artifact, that
        # too must reflect the real number, not a 0 fallback.
        artifact = action.get("artifact") or {}
        if "trigger_risk_score" in artifact:
            assert artifact["trigger_risk_score"] == row_score, (
                f"Artifact trigger_risk_score ({artifact['trigger_risk_score']}) "
                f"does not match Risk Board row ({row_score}) for {asset_id}."
            )


def test_recommend_actions_asset_id_404_for_unknown(client):
    """Sanity: the asset-id branch still 404s for a bogus id (no leak of
    the score-lookup change into the not-found path)."""
    _login(client)
    r = client.get(
        "/api/pulse/recommend-actions",
        params={"asset_id": "DOES-NOT-EXIST-9999", "top": 1},
    )
    assert r.status_code == 404, r.text
