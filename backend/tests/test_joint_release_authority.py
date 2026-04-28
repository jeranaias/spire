"""
Task-80 — joint export is a topic-style subscription, not a per-operator slice.

Asserts the chosen posture (Option A from the task brief):

  * `/api/joint/oms-uci/export` and `/api/joint/link16/export` emit the
    full MAGTF for any caller who passes BOTH:
        - require_clearance(SECRET)
        - require_role(JOINT_RELEASE_ROLES)
  * Per-operator unit scoping (e.g. maintenance_chief → CLB-6 only) is NOT
    applied — the partner J4 console's view of MAGTF readiness no longer
    depends on which Marine pushed last.
  * Operator-class roles (g4, maintenance_chief) are blocked with a 403
    InsufficientPrivilege so they don't silently truncate the partner feed.
  * Each export's envelope/header carries an `operator` audit footer with
    the calling Marine's identity so the partner can audit who released.

The four mocked CACs from `backend.auth.MOCK_USERS` cover the matrix:
  - 1234567890  GySgt Marcus Reyes      g4                 → 403 (operator scope)
  - 2345678901  MSgt  Diana Kowalski    maintenance_chief  → 403 (operator scope)
  - 3456789012  CWO3  James Park        security_manager   → 200 (release authority)
  - 4567890123  MajGen Robert Hayes     mef_commander      → 200 (release authority)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend import persistence
from backend.scoping import JOINT_RELEASE_ROLES


# Matches `bake_latlon`/`UNIT_COORDS` in backend.routes.joint — the canonical
# MAGTF the joint adapter knows how to render. Encoded here so the test fails
# loudly if a future dataset change drops or renames a unit (which would
# silently shrink the joint feed for everyone).
EXPECTED_UNIT_NAMES = frozenset({
    "CLB-6", "CLB-1", "3d Maint Bn", "3/6 Marines", "2d LAR Bn",
    "MALS-31", "MWSS-271", "2d LAAD Bn", "2/14 Marines", "7th ESB",
})


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _login_role_matrix(client: TestClient, dodid: str, role: str) -> None:
    """Sanity-check that the test fixture role mapping matches what the
    backend session middleware will see, so the assertions below are about
    the role gate and not about a fixture drift."""
    _login(client, dodid)
    me = client.get("/api/auth/me")
    assert me.status_code == 200, me.text
    assert me.json()["user"]["role"] == role, (
        f"fixture drift: dodid {dodid} expected role {role!r}, got {me.json()['user']['role']!r}"
    )


# ---------------------------------------------------------------------------
# Posture invariant
# ---------------------------------------------------------------------------

def test_release_roles_constant_is_topic_release_authority_not_operator():
    """Guard against a regression where someone re-adds operator-class
    roles back into the joint release set."""
    assert "security_manager" in JOINT_RELEASE_ROLES
    assert "mef_commander" in JOINT_RELEASE_ROLES
    assert "g4" not in JOINT_RELEASE_ROLES
    assert "maintenance_chief" not in JOINT_RELEASE_ROLES
    assert "data_custodian" not in JOINT_RELEASE_ROLES


# ---------------------------------------------------------------------------
# OMS / UCI export
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("dodid", "role"),
    [
        ("1234567890", "g4"),
        ("2345678901", "maintenance_chief"),
    ],
)
def test_oms_uci_export_blocks_operator_scoped_roles(client, dodid, role):
    _login_role_matrix(client, dodid, role)
    r = client.get("/api/joint/oms-uci/export")
    assert r.status_code == 403, r.text
    body = r.json()
    detail = body.get("detail", body)
    assert detail.get("error") == "InsufficientPrivilege", detail
    assert detail.get("action") == "joint:oms_uci_export", detail
    assert detail.get("role_seen") == role, detail
    # Caller can see exactly which roles are allowed so the failure is debuggable.
    assert set(detail.get("roles_allowed") or []) == set(JOINT_RELEASE_ROLES)


@pytest.mark.parametrize(
    ("dodid", "role"),
    [
        ("3456789012", "security_manager"),
        ("4567890123", "mef_commander"),
    ],
)
def test_oms_uci_export_emits_full_magtf_for_release_authority(client, dodid, role):
    _login_role_matrix(client, dodid, role)
    r = client.get("/api/joint/oms-uci/export")
    assert r.status_code == 200, r.text
    body = r.json()

    env = body["envelope"]
    assert env["subscriptionModel"] == "TOPIC_FULL_MAGTF"
    op = env["operator"]
    assert op["role"] == role, op
    assert op["dodid"] == dodid, op
    assert op["name"], "operator name must be stamped into envelope"

    # Full MAGTF — every entity in EXPECTED_UNIT_NAMES present in EntityState.
    seen_names = {e["EntityIdentifier"]["callsign"] for e in body["messages"]["EntityState"]}
    assert seen_names == EXPECTED_UNIT_NAMES, (
        f"release-authority pull must see the full MAGTF; "
        f"missing={EXPECTED_UNIT_NAMES - seen_names}, extra={seen_names - EXPECTED_UNIT_NAMES}"
    )

    # Track + Logistics counts mirror the entity count (one per unit).
    counts = env["messageCounts"]
    assert counts["EntityState"] == len(EXPECTED_UNIT_NAMES) == 10
    assert counts["TrackData"] == len(EXPECTED_UNIT_NAMES) == 10
    assert counts["LogisticsStatus"] == len(EXPECTED_UNIT_NAMES) == 10


# ---------------------------------------------------------------------------
# MIL-STD-6016 Link 16 export
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    ("dodid", "role"),
    [
        ("1234567890", "g4"),
        ("2345678901", "maintenance_chief"),
    ],
)
def test_link16_export_blocks_operator_scoped_roles(client, dodid, role):
    _login_role_matrix(client, dodid, role)
    r = client.get("/api/joint/link16/export")
    assert r.status_code == 403, r.text
    detail = r.json().get("detail", {})
    assert detail.get("error") == "InsufficientPrivilege", detail
    assert detail.get("action") == "joint:link16_export", detail


@pytest.mark.parametrize(
    ("dodid", "role"),
    [
        ("3456789012", "security_manager"),
        ("4567890123", "mef_commander"),
    ],
)
def test_link16_export_emits_full_magtf_for_release_authority(client, dodid, role):
    _login_role_matrix(client, dodid, role)
    r = client.get("/api/joint/link16/export")
    assert r.status_code == 200, r.text
    body = r.json()

    hdr = body["header"]
    assert hdr["subscriptionModel"] == "TOPIC_FULL_MAGTF"
    op = hdr["operator"]
    assert op["role"] == role, op
    assert op["dodid"] == dodid, op

    # One J3.5 land-point/track per unit — full MAGTF.
    j35_callsigns = {m["callsign"] for m in body["messages"]["J3_5_LandPointTrack"]}
    assert j35_callsigns == EXPECTED_UNIT_NAMES, (
        f"release-authority pull must see the full MAGTF; "
        f"missing={EXPECTED_UNIT_NAMES - j35_callsigns}, extra={j35_callsigns - EXPECTED_UNIT_NAMES}"
    )
    assert hdr["messageCounts"]["J3.5"] == 10
    assert hdr["messageCounts"]["J7.0"] == 10
    assert hdr["messageCounts"]["J28.2"] == 10


# ---------------------------------------------------------------------------
# Conformance doc — surface the contract so judges can read it directly.
# ---------------------------------------------------------------------------

def test_conformance_documents_topic_subscription_and_role_gate(client):
    # Conformance is open to any signed-in user (it's a doc surface).
    _login(client, "1234567890")
    r = client.get("/api/joint/conformance")
    assert r.status_code == 200, r.text
    body = r.json()

    ra = body.get("releaseAuthority")
    assert ra, "conformance must publish releaseAuthority block"
    assert ra["subscriptionModel"] == "TOPIC_FULL_MAGTF"
    assert set(ra["allowedRoles"]) == set(JOINT_RELEASE_ROLES)

    # Gate description must mention BOTH controls so the contract is visible.
    gate = body["classificationPosture"]["gate"]
    assert "require_clearance" in gate
    assert "require_role" in gate or "JOINT_RELEASE_ROLES" in gate


# ---------------------------------------------------------------------------
# Audit chain — every successful pull must leave a `joint_export_released`
# row so a later auditor can answer "who pushed the MAGTF picture to the
# JLTC at 14:32 yesterday?" (Task #102). Spillage / role-deny are already
# logged via require_clearance / require_role; this is the *successful*
# path that was previously invisible.
# ---------------------------------------------------------------------------

def _joint_release_rows_for(dodid: str, protocol: str) -> list[dict]:
    """Return joint_export_released rows in the chain for this operator
    and protocol. Walks recent_entries so the assertion is independent
    of the SOC view's filtering plumbing."""
    out: list[dict] = []
    for r in persistence.recent_entries(limit=200, include_payload=True):
        if r.get("kind") != "joint_export_released":
            continue
        payload = r.get("payload") or {}
        if not isinstance(payload, dict):
            continue
        if payload.get("user_dodid") != dodid:
            continue
        if payload.get("protocol") != protocol:
            continue
        out.append(r)
    return out


