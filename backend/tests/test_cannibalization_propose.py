"""
Task #148 — backend regression suite for the cannibalization-propose
validation gates first hardened in Task #41.

`POST /api/pulse/cannibalization/propose` enforces five gates:
  1. role           — actor must be in `_PROPOSE_ROLES`
  2. recipient SR   — must exist in the canonical dataset
  3. scope          — recipient AND donor unit must be in actor scope
  4. NSN match      — supplied NSN must be on a pending requisition
  5. self-cannib    — recipient_sr != donor_sr unless `self_cannib=true`

Each is exercised through the public HTTP surface using TestClient with a
real signed session cookie (via `/api/auth/login` against MOCK_USERS).
The happy path is asserted for g4 and mef_commander, and the audit-chain
side-effect is verified so a future refactor that drops persistence also
fails the test. Fixtures are discovered dynamically from the loaded
dataset + `allowed_units(role)` so the suite is robust to dataset and
role-mapping changes.
"""
from __future__ import annotations

from typing import Optional

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import recent_entries
from backend.scoping import allowed_units
from backend.state import get_dataset


# Mock CAC DODIDs from `backend/auth.py` MOCK_USERS.
DODID_G4               = "1234567890"  # GySgt Reyes,    role=g4
DODID_MAINT_CHIEF      = "2345678901"  # MSgt  Kowalski, role=maintenance_chief
DODID_SECURITY_MANAGER = "3456789012"  # CWO3  Park,     role=security_manager
DODID_MEF_COMMANDER    = "4567890123"  # MajGen Hayes,   role=mef_commander


@pytest.fixture(scope="module")
def client():
    # Context-manager form runs the lifespan handler so the canonical
    # dataset is loaded — every gate in the propose route needs it.
    with TestClient(app) as c:
        yield c


def _login(c: TestClient, dodid: str) -> None:
    r = c.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _logout(c: TestClient) -> None:
    c.post("/api/auth/logout")


def _err_detail(body) -> dict:
    """Extract the structured error block. FastAPI puts HTTPException.detail
    under `detail`; tolerate either shape."""
    if not isinstance(body, dict):
        return {}
    inner = body.get("detail")
    return inner if isinstance(inner, dict) else body


def _scope_units_for(role: str) -> set[str]:
    """Resolve the units `role` is allowed to see. Falls back to the full
    fleet for unrestricted roles (mef_commander)."""
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    if allowed is None:
        return {u.name for u in ds.units}
    return allowed


def _find_recipient_with_pending_req(units: set[str]) -> tuple[str, str, str, str]:
    """Find an SR in `units` with at least one pending requisition.
    Returns (sr_number, asset_id, nsn, unit_name)."""
    ds = get_dataset()
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    for sr in ds.srs:
        if sr.unit_name not in units:
            continue
        pending = [
            r.nsn for r in sr.requisitions
            if r.received_date is None or (last_day and r.received_date > last_day)
        ]
        if pending:
            return sr.sr_number, sr.asset_id, pending[0], sr.unit_name
    raise RuntimeError(
        f"no SR with pending requisitions found in units={sorted(units)}"
    )


def _find_donor_asset_in_unit(unit_name: str, *, exclude_asset_id: str) -> str:
    """Pick any asset in `unit_name` other than `exclude_asset_id`. The
    propose endpoint accepts an asset-keyed donor."""
    ds = get_dataset()
    for a in ds.assets:
        if a.unit_name == unit_name and a.asset_id != exclude_asset_id:
            return a.asset_id
    raise RuntimeError(
        f"no donor asset found in unit={unit_name!r} other than {exclude_asset_id!r}"
    )


def _propose_payload(
    *,
    recipient_sr: str,
    donor_asset_id: Optional[str] = None,
    donor_sr: Optional[str] = None,
    nsn: str,
    self_cannib: bool = False,
) -> dict:
    payload: dict = {"recipient_sr": recipient_sr, "nsn": nsn}
    if donor_asset_id is not None:
        payload["donor_asset_id"] = donor_asset_id
    if donor_sr is not None:
        payload["donor_sr"] = donor_sr
    if self_cannib:
        payload["self_cannib"] = True
    return payload


