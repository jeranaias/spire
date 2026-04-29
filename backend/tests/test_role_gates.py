"""
Task-77 — defense-in-depth backend role gates for PULSE / BASTION / Admin.

The frontend's `ScopeGuard` (frontend/src/components/ScopeGuard.tsx, reading
`VIEW_SCOPE` from `frontend/src/state/store.ts`) hides whole tabs from roles
that aren't supposed to see them. Without a matching backend gate, a
session cookie alone is enough to hand-roll `GET /api/pulse/fleet-overview`
past the FE shell — the PULSE Fleet Overview critique (F-2) caught
`security_manager` doing exactly that.

This test walks each of the four mock CACs against a representative slice of
each protected endpoint and asserts:

  1. The backend allow/deny decision matches what the frontend ScopeGuard
     would have rendered for that role × view combo. (The `EXPECTED_VIEW_SCOPE`
     constant below is a verbatim copy of `VIEW_SCOPE` in the FE store —
     drift between the two is what the test catches.)
  2. On deny, the response body carries a structured error
     (`OutOfScope` for the router-level gate, `InsufficientPrivilege` for
     per-route `require_role` gates) so the FE can branch on it cleanly.
  3. On deny, the audit chain grows by at least one row of the right kind
     (`view_scope_denied` for the router-level gate, `role_denied` for
     per-route gates).
  4. For allowed roles, the data scope returned by `/pulse/fleet-overview`
     matches `ROLE_TO_UNITS_FILTER` — i.e. maintenance_chief sees only
     CLB-6, g4 sees only 2d MLG units, mef_commander sees the full fleet.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.auth import MOCK_USERS
from backend.main import app
from backend.persistence import recent_entries
from backend.scoping import (
    ADMIN_VIEW_ROLES,
    BASTION_VIEW_ROLES,
    PULSE_VIEW_ROLES,
    ROLE_TO_UNITS_FILTER,
)
from backend.state import get_dataset


# Verbatim copy of `VIEW_SCOPE` in `frontend/src/state/store.ts`. If a future
# task amends the FE map, this constant must be updated in lockstep — the
# test below asserts the BE constants match this table, so a drift fails CI.
# All admin sub-routes (`/admin/audit`, `/admin/models`) inherit the same
# allowlist as `/admin` itself; they are listed explicitly so a future
# split (e.g. broadening `/admin/models` to a second role) is caught.
EXPECTED_VIEW_SCOPE: dict[str, frozenset[str]] = {
    "/sentry":       frozenset({"data_custodian", "security_manager", "mef_commander"}),
    "/pulse":        frozenset({"maintenance_chief", "g4", "mef_commander"}),
    "/bastion":      frozenset({"mef_commander", "g4", "security_manager", "maintenance_chief"}),
    "/admin":        frozenset({"security_manager", "mef_commander"}),
    "/admin/audit":  frozenset({"security_manager", "mef_commander"}),
    "/admin/models": frozenset({"security_manager", "mef_commander"}),
}


# Sample of routes per view that the test sweeps. Each entry is
# (view_key, http_method, path, gate_kind) where gate_kind is the audit
# row kind expected when a role outside the allowlist hits the endpoint.
PROTECTED_ENDPOINTS: list[tuple[str, str, str, str]] = [
    # PULSE — router-level gate, emits view_scope_denied.
    ("/pulse",   "GET",  "/api/pulse/fleet-overview",       "view_scope_denied"),
    ("/pulse",   "GET",  "/api/pulse/risk-board",           "view_scope_denied"),
    ("/pulse",   "GET",  "/api/pulse/cannibalization",      "view_scope_denied"),
    ("/pulse",   "GET",  "/api/pulse/forecast",             "view_scope_denied"),
    ("/pulse",   "GET",  "/api/pulse/model-card",           "view_scope_denied"),
    # BASTION — router-level gate, emits view_scope_denied.
    ("/bastion", "GET",  "/api/bastion/cop",                "view_scope_denied"),
    ("/bastion", "GET",  "/api/bastion/alerts",             "view_scope_denied"),
    ("/bastion", "GET",  "/api/bastion/fused-threats",      "view_scope_denied"),
    ("/bastion", "GET",  "/api/bastion/incidents",          "view_scope_denied"),
    ("/bastion", "GET",  "/api/bastion/tmrs",               "view_scope_denied"),
    # Admin — per-route gates inside system.py, emit role_denied.
    ("/admin",   "GET",  "/api/system/audit",               "role_denied"),
    ("/admin",   "GET",  "/api/system/admin/audit",         "role_denied"),
    ("/admin",   "GET",  "/api/system/admin/telemetry",     "role_denied"),
    ("/admin",   "GET",  "/api/system/admin/outcomes",      "role_denied"),
    ("/admin",   "GET",  "/api/system/admin/models",        "role_denied"),
    ("/admin",   "GET",  "/api/system/admin/inference-economics", "role_denied"),
]


@pytest.fixture(scope="module")
def client():
    # Context-manager form runs the lifespan handler so the canonical
    # dataset is loaded — `/pulse/fleet-overview` needs it.
    with TestClient(app) as c:
        yield c


def _login(c: TestClient, dodid: str) -> None:
    r = c.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _logout(c: TestClient) -> None:
    c.post("/api/auth/logout")


def _err_detail(body: dict) -> dict:
    """Extract the structured error block. FastAPI puts HTTPException.detail
    under `detail`; our middleware envelopes wrap it directly. Tolerate both."""
    if not isinstance(body, dict):
        return {}
    return body.get("detail") if isinstance(body.get("detail"), dict) else body


def test_backend_view_role_constants_match_frontend_table():
    """Drift guard: the backend allowlists must equal the FE VIEW_SCOPE map.

    Covers every key the FE declares — top-level views and admin
    sub-routes — so a future FE policy split on `/admin/audit` or
    `/admin/models` (or a new SENTRY allowlist) fails CI loudly instead
    of silently diverging from the BE truth source.
    """
    from backend.scoping import SENTRY_VIEW_ROLES, VIEW_ROLES

    assert PULSE_VIEW_ROLES == EXPECTED_VIEW_SCOPE["/pulse"]
    assert BASTION_VIEW_ROLES == EXPECTED_VIEW_SCOPE["/bastion"]
    assert ADMIN_VIEW_ROLES == EXPECTED_VIEW_SCOPE["/admin"]
    assert SENTRY_VIEW_ROLES == EXPECTED_VIEW_SCOPE["/sentry"]

    # Admin sub-routes are not separately gated on the backend (the
    # admin endpoints all live in `system.py` and use the same
    # ADMIN_VIEW_ROLES allowlist via per-route `require_role` calls);
    # if the FE ever broadens a sub-route, this assertion catches the
    # drift so a follow-up task can split the BE constants too.
    assert EXPECTED_VIEW_SCOPE["/admin/audit"] == ADMIN_VIEW_ROLES
    assert EXPECTED_VIEW_SCOPE["/admin/models"] == ADMIN_VIEW_ROLES

    # Every top-level VIEW_ROLES key must appear in the FE table.
    for view, allowed in VIEW_ROLES.items():
        assert view in EXPECTED_VIEW_SCOPE, (
            f"BE declares {view} but FE VIEW_SCOPE does not — "
            "either add the FE entry or remove the BE one."
        )
        assert allowed == EXPECTED_VIEW_SCOPE[view], (
            f"BE/FE allowlist drift on {view}: BE={sorted(allowed)}, "
            f"FE={sorted(EXPECTED_VIEW_SCOPE[view])}"
        )


@pytest.mark.parametrize("user", MOCK_USERS, ids=lambda u: u["role"])
@pytest.mark.parametrize(
    "view,method,path,gate_kind",
    PROTECTED_ENDPOINTS,
    ids=lambda v: v if isinstance(v, str) else "",
)
def test_role_gate_matches_frontend_scope_guard(
    client: TestClient,
    user: dict,
    view: str,
    method: str,
    path: str,
    gate_kind: str,
) -> None:
    """For every (CAC × endpoint) combo: BE allow/deny must match FE
    ScopeGuard, and a deny must leave a structured 403 + audit row."""
    _logout(client)
    _login(client, user["dodid"])

    allowed_roles = EXPECTED_VIEW_SCOPE[view]
    fe_in_scope = user["role"] in allowed_roles

    fn = getattr(client, method.lower())
    r = fn(path)

    if fe_in_scope:
        # Allowed roles: must NOT 403. (Some endpoints can legitimately
        # 4xx for other reasons — bad query, missing seed — but never 403
        # from a role gate.)
        assert r.status_code != 403, (
            f"{user['role']} expected ALLOW for {path}; "
            f"got 403 with body {r.text!r}"
        )
        # Most of these return 200; the few that don't (e.g. 503 on empty
        # dataset) are still a non-gate signal.
        assert r.status_code in (200, 503), (
            f"{user['role']} unexpected non-200/503 for {path}: "
            f"{r.status_code} {r.text!r}"
        )
        return

    # Denied roles: must 403 with structured detail.
    assert r.status_code == 403, (
        f"{user['role']} expected DENY for {path}; "
        f"got {r.status_code} with body {r.text!r}"
    )
    detail = _err_detail(r.json())
    if gate_kind == "view_scope_denied":
        assert detail.get("error") == "OutOfScope", detail
        assert detail.get("view") == view, detail
        assert detail.get("user_role") == user["role"], detail
        assert sorted(allowed_roles) == detail.get("roles_allowed"), detail
    else:
        assert detail.get("error") == "InsufficientPrivilege", detail
        assert detail.get("role_seen") == user["role"], detail

    # Audit-chain side effect: at least one matching row must appear at the
    # tail of the chain. The chain is shared across the whole module-scoped
    # client, so we look at a generous tail and filter.
    rows = recent_entries(limit=100)
    matching = [
        e for e in rows
        if e["kind"] == gate_kind
        and e["actor"] == user["role"]
    ]
    assert matching, (
        f"expected at least one {gate_kind} audit row for "
        f"{user['role']} hitting {path}; got tail={rows!r}"
    )


def test_pulse_data_scope_matches_role_filter(client: TestClient):
    """For roles allowed into PULSE, the unit set returned by
    /pulse/fleet-overview must match `ROLE_TO_UNITS_FILTER`. This is the
    'data scope returned matches what the page actually shows' assertion.
    """
    ds = get_dataset()
    all_unit_names = sorted(u.name for u in ds.units)
    mlg_units = sorted(u.name for u in ds.units if u.parent == "2d MLG")

    cases = [
        # (dodid, role, expected_units_visible_sorted, filter_applied)
        ("2345678901", "maintenance_chief", ["CLB-6"],         True),
        ("1234567890", "g4",                mlg_units,         True),
        ("4567890123", "mef_commander",     all_unit_names,    False),
    ]
    for dodid, role, expected_units, filter_applied in cases:
        _logout(client)
        _login(client, dodid)
        r = client.get("/api/pulse/fleet-overview")
        assert r.status_code == 200, f"{role}: {r.status_code} {r.text!r}"
        body = r.json()
        scope = body.get("scope") or {}
        assert scope.get("filter_applied") is filter_applied, (
            f"{role}: filter_applied mismatch — body.scope={scope!r}"
        )
        assert scope.get("units_visible") == expected_units, (
            f"{role}: units_visible mismatch — got {scope.get('units_visible')!r}, "
            f"expected {expected_units!r}"
        )

    # Sanity check: the role-to-units rule for maintenance_chief and g4
    # is what the assertion above relies on. If a future task edits
    # ROLE_TO_UNITS_FILTER without revisiting this test, fail loudly.
    assert ROLE_TO_UNITS_FILTER["maintenance_chief"]["units"] == {"CLB-6"}
    assert ROLE_TO_UNITS_FILTER["g4"]["parents"] == {"2d MLG"}


def test_admin_outcome_post_is_now_role_gated(client: TestClient):
    """Regression for the previously-ungated /admin/outcome POST (Task #77).

    Outcome rows feed `/admin/telemetry`'s retraining-recommended flag.
    Before this task any signed-in role could inject rows; now it must
    require security_manager."""
    _logout(client)
    _login(client, "1234567890")  # g4 — outside ADMIN_VIEW_ROLES
    r = client.post(
        "/api/system/admin/outcome",
        json={
            "decision_kind": "cannibalization_proposal",
            "decision_id": "ROLE-GATE-TEST",
            "decided_by": "g4",
            "was_correct": True,
            "scoring_engine": "rule_based_v1",
        },
    )
    assert r.status_code == 403, f"expected 403 for g4 POST; got {r.status_code} {r.text!r}"
    detail = _err_detail(r.json())
    assert detail.get("error") == "InsufficientPrivilege"
    assert detail.get("action") == "admin.outcome.write"

    # Positive control: security_manager (CWO3 Park) is allowed.
    _logout(client)
    _login(client, "3456789012")
    r = client.post(
        "/api/system/admin/outcome",
        json={
            "decision_kind": "cannibalization_proposal",
            "decision_id": "ROLE-GATE-TEST-OK",
            "decided_by": "security_manager",
            "was_correct": True,
            "scoring_engine": "rule_based_v1",
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("decision_id") == "ROLE-GATE-TEST-OK"