@pytest.mark.parametrize(
    ("dodid", "role", "endpoint", "protocol", "action"),
    [
        ("3456789012", "security_manager", "/api/joint/oms-uci/export", "OMS/UCI", "joint:oms_uci_export"),
        ("4567890123", "mef_commander",    "/api/joint/oms-uci/export", "OMS/UCI", "joint:oms_uci_export"),
        ("3456789012", "security_manager", "/api/joint/link16/export",  "Link 16", "joint:link16_export"),
        ("4567890123", "mef_commander",    "/api/joint/link16/export",  "Link 16", "joint:link16_export"),
    ],
)
def test_successful_joint_pull_stamps_audit_chain(client, dodid, role, endpoint, protocol, action):
    _login_role_matrix(client, dodid, role)

    before = len(_joint_release_rows_for(dodid, protocol))
    r = client.get(endpoint)
    assert r.status_code == 200, r.text

    rows = _joint_release_rows_for(dodid, protocol)
    assert len(rows) == before + 1, (
        f"expected exactly one new joint_export_released row for {role}/{protocol}; "
        f"saw {len(rows) - before}"
    )
    new_row = rows[0]  # recent_entries returns DESC by id

    assert new_row["actor"] == role
    assert new_row["subject_id"] == protocol

    payload = new_row["payload"]
    assert payload["action"] == action
    assert payload["protocol"] == protocol
    assert payload["subscription_model"] == "TOPIC_FULL_MAGTF"
    assert payload["classification"] == "SECRET"
    assert payload["decision"] == "released"
    assert payload["user_role"] == role
    assert payload["user_dodid"] == dodid

    counts = payload["message_counts"]
    assert isinstance(counts, dict) and counts, "message_counts must be populated"
    assert all(isinstance(v, int) for v in counts.values())
    if protocol == "OMS/UCI":
        assert counts.get("EntityState") == 10
        assert counts.get("TrackData") == 10
        assert counts.get("LogisticsStatus") == 10
    else:  # Link 16
        assert counts.get("J3.5") == 10
        assert counts.get("J7.0") == 10
        assert counts.get("J28.2") == 10

    op = payload["operator"]
    assert op["role"] == role
    assert op["dodid"] == dodid
    assert op["name"], "operator name must be stamped into the audit row"


