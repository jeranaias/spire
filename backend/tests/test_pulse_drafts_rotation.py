"""
Task #144 — held-drafts queue rotation.

Without these guard rails the `pulse_drafts.held` queue grows forever:
the only path out of `held` is an explicit Dismiss click, so a long
demo (or any real deployment) silently inflates the DraftsBadge count
and the audit log fills with `pulse_draft_action` rows that never see a
matching dismiss / approve.

The persistence-layer sweep (`expire_stale_pulse_drafts`) is what keeps
the surface honest. This test exercises it directly so the guarantee
"expired drafts no longer count toward the badge" can't quietly
regress, plus a TestClient round-trip on `/pulse/drafts` to confirm the
route lazy-ticks the sweep before answering.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import (
    conn,
    expire_stale_pulse_drafts,
    list_pulse_drafts,
    record_pulse_draft,
    recent_entries,
)


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _wipe_drafts() -> None:
    """Each test owns its own slice of `pulse_drafts` so order-of-tests
    can't poison the counts. The audit log is append-only by design;
    we don't truncate it."""
    with conn() as c:
        c.execute("DELETE FROM pulse_drafts")


def _make_draft(asset_id: str, *, unit: str, title: str) -> str:
    d = record_pulse_draft(
        asset_id=asset_id,
        kind="expedite_part",
        title=title,
        actor="g4",
        unit_name=unit,
        description="rotation test",
        cost_usd=1234.0,
        mc_delta_pct=0.05,
        time_to_effect_hours=2.0,
        artifact={"source": "rotation_test"},
    )
    return d["draft_id"]


def _backdate(draft_id: str, hours: float) -> None:
    """Move a draft's `created_at` into the past so the TTL sweep can
    catch it without sleeping the test."""
    past = datetime.utcnow() - timedelta(hours=hours)
    iso = past.isoformat(timespec="seconds") + "Z"
    with conn() as c:
        c.execute(
            "UPDATE pulse_drafts SET created_at = ? WHERE draft_id = ?",
            (iso, draft_id),
        )


def test_ttl_expiry_drops_drafts_from_held_and_audits_transition(monkeypatch):
    """Drafts older than the TTL roll into `expired` and get a
    matching audit row. The held-only listing (which the badge counts)
    must drop them."""
    monkeypatch.setenv("SPIRE_DRAFT_TTL_HOURS", "1")
    monkeypatch.setenv("SPIRE_DRAFT_CAP_PER_UNIT", "100")  # not under test here
    _wipe_drafts()

    fresh_id = _make_draft("asset-fresh", unit="2/2", title="fresh")
    stale_id = _make_draft("asset-stale", unit="2/2", title="stale")
    _backdate(stale_id, hours=4)  # well past 1h TTL

    summaries = expire_stale_pulse_drafts()

    expired_ids = {s["draft_id"] for s in summaries}
    assert stale_id in expired_ids, "TTL pass should expire the backdated draft"
    assert fresh_id not in expired_ids, "Fresh draft must not be expired"
    assert all(s["reason"] == "ttl" for s in summaries if s["draft_id"] == stale_id)

    held = list_pulse_drafts(status="held", limit=100)
    held_ids = {d["draft_id"] for d in held}
    assert fresh_id in held_ids
    assert stale_id not in held_ids, (
        "Expired drafts must not appear in the held listing — that's the "
        "listing the TopBar badge counts."
    )

    expired = list_pulse_drafts(status="expired", limit=100)
    assert stale_id in {d["draft_id"] for d in expired}

    # Audit chain must record the transition keyed by the draft_id.
    recent = recent_entries(limit=50, include_payload=True)
    matches = [
        r for r in recent
        if r.get("kind") == "pulse_draft_expire" and r.get("subject_id") == stale_id
    ]
    assert matches, "Expiry must write a pulse_draft_expire audit row"
    assert matches[-1]["payload"]["reason"] == "ttl"


