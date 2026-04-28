"""
Task #130 — the "model card →" link in the PULSE Forecast tab points
at /admin/models/pulse-risk (a stable, judge-friendly slug pinned by
test_forecast_links_to_model_card). The canonical registry id is
"pulse-risk-scorer". The admin detail endpoint must resolve the slug
to the canonical record so the legend link actually lands somewhere.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str = "3456789012") -> None:
    """Login as CWO3 James Park (security_manager) — only role allowed
    to read /admin/models/*."""
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def test_pulse_risk_alias_resolves_to_canonical_scorer(client):
    """`/system/admin/models/pulse-risk` must return the same record as
    `/system/admin/models/pulse-risk-scorer`, with `resolved_model_id`
    echoed so the front-end can render a stable cross-link back to
    the supply chain."""
    _login(client)
    role = "security_manager"
    alias = client.get(
        "/api/system/admin/models/pulse-risk", params={"role": role}
    )
    canonical = client.get(
        "/api/system/admin/models/pulse-risk-scorer", params={"role": role}
    )
    assert alias.status_code == 200, alias.text
    assert canonical.status_code == 200, canonical.text

    a, c = alias.json(), canonical.json()
    assert a["model"]["id"] == "pulse-risk-scorer"
    assert a["model"]["id"] == c["model"]["id"]
    assert a.get("resolved_model_id") == "pulse-risk-scorer"


def test_unknown_alias_still_404s(client):
    _login(client)
    r = client.get(
        "/api/system/admin/models/not-a-real-model",
        params={"role": "security_manager"},
    )
    assert r.status_code == 404
