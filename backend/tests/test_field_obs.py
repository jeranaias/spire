"""
Field-observation lane — authorization + advisory-overlay tests.

The lane opens ingest to operator roles for the first time, so the tests that
matter are the ones proving it did *not* open anything else:

  * the feature flag actually gates the lane (503 when unset)
  * a submitter cannot file against a unit outside their own scope, and the
    denial is appended to the audit chain
  * a submitter cannot mark an observation above their own clearance
  * readers see a unit-scoped slice — chief < G-4 < MEF commander
  * **the canonical dataset is not mutated by a submission** — this is the
    property the whole "advisory overlay" design exists to hold
  * promotion is custodian-class, single-shot, and clearance-rechecked

Boots the app via TestClient and signs in through /api/auth/login so the full
session + CSRF + scoping chain is exercised, matching test_bastion_authz.py.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import entries_for_subject
from backend.state import get_dataset


# DoDIDs from backend/auth.py MOCK_USERS. All four carry clearance=CUI.
G4               = "1234567890"  # GySgt Reyes,     role=g4                → 2d MLG
MAINT_CHIEF      = "2345678901"  # MSgt Kowalski,   role=maintenance_chief → CLB-6 only
SECURITY_MANAGER = "3456789012"  # CWO3 Park,       role=security_manager  → unrestricted
MEF_COMMANDER    = "4567890123"  # MajGen Hayes,    role=mef_commander     → unrestricted

# Units from the seeded canonical dataset (seed 42).
IN_SCOPE_CHIEF = "CLB-6"        # parent 2d MLG — visible to chief and G-4
IN_SCOPE_G4    = "7th ESB"      # parent 2d MLG — visible to G-4, not the chief
OUT_OF_MLG     = "CLB-1"        # parent 1st MLG — commander-class only


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def enabled(monkeypatch):
    monkeypatch.setenv("SPIRE_FIELD_OBS_ENABLED", "1")
    yield


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _obs_body(unit: str, **over) -> dict:
    body = {
        "category": "supply_point",
        "summary": "Class I point at MSR junction, 2 pallets remaining",
        "unit_name": unit,
        "lat": 34.6891,
        "lon": -77.3421,
    }
    body.update(over)
    return body


def _submit(client: TestClient, unit: str, **over):
    return client.post("/api/field/observations", json=_obs_body(unit, **over))


# ---------------------------------------------------------------------------
# Feature flag
# ---------------------------------------------------------------------------

def test_lane_is_dormant_until_flag_is_set(client, monkeypatch):
    """Router mounts so the surface is discoverable, but writes 503."""
    monkeypatch.delenv("SPIRE_FIELD_OBS_ENABLED", raising=False)
    _login(client, G4)
    r = _submit(client, IN_SCOPE_CHIEF)
    assert r.status_code == 503
    assert r.json()["detail"]["error"] == "FieldObservationsDisabled"


def test_status_probe_is_open_when_disabled(client, monkeypatch):
    """The policy probe must answer even while the lane is off, so the mobile
    client can render 'not enabled' instead of a generic error."""
    monkeypatch.delenv("SPIRE_FIELD_OBS_ENABLED", raising=False)
    _login(client, MAINT_CHIEF)
    r = client.get("/api/field/status")
    assert r.status_code == 200
    body = r.json()
    assert body["enabled"] is False
    assert body["writable_units"] == [IN_SCOPE_CHIEF]
    assert body["can_resolve"] is False


def test_status_reports_unrestricted_scope_as_null(client, enabled):
    _login(client, MEF_COMMANDER)
    body = client.get("/api/field/status").json()
    assert body["enabled"] is True
    assert body["writable_units"] is None       # null => free unit picker
    assert "supply_point" in body["categories"]


# ---------------------------------------------------------------------------
# Submit — unit-write scope
# ---------------------------------------------------------------------------

def test_operator_can_submit_in_scope(client, enabled):
    _login(client, MAINT_CHIEF)
    r = _submit(client, IN_SCOPE_CHIEF)
    assert r.status_code == 201, r.text
    obs = r.json()
    assert obs["status"] == "advisory"
    assert obs["unit_name"] == IN_SCOPE_CHIEF
    # Provenance is stamped server-side, never taken from the client.
    assert obs["submitter_dodid"] == MAINT_CHIEF
    assert obs["submitter_role"] == "maintenance_chief"
    # CoT shaping is applied so an ATAK bridge has something to serialize.
    assert obs["cot_type"] == "a-f-G-I-B"
    assert obs["stale_at"] > obs["observed_at"]


def test_chief_cannot_file_against_another_battalion(client, enabled):
    """Without this gate a battalion chief could plant an observation on a
    neighbouring battalion's COP."""
    _login(client, MAINT_CHIEF)
    r = _submit(client, IN_SCOPE_G4)
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "UnitOutOfScope"