@pytest.mark.parametrize(
    ("dodid", "role", "endpoint"),
    [
        ("1234567890", "g4",                "/api/joint/oms-uci/export"),
        ("2345678901", "maintenance_chief", "/api/joint/oms-uci/export"),
        ("1234567890", "g4",                "/api/joint/link16/export"),
        ("2345678901", "maintenance_chief", "/api/joint/link16/export"),
    ],
)
def test_blocked_joint_pull_does_not_stamp_release_row(client, dodid, role, endpoint):
    """Operator-class roles get a `role_denied` row from `require_role`; they
    must NOT also get a `joint_export_released` row, because nothing was
    released. Guards against a future refactor that moves the audit write
    above the role gate."""
    _login_role_matrix(client, dodid, role)
    protocol = "OMS/UCI" if "oms" in endpoint else "Link 16"

    before = len(_joint_release_rows_for(dodid, protocol))
    r = client.get(endpoint)
    assert r.status_code == 403, r.text
    after = len(_joint_release_rows_for(dodid, protocol))
    assert after == before, (
        f"blocked pull must not stamp a joint_export_released row; "
        f"saw {after - before} new rows for {role}/{protocol}"
    )


# ---------------------------------------------------------------------------
# Cross-pull stability — this is the CDAO question made executable.
# ---------------------------------------------------------------------------

def test_partner_view_stable_across_release_authority_operators(client):
    """The partner J4 view must NOT change when a different release-authority
    Marine pulls. This is the load-bearing claim: the feed is a topic, not a
    per-operator slice."""
    _login(client, "3456789012")  # Park (security_manager)
    park_pull = client.get("/api/joint/oms-uci/export")
    assert park_pull.status_code == 200

    _login(client, "4567890123")  # Hayes (mef_commander)
    hayes_pull = client.get("/api/joint/oms-uci/export")
    assert hayes_pull.status_code == 200

    park_units = {e["EntityIdentifier"]["callsign"] for e in park_pull.json()["messages"]["EntityState"]}
    hayes_units = {e["EntityIdentifier"]["callsign"] for e in hayes_pull.json()["messages"]["EntityState"]}
    assert park_units == hayes_units == EXPECTED_UNIT_NAMES
