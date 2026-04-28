"""Task-171 — /sentry/mark must surface the engine's redacted form of the
operator's text whenever an auto-added caveat (NOFORN, FOUO//LES) hard-blocks
the release. The right pane uses the new ``sanitized_text`` field to render a
"Use sanitized excerpt" button so the operator does not have to manually
rewrite the paragraph the engine just refused.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.routes import sentry as sentry_route


DODID_DATA_CUSTODIAN = "3456789012"  # security_manager — also clears /mark


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Helper unit test
# ---------------------------------------------------------------------------

def test_sanitize_with_highlights_replaces_spans_with_rule_token():
    text = "Per [CLASSIFIED TM XX-XXXX-XXX-XX-X] the array is degraded."
    tier = sentry_route.tier1_classify(text)
    spans = [h for h in tier["highlights"] if h["category"] == "classified"]
    assert spans, "fixture must contain a classified-TM span"

    sanitized = sentry_route._sanitize_with_highlights(text, spans)
    assert "[CLASSIFIED TM" not in sanitized
    assert "[REDACTED:CLS_TM]" in sanitized
    # Untouched prose preserved verbatim
    assert sanitized.startswith("Per ")
    assert sanitized.endswith(" the array is degraded.")


# ---------------------------------------------------------------------------
# /sentry/mark integration
# ---------------------------------------------------------------------------

def test_mark_blocked_release_to_fvey_returns_sanitized_text(client):
    _login(client, DODID_DATA_CUSTODIAN)
    text = (
        "Phased array calibration exceeding threshold. Recalibrated per "
        "[CLASSIFIED TM XX-XXXX-XXX-XX-X]. POC: SSgt Martinez."
    )
    r = client.post(
        "/api/sentry/mark",
        json={"text": text, "release_authority": "FVEY"},
    )
    assert r.status_code == 200, r.text
    body = r.json()

    # Sanity: the engine self-introduced NOFORN and the validator hard-blocked.
    assert body["release_compatibility"]["status"] == "block"
    assert any(c["caveat"] == "NOFORN" for c in body["auto_caveats"])

    # The new field must be present and must contain the redaction token.
    sanitized = body.get("sanitized_text")
    assert isinstance(sanitized, str) and sanitized, "sanitized_text required on block"
    assert "[CLASSIFIED TM" not in sanitized
    assert "[REDACTED:CLS_TM]" in sanitized


def test_mark_resubmitting_sanitized_text_unblocks_release(client):
    """Acceptance: re-running on the sanitized text removes the auto-added
    caveat and the validator returns to status="warn" or "ok"."""
    _login(client, DODID_DATA_CUSTODIAN)
    text = (
        "Recalibrated array per [CLASSIFIED TM XX-XXXX-XXX-XX-X]. "
        "Logged for depot review."
    )
    first = client.post(
        "/api/sentry/mark",
        json={"text": text, "release_authority": "FVEY"},
    ).json()
    assert first["release_compatibility"]["status"] == "block"
    sanitized = first["sanitized_text"]
    assert sanitized

    second = client.post(
        "/api/sentry/mark",
        json={"text": sanitized, "release_authority": "FVEY"},
    ).json()
    assert second["release_compatibility"]["status"] != "block", (
        f"resubmitting sanitized text should clear the block; got "
        f"{second['release_compatibility']}"
    )
    assert not any(c["caveat"] == "NOFORN" for c in second["auto_caveats"])


def test_mark_us_only_release_does_not_attach_sanitized_text(client):
    """Same classified-TM input, but US_ONLY release authority — there is no
    block (NOFORN is compatible with US_ONLY), so the field stays None and
    the FE will not render the button.
    """
    _login(client, DODID_DATA_CUSTODIAN)
    text = "Per [CLASSIFIED TM XX-XXXX-XXX-XX-X], replaced module."
    r = client.post(
        "/api/sentry/mark",
        json={"text": text, "release_authority": "US_ONLY"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["release_compatibility"]["status"] != "block"
    assert body.get("sanitized_text") is None


def test_mark_clean_text_has_no_sanitized_text(client):
    _login(client, DODID_DATA_CUSTODIAN)
    r = client.post(
        "/api/sentry/mark",
        json={
            "text": "Routine fault — replaced output seal IAW TM 9-2320-391-20.",
            "release_authority": "FVEY",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("sanitized_text") is None