def test_cross_unit_submit_denial_is_audited(client, enabled):
    _login(client, MAINT_CHIEF)
    _submit(client, OUT_OF_MLG)
    rows = entries_for_subject(OUT_OF_MLG)
    assert any(r["kind"] == "field_obs_scope_blocked" for r in rows), rows


def test_g4_scope_is_wider_than_chief(client, enabled):
    _login(client, G4)
    assert _submit(client, IN_SCOPE_G4).status_code == 201
    # ...but still bounded by parent command.
    assert _submit(client, OUT_OF_MLG).status_code == 403


def test_commander_may_file_anywhere(client, enabled):
    _login(client, MEF_COMMANDER)
    assert _submit(client, OUT_OF_MLG).status_code == 201


def test_unknown_unit_is_rejected(client, enabled):
    _login(client, MEF_COMMANDER)
    r = _submit(client, "Not A Real Unit")
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "UnknownUnit"


def test_unknown_category_is_rejected(client, enabled):
    _login(client, G4)
    r = _submit(client, IN_SCOPE_CHIEF, category="freeform_nonsense")
    assert r.status_code == 400
    assert r.json()["detail"]["error"] == "UnknownCategory"


# ---------------------------------------------------------------------------
# Submit — classification ceiling
# ---------------------------------------------------------------------------

def test_submitter_cannot_mark_above_own_clearance(client, enabled):
    """All four mock Marines hold CUI; SECRET must be refused."""
    _login(client, G4)
    r = _submit(client, IN_SCOPE_CHIEF, classification="SECRET")
    assert r.status_code == 403


def test_marking_is_normalized_on_store(client, enabled):
    _login(client, G4)
    obs = _submit(client, IN_SCOPE_CHIEF, classification="fouo").json()
    assert obs["classification"] == "CUI"


# ---------------------------------------------------------------------------
# The advisory boundary — the reason this lane is separate from /api/ingest
# ---------------------------------------------------------------------------

def test_submission_does_not_mutate_the_canonical_dataset(client, enabled):
    """An unverified handheld report must never reach the GCSS-derived record
    of truth. If this test ever fails, the overlay guarantee is gone."""
    ds = get_dataset()
    before = (len(ds.units), len(ds.assets), ds.generated_at)

    _login(client, MEF_COMMANDER)
    assert _submit(client, OUT_OF_MLG).status_code == 201

    ds_after = get_dataset()
    assert (len(ds_after.units), len(ds_after.assets), ds_after.generated_at) == before


def test_promotion_does_not_mutate_the_canonical_dataset(client, enabled):
    """Promotion records the decision; wiring promoted rows into the dataset
    is a deliberate follow-on. Until then the boundary must hold on both
    sides of the resolve action."""
    _login(client, G4)
    obs_id = _submit(client, IN_SCOPE_CHIEF).json()["obs_id"]

    ds = get_dataset()
    before = (len(ds.units), len(ds.assets), ds.generated_at)

    _login(client, SECURITY_MANAGER)
    assert client.post(f"/api/field/observations/{obs_id}/promote").status_code == 200

    ds_after = get_dataset()
    assert (len(ds_after.units), len(ds_after.assets), ds_after.generated_at) == before