# ---------------------------------------------------------------------------
# Gate 1 — role
# ---------------------------------------------------------------------------

def test_security_manager_blocked_with_403(client: TestClient):
    """security_manager is outside both PULSE_VIEW_ROLES and _PROPOSE_ROLES.
    Either gate is acceptable (view-scope fires first); the contract is
    "non-propose-role CAC cannot reach the audit chain through this
    endpoint" with a structured 403."""
    _logout(client)
    _login(client, DODID_SECURITY_MANAGER)

    # Use a real recipient SR so the role/scope gate trips, not the 404 gate.
    g4_units = _scope_units_for("g4")
    sr_number, asset_id, nsn, unit_name = _find_recipient_with_pending_req(g4_units)
    donor_asset = _find_donor_asset_in_unit(unit_name, exclude_asset_id=asset_id)

    r = client.post(
        "/api/pulse/cannibalization/propose",
        json=_propose_payload(
            recipient_sr=sr_number,
            donor_asset_id=donor_asset,
            nsn=nsn,
        ),
    )
    assert r.status_code == 403, r.text
    detail = _err_detail(r.json())
    assert detail.get("error") in {"OutOfScope", "InsufficientPrivilege"}, detail
    actor_role = detail.get("user_role") or detail.get("role_seen")
    assert actor_role == "security_manager", detail

    # No proposal row was written.
    proposals_by_sm = [
        e for e in recent_entries(limit=20)
        if e["kind"] == "cannibalization_propose" and e["actor"] == "security_manager"
    ]
    assert proposals_by_sm == [], proposals_by_sm


# ---------------------------------------------------------------------------
# Gate 2 — recipient SR exists
# ---------------------------------------------------------------------------

def test_unknown_recipient_sr_returns_404(client: TestClient):
    _logout(client)
    _login(client, DODID_G4)

    any_asset = next(a.asset_id for a in get_dataset().assets)

    r = client.post(
        "/api/pulse/cannibalization/propose",
        json=_propose_payload(
            recipient_sr="SR-DOES-NOT-EXIST-9999",
            donor_asset_id=any_asset,
            nsn="9999-99-999-9999",
        ),
    )
    assert r.status_code == 404, r.text
    detail = _err_detail(r.json())
    assert detail.get("error") == "UnknownRecipient", detail
    assert detail.get("field") == "recipient_sr", detail
    assert detail.get("value") == "SR-DOES-NOT-EXIST-9999", detail


# ---------------------------------------------------------------------------
# Gate 3 — scope
# ---------------------------------------------------------------------------

def test_out_of_scope_recipient_returns_403_for_g4(client: TestClient):
    """A recipient SR sitting outside g4's scope must 403 with OutOfScope."""
    _logout(client)
    _login(client, DODID_G4)

    g4_units = _scope_units_for("g4")
    out_of_scope_units = {u.name for u in get_dataset().units} - g4_units
    sr_number, asset_id, nsn, unit_name = _find_recipient_with_pending_req(out_of_scope_units)
    donor_asset = _find_donor_asset_in_unit(unit_name, exclude_asset_id=asset_id)

    r = client.post(
        "/api/pulse/cannibalization/propose",
        json=_propose_payload(
            recipient_sr=sr_number,
            donor_asset_id=donor_asset,
            nsn=nsn,
        ),
    )
    assert r.status_code == 403, r.text
    detail = _err_detail(r.json())
    assert detail.get("error") == "OutOfScope", detail
    assert detail.get("action") == "cannibalization_propose", detail
    assert detail.get("role_seen") == "g4", detail
    legs = {leg for (leg, _unit) in (detail.get("out_of_scope") or [])}
    assert "recipient" in legs and "donor" in legs, detail


# ---------------------------------------------------------------------------
# Gate 4 — NSN match
# ---------------------------------------------------------------------------

