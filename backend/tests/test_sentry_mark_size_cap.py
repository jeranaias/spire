"""
Task-92 — POST /api/sentry/mark must cap free-text input.

The mark endpoint is one of two write surfaces (along with /sentry/export)
that appends to the SPIRE hash-chained audit log. The body itself is not
stored verbatim — only its SHA-256 lands in the audit row — but every
successful call still grows the chain by one row and runs the pattern
engine over the input. A privileged caller (data_custodian or
security_manager) holding a session cookie could otherwise spam multi-MB
inputs to bloat the chain or stall the engine.

This test asserts:

  1. A 1 KB input is still accepted (the today-path), so the cap is not
     accidentally tight enough to break the legitimate paragraph-scale
     remarks the FE samples surface.
  2. A 1 MB input is hard-rejected with HTTP 413 and a structured detail
     that names both the actual byte count and the cap, so the FE error
     toast and the operator's curl both see a clear reason.
  3. The over-cap call does NOT append to the audit chain (the
     short-circuit fires before audit_log()), so an attacker cannot grow
     the chain just by hitting the size limit on every attempt.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import recent_entries
from backend.routes.sentry import MARK_TEXT_MAX_BYTES


SECURITY_MANAGER_DODID = "3456789012"  # MOCK_USERS — clears SENTRY_MARK_ROLES


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _mark_chain_count() -> int:
    # Walk the recent audit entries and count "sentry_mark" rows. Used to
    # prove an over-cap call did not append a chain row.
    return sum(1 for e in recent_entries(limit=500) if e.get("kind") == "sentry_mark")


def test_mark_accepts_1kb_input(client):
    _login(client, SECURITY_MANAGER_DODID)
    text = "Routine maintenance remark. " * 40  # ~1.1 KB, well under cap
    assert len(text.encode("utf-8")) < MARK_TEXT_MAX_BYTES
    r = client.post(
        "/api/sentry/mark",
        json={"text": text, "release_authority": "US_ONLY"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "recommended_classification" in body
    assert body["audit"]["chain_index"] >= 1


def test_mark_rejects_1mb_input_with_413(client):
    _login(client, SECURITY_MANAGER_DODID)
    before = _mark_chain_count()

    # 1 MB of plain ASCII — well over the 16 KB cap.
    text = "A" * (1024 * 1024)
    r = client.post(
        "/api/sentry/mark",
        json={"text": text, "release_authority": "US_ONLY"},
    )

    assert r.status_code == 413, r.text
    detail = r.json().get("detail", "")
    # Numbers must be surfaced so the operator knows what to trim by.
    assert f"{MARK_TEXT_MAX_BYTES:,}" in detail
    assert f"{1024 * 1024:,}" in detail

    # And the chain must NOT have grown — the gate fires before audit_log.
    after = _mark_chain_count()
    assert after == before, (
        "Over-cap /sentry/mark must not append to the audit chain "
        f"(before={before}, after={after})"
    )


def test_mark_rejects_just_over_cap(client):
    _login(client, SECURITY_MANAGER_DODID)
    # Exactly one byte over the cap — boundary case.
    text = "x" * (MARK_TEXT_MAX_BYTES + 1)
    r = client.post(
        "/api/sentry/mark",
        json={"text": text, "release_authority": "US_ONLY"},
    )
    assert r.status_code == 413, r.text


def test_mark_accepts_exactly_at_cap(client):
    _login(client, SECURITY_MANAGER_DODID)
    # Exactly at the cap — must still pass; cap is inclusive.
    text = "y" * MARK_TEXT_MAX_BYTES
    r = client.post(
        "/api/sentry/mark",
        json={"text": text, "release_authority": "US_ONLY"},
    )
    assert r.status_code == 200, r.text
