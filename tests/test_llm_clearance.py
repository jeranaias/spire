"""LLM caller-clearance is derived from the session (P1-2), never hardcoded."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app

SECURITY_MANAGER = "3456789012"  # mock user, clearance "CUI"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _login(c, dodid):
    assert c.post("/api/auth/login", json={"dodid": dodid, "pin": "000000"}).status_code == 200


def test_chat_forwards_session_clearance(client, monkeypatch):
    captured = {}

    async def fake_call_llm_chat(**kwargs):
        captured.update(kwargs)
        return {"content": "ok"}

    monkeypatch.setattr("backend.routes.llm.call_llm_chat", fake_call_llm_chat)
    _login(client, SECURITY_MANAGER)
    r = client.post("/api/llm/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200
    # Clearance comes from the session user (CUI), not the old hardcoded UNCLASSIFIED.
    assert captured["caller_clearance"] == "CUI"


def test_chat_ignores_client_supplied_clearance(client, monkeypatch):
    """A client can't spoof a higher clearance via the payload."""
    captured = {}

    async def fake_call_llm_chat(**kwargs):
        captured.update(kwargs)
        return {"content": "ok"}

    monkeypatch.setattr("backend.routes.llm.call_llm_chat", fake_call_llm_chat)
    _login(client, SECURITY_MANAGER)
    r = client.post(
        "/api/llm/chat",
        json={"messages": [{"role": "user", "content": "hi"}], "caller_clearance": "TOP_SECRET"},
    )
    assert r.status_code == 200
    assert captured["caller_clearance"] == "CUI"  # session value wins