def test_per_unit_cap_expires_oldest_overflow(monkeypatch):
    """When a single unit accumulates more than the cap, only the N
    most-recent held drafts survive; the older ones get rotated to
    `expired` with reason `cap`."""
    monkeypatch.setenv("SPIRE_DRAFT_TTL_HOURS", "999999")  # disable TTL pass
    monkeypatch.setenv("SPIRE_DRAFT_CAP_PER_UNIT", "3")
    _wipe_drafts()

    # Five drafts in one unit; backdate them in increasing-recency order
    # so the cap pass has a clean ordering to evaluate.
    ids: list[str] = []
    for i in range(5):
        did = _make_draft(f"asset-cap-{i}", unit="3/3", title=f"cap {i}")
        _backdate(did, hours=10 - i)  # i=0 is oldest, i=4 is newest
        ids.append(did)

    summaries = expire_stale_pulse_drafts()
    cap_ids = {s["draft_id"] for s in summaries if s["reason"] == "cap"}

    # Two oldest must be the ones expired.
    assert cap_ids == {ids[0], ids[1]}, (
        f"Expected oldest two to be capped, got {cap_ids}"
    )

    held = list_pulse_drafts(status="held", limit=100)
    held_ids = {d["draft_id"] for d in held}
    assert held_ids == {ids[2], ids[3], ids[4]}
    assert len(held) == 3, "Cap of 3 must be honored"


def test_pulse_drafts_route_lazy_ticks_sweep_and_filters_badge(monkeypatch, client):
    """End-to-end: posting /pulse/drafts must run the rotation sweep
    so callers (the DraftsBadge) never see expired rows in the held
    listing — even if no other request has triggered the sweep."""
    monkeypatch.setenv("SPIRE_DRAFT_TTL_HOURS", "1")
    monkeypatch.setenv("SPIRE_DRAFT_CAP_PER_UNIT", "100")
    _wipe_drafts()

    # Sign in as mef_commander so the role gate is satisfied AND the
    # caller has unrestricted unit visibility (otherwise the route's
    # `allowed_units` filter would drop the test fixtures' units).
    r = client.post("/api/auth/login", json={"dodid": "4567890123", "pin": "123456"})
    assert r.status_code == 200, r.text

    fresh_id = _make_draft("asset-route-fresh", unit="CLB-6", title="fresh")
    stale_id = _make_draft("asset-route-stale", unit="CLB-6", title="stale")
    _backdate(stale_id, hours=5)

    r = client.get("/api/pulse/drafts?status=held")
    assert r.status_code == 200, r.text
    body = r.json()
    held_ids = {d["draft_id"] for d in body["drafts"]}
    assert fresh_id in held_ids
    assert stale_id not in held_ids
    assert body["count"] == len(body["drafts"])

    # The expired bucket must be reachable via the same route for the
    # frontend "Show expired" toggle.
    r = client.get("/api/pulse/drafts?status=expired")
    assert r.status_code == 200, r.text
    expired_ids = {d["draft_id"] for d in r.json()["drafts"]}
    assert stale_id in expired_ids


def test_repeat_sweep_is_idempotent_no_duplicate_audit_rows(monkeypatch):
    """A second sweep on the same already-expired draft must not write a
    second `pulse_draft_expire` audit row. The conditional UPDATE +
    rowcount==1 guard inside the helper is what makes this safe under
    concurrent /pulse/drafts polling."""
    monkeypatch.setenv("SPIRE_DRAFT_TTL_HOURS", "1")
    monkeypatch.setenv("SPIRE_DRAFT_CAP_PER_UNIT", "100")
    _wipe_drafts()

    stale_id = _make_draft("asset-idempotent", unit="2/2", title="stale")
    _backdate(stale_id, hours=4)

    first = expire_stale_pulse_drafts()
    second = expire_stale_pulse_drafts()

    assert any(s["draft_id"] == stale_id for s in first)
    assert second == [], "Second sweep on an already-expired draft must be a no-op"

    matches = [
        r for r in recent_entries(limit=200, include_payload=False)
        if r.get("kind") == "pulse_draft_expire" and r.get("subject_id") == stale_id
    ]
    assert len(matches) == 1, (
        f"Expected exactly one pulse_draft_expire audit row, got {len(matches)}"
    )


def test_pulse_drafts_route_rejects_unknown_status(client):
    r = client.post("/api/auth/login", json={"dodid": "1234567890", "pin": "123456"})
    assert r.status_code == 200
    r = client.get("/api/pulse/drafts?status=bogus")
    assert r.status_code == 400