def test_nsn_mismatch_returns_400(client: TestClient):
    _logout(client)
    _login(client, DODID_G4)

    g4_units = _scope_units_for("g4")
    sr_number, asset_id, real_nsn, unit_name = _find_recipient_with_pending_req(g4_units)
    donor_asset = _find_donor_asset_in_unit(unit_name, exclude_asset_id=asset_id)

    bogus_nsn = "0000-00-000-0000"
    assert bogus_nsn != real_nsn

    r = client.post(
        "/api/pulse/cannibalization/propose",
        json=_propose_payload(
            recipient_sr=sr_number,
            donor_asset_id=donor_asset,
            nsn=bogus_nsn,
        ),
    )
    assert r.status_code == 400, r.text
    detail = _err_detail(r.json())
    assert detail.get("error") == "NsnMismatch", detail
    assert detail.get("recipient_sr") == sr_number, detail
    assert detail.get("supplied_nsn") == bogus_nsn, detail
    assert real_nsn in (detail.get("pending_nsns") or []), detail


# ---------------------------------------------------------------------------
# Gate 5 — self-cannib must be acknowledged
# ---------------------------------------------------------------------------

def test_self_cannib_without_flag_returns_400(client: TestClient):
    _logout(client)
    _login(client, DODID_G4)

    g4_units = _scope_units_for("g4")
    sr_number, _asset_id, nsn, _unit = _find_recipient_with_pending_req(g4_units)

    r = client.post(
        "/api/pulse/cannibalization/propose",
        json=_propose_payload(
            recipient_sr=sr_number,
            donor_sr=sr_number,  # same record on both legs, no flag
            nsn=nsn,
        ),
    )
    assert r.status_code == 400, r.text
    detail = _err_detail(r.json())
    assert detail.get("error") == "SelfCannibNotAcknowledged", detail
    assert "self_cannib" in (detail.get("remediation") or ""), detail


# ---------------------------------------------------------------------------
# Happy paths
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "dodid,role",
    [
        (DODID_G4,            "g4"),
        (DODID_MEF_COMMANDER, "mef_commander"),
    ],
)
def test_happy_path_returns_200_and_writes_audit_row(
    client: TestClient, dodid: str, role: str,
):
    """Valid recipient + donor + NSN inside the actor's scope must 200,
    return a PROPOSED proposal with a server-minted id, and persist a
    matching `cannibalization_propose` audit row."""
    _logout(client)
    _login(client, dodid)

    # Use g4's scope (a strict subset of mef_commander's unrestricted view)
    # so a single fixture works for both roles.
    g4_units = _scope_units_for("g4")
    sr_number, asset_id, nsn, unit_name = _find_recipient_with_pending_req(g4_units)
    donor_asset = _find_donor_asset_in_unit(unit_name, exclude_asset_id=asset_id)

    r = client.post(
        "/api/pulse/cannibalization/propose",
        json=_propose_payload(
            recipient_sr=sr_number,
            donor_asset_id=donor_asset,
            nsn=nsn,
        ),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True, body
    assert body.get("audit_persisted") is True, body
    proposal = body.get("proposal") or {}
    assert proposal.get("status") == "PROPOSED", proposal
    assert proposal.get("recipient_sr") == sr_number, proposal
    assert proposal.get("donor_asset_id") == donor_asset, proposal
    assert proposal.get("nsn") == nsn, proposal
    assert proposal.get("recipient_unit") == unit_name, proposal
    assert proposal.get("donor_unit") == unit_name, proposal
    assert proposal.get("self_cannib") is False, proposal
    proposal_id = proposal.get("proposal_id") or ""
    assert proposal_id.startswith("PROP-"), proposal

    matching = [
        e for e in recent_entries(limit=200)
        if e["kind"] == "cannibalization_propose"
        and e["actor"] == role
        and e["subject_id"] == proposal_id
    ]
    assert matching, (
        f"expected a cannibalization_propose audit row for {role} "
        f"with subject_id={proposal_id!r}"
    )