# ---------------------------------------------------------------------------
# Read scoping
# ---------------------------------------------------------------------------

def test_reader_sees_only_units_in_scope(client, enabled):
    """One submission surface; what each reader sees is a function of their
    role, not of what the handheld sent."""
    _login(client, MEF_COMMANDER)
    far = _submit(client, OUT_OF_MLG).json()["obs_id"]
    near = _submit(client, IN_SCOPE_CHIEF).json()["obs_id"]

    _login(client, MAINT_CHIEF)
    body = client.get("/api/field/observations").json()
    ids = {o["obs_id"] for o in body["observations"]}
    assert near in ids
    assert far not in ids
    assert body["scope"] == [IN_SCOPE_CHIEF]

    _login(client, MEF_COMMANDER)
    body = client.get("/api/field/observations").json()
    ids = {o["obs_id"] for o in body["observations"]}
    assert {near, far} <= ids
    assert body["scope"] == "all"


def test_list_rejects_unknown_status_filter(client, enabled):
    _login(client, G4)
    r = client.get("/api/field/observations", params={"status": "bogus"})
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# Resolve — custodian-class, single-shot
# ---------------------------------------------------------------------------

def test_operator_cannot_promote(client, enabled):
    _login(client, G4)
    obs_id = _submit(client, IN_SCOPE_CHIEF).json()["obs_id"]
    r = client.post(f"/api/field/observations/{obs_id}/promote")
    assert r.status_code == 403
    assert r.json()["detail"]["error"] == "InsufficientRole"


def test_commander_cannot_promote_either(client, enabled):
    """Promotion is a data-custody decision, not a command one — it mirrors
    INGEST_ROLES rather than the command hierarchy."""
    _login(client, G4)
    obs_id = _submit(client, IN_SCOPE_CHIEF).json()["obs_id"]
    _login(client, MEF_COMMANDER)
    assert client.post(f"/api/field/observations/{obs_id}/promote").status_code == 403


def test_security_manager_can_promote_once(client, enabled):
    _login(client, G4)
    obs_id = _submit(client, IN_SCOPE_CHIEF).json()["obs_id"]

    _login(client, SECURITY_MANAGER)
    r = client.post(f"/api/field/observations/{obs_id}/promote")
    assert r.status_code == 200
    assert r.json()["status"] == "promoted"
    assert r.json()["resolved_by"] == "security_manager"

    # Second attempt is a conflict, not a silent re-write.
    again = client.post(f"/api/field/observations/{obs_id}/reject")
    assert again.status_code == 409
    assert again.json()["detail"]["error"] == "AlreadyResolved"


def test_promotion_is_audited(client, enabled):
    _login(client, G4)
    obs_id = _submit(client, IN_SCOPE_CHIEF).json()["obs_id"]
    _login(client, SECURITY_MANAGER)
    client.post(f"/api/field/observations/{obs_id}/promote")
    rows = entries_for_subject(obs_id)
    kinds = {r["kind"] for r in rows}
    assert "field_obs_submit" in kinds
    assert "field_obs_promoted" in kinds


def test_resolve_unknown_id_returns_404(client, enabled):
    _login(client, SECURITY_MANAGER)
    r = client.post("/api/field/observations/obs-doesnotexist/promote")
    assert r.status_code == 404


def test_unknown_resolve_action_is_rejected(client, enabled):
    _login(client, SECURITY_MANAGER)
    r = client.post("/api/field/observations/obs-whatever/detonate")
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# The /status probe is role-open, not auth-open
# ---------------------------------------------------------------------------

def test_status_probe_still_requires_a_session(enabled):
    """`/api/field` is classified per-route-gated in tests/test_default_deny_authz.py
    on the strength of this: the probe skips the *role* gate so a handheld can
    discover policy, but session_middleware still rejects anonymous callers."""
    with TestClient(app) as anon:
        assert anon.get("/api/field/status").status_code == 401
        assert anon.get("/api/field/observations").status_code == 401
