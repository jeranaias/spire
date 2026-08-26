"""Default-deny authorization (P1-1).

Two guarantees:
  1. Every /api route is *classified* as open, include-gated (carries a
     view-scope dependency), or per-route-gated. A new router added without an
     authz decision fails this test — that's the default-deny governance.
  2. The five cross-cutting routers (llm/copilot/integrations/gcss/
     decision-bridge) actually carry their include-level view-scope gate.
  3. decision-bridge/audit redacts the chain head_hash for non-audit roles.
"""
from __future__ import annotations

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from backend.main import app


# Open surfaces (the means of getting a session + the unauthenticated health probe).
OPEN_EXACT = {"/api/system/status"}
OPEN_PREFIXES = ("/api/auth/",)

# Routers gated at the include with require_view_scope — must carry the marker.
INCLUDE_GATED_PREFIXES = (
    "/api/pulse", "/api/bastion", "/api/llm", "/api/copilot",
    "/api/integrations", "/api/gcss", "/api/decision-bridge",
)
# Gated per-route (require_role / require_user_role / require_clearance in body).
PER_ROUTE_GATED_PREFIXES = (
    "/api/gcss/export", "/api/integrations/gcss-mc/export",  # custodian export gate
    "/api/sentry", "/api/system", "/api/uis", "/api/ingest", "/api/joint",
    # Field-observation lane: every write endpoint calls require_user_role +
    # require_clearance in its body, and /api/field/status is an intentionally
    # open policy probe (same shape as /api/ingest/status) so a handheld can
    # discover whether the lane is enabled without tripping a 403.
    "/api/field",
)


def _api_routes():
    return [r for r in app.routes if isinstance(r, APIRoute) and r.path.startswith("/api/")]


def _has_view_scope(route: APIRoute) -> bool:
    return any(
        getattr(dep.call, "_spire_view_scope", None) is not None
        for dep in route.dependant.dependencies
    )


def _is_open(path: str) -> bool:
    return path in OPEN_EXACT or path.startswith(OPEN_PREFIXES)


def test_no_ungated_api_route():
    """Every /api route is open, include-gated, or per-route-gated. A new
    unclassified router fails here rather than shipping wide open."""
    unclassified = []
    for route in _api_routes():
        if _is_open(route.path):
            continue
        if route.path.startswith(PER_ROUTE_GATED_PREFIXES):
            continue
        if route.path.startswith(INCLUDE_GATED_PREFIXES):
            continue
        unclassified.append(route.path)
    assert not unclassified, f"ungated /api routes (add a gate or classify): {sorted(set(unclassified))}"


def test_include_gated_routers_carry_view_scope():
    """The cross-cutting routers keep their include-level gate — catches an
    accidental removal of the default-deny dependency."""
    missing = []
    for route in _api_routes():
        # export routers mount UNDER these prefixes but are gated per-route.
        if route.path.startswith(("/api/gcss/export", "/api/integrations/gcss-mc/export")):
            continue
        if route.path.startswith(INCLUDE_GATED_PREFIXES) and not _has_view_scope(route):
            missing.append(route.path)
    assert not missing, f"include-gated route lost its view-scope gate: {sorted(set(missing))}"


# --- behavioral: head_hash redaction on the bridge audit tile ----------------

MAINT_CHIEF = "2345678901"       # not in AUDIT_READ_ROLES
SECURITY_MANAGER = "3456789012"  # in AUDIT_READ_ROLES


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def _login(c, dodid):
    assert c.post("/api/auth/login", json={"dodid": dodid, "pin": "000000"}).status_code == 200


def test_audit_tile_redacts_head_hash_for_non_audit_role(client):
    _login(client, MAINT_CHIEF)
    body = client.get("/api/decision-bridge/audit").json()
    assert body["chain_ok"] in (True, False)      # operational health still visible
    assert body["head_hash"] is None              # sensitive internal redacted


def test_audit_tile_exposes_head_hash_for_audit_role(client):
    _login(client, SECURITY_MANAGER)
    body = client.get("/api/decision-bridge/audit").json()
    assert body["head_hash"] is not None
