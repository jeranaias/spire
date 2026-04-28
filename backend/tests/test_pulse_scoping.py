"""
Task-93 — regression tests that lock down PULSE readiness scoping.

Background
----------
Task #72 closed an OPSEC leak on `/api/pulse/forecast`: a logged-in G-4 was
able to read another command's readiness curve by typing the unit name into
the URL, and the "FLEET" projection was the dataset-wide aggregate rather
than the caller's own units. The fix routed `forecast()` through
`session_role(request)` + `allowed_units(...)` and added a 403 for
`?unit=<out-of-scope>`.

That fix was verified by hand with curl against the four mock CACs. There
was no automated coverage. A future refactor of `forecast()` (or a tweak
to `allowed_units()` / `ROLE_TO_UNITS_FILTER`) could silently re-open the
leak. The same gap exists on every other PULSE endpoint that uses
`allowed_units`: `risk-board`, `predict-failures`, `recommend-actions`.

This module is the regression net. For each of the four mocked CACs it
asserts:

  * G-4's "FLEET" forecast is NOT bit-identical to the MEF commander's
    FLEET forecast — the original Task-72 leak.
  * G-4 and Maintenance Chief get HTTP 403 when they ask for an
    out-of-scope unit (forecast) or out-of-scope asset (predict-failures
    / recommend-actions).
  * Maj Gen Hayes (mef_commander) gets HTTP 200 for any unit / asset
    in the dataset — full unrestricted view.
  * Risk-board / predict-failures / recommend-actions return only
    in-scope units for G-4 and Maintenance Chief, even when the caller
    omits a unit filter (the silent path the FE takes by default).

Why is `security_manager` not asserted to get HTTP 200 here? It's
denied at the *view* level — `PULSE_VIEW_ROLES` does not include
`security_manager` (its primary surface is the audit chain). The
router-level `require_view_scope("/pulse", PULSE_VIEW_ROLES)` short-
circuits with 403/`OutOfScope` before unit scoping ever runs. We
assert that 403 explicitly so a future broadening of PULSE_VIEW_ROLES
to include `security_manager` is caught here, not in production.

Note on the silent role-injection path
---------------------------------------
`backend.auth.session_middleware` strips any client-supplied `?role=`
from the query string and replaces it with the authenticated session
role (`_override_query_role`). Routes that read `role: Optional[str]`
from `?role=` (risk-board, predict-failures, recommend-actions)
therefore see the server-truth role automatically. The tests below
deliberately do NOT pass `?role=` — that's the FE's default call
shape, and the path most likely to silently regress if the middleware
override is ever removed or bypassed.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.scoping import ROLE_TO_UNITS_FILTER
from backend.state import get_dataset


# Four mock CACs from `backend.auth.MOCK_USERS`.
DODID_G4                 = "1234567890"
DODID_MAINTENANCE_CHIEF  = "2345678901"
DODID_SECURITY_MANAGER   = "3456789012"
DODID_MEF_COMMANDER      = "4567890123"

# An out-of-scope unit for both G-4 (parent=2d MLG) and Maintenance Chief
# (units={CLB-6}). MALS-31 sits under MAG-31 in the canonical dataset, so
# neither role's `allowed_units(...)` set contains it.
OOS_UNIT = "MALS-31"

# A specific asset that lives in `OOS_UNIT`. Used by the predict-failures /
# recommend-actions assertions, which 403 on `?asset_id=<oos>` (they don't
# accept a `?unit=<oos>` 403 — that path returns an empty list because the
# scope filter applies inside the for-loop, not at request entry).
OOS_ASSET_ID = "M55670-MV22B_OSPREY-001"

# An in-scope unit for both G-4 and Maintenance Chief — both their unit
# allowlists resolve to {CLB-6} (G-4 via parent=2d MLG, MC via explicit).
IN_SCOPE_UNIT_BOTH = "CLB-6"


@pytest.fixture(scope="module")
def client():
    # Context-manager form runs the lifespan handler so the canonical
    # dataset is loaded before the first request.
    with TestClient(app) as c:
        yield c


def _login(c: TestClient, dodid: str) -> None:
    c.post("/api/auth/logout")
    r = c.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _allowed_units_for(role: str) -> set[str] | None:
    """Mirror `backend.scoping.allowed_units` against the live dataset.

    Returns None for unrestricted roles so the test can assert "no
    filtering applied" without re-implementing the rule in this module.
    """
    rule = ROLE_TO_UNITS_FILTER.get(role)
    if not rule:
        return None
    if not rule["units"] and not rule["parents"]:
        return None
    ds = get_dataset()
    allowed: set[str] = set(rule["units"])
    for u in ds.units:
        if u.parent in rule["parents"]:
            allowed.add(u.name)
    return allowed


# ---------------------------------------------------------------------------
# /pulse/forecast — the endpoint Task #72 fixed.
# ---------------------------------------------------------------------------

def test_g4_fleet_forecast_is_scoped_not_dataset_wide(client):
    """The FLEET label means "the units this caller can see" — never the
    dataset-wide aggregate. G-4's FLEET projection must therefore differ
    from the MEF commander's FLEET projection on the same dataset.

    This is the exact regression that triggered Task #72: a logged-in
    G-4 saw the same FLEET curve as the commanding general, leaking the
    cross-MEF readiness picture the G-4 was never cleared to read.
    """
    _login(client, DODID_G4)
    r_g4 = client.get("/api/pulse/forecast", params={"window": 14})
    assert r_g4.status_code == 200, r_g4.text
    g4_body = r_g4.json()

    _login(client, DODID_MEF_COMMANDER)
    r_mef = client.get("/api/pulse/forecast", params={"window": 14})
    assert r_mef.status_code == 200, r_mef.text
    mef_body = r_mef.json()

    # Both responses self-label as "FLEET" — the difference must be in
    # the underlying aggregate, not the label.
    assert g4_body["unit"] == "FLEET"
    assert mef_body["unit"] == "FLEET"

    # The history series is the deterministic, scope-dependent input to
    # the projection. If G-4's history were dataset-wide it would equal
    # the MEF commander's history bit-for-bit. It must not.
    assert g4_body["history"] != mef_body["history"], (
        "G-4 and MEF commander returned bit-identical FLEET history — "
        "this is the Task-72 leak: G-4 is reading the dataset-wide "
        "aggregate instead of their own scoped units."
    )

    # The deterministic Monte Carlo seed is hashed against the unit
    # label, so g4 and mef both seed "FLEET". If the underlying input
    # were the same, the projection band would be identical too.
    assert g4_body["projection"] != mef_body["projection"], (
        "G-4 and MEF commander returned bit-identical FLEET projection."
    )


@pytest.mark.parametrize(
    "dodid,role",
    [
        (DODID_G4,                "g4"),
        (DODID_MAINTENANCE_CHIEF, "maintenance_chief"),
    ],
)
def test_forecast_403_on_out_of_scope_unit(client, dodid: str, role: str):
    """Asking for a unit outside the caller's `allowed_units` set must
    return 403, not silently fall through to a dataset-wide aggregate or
    an empty-payload 200.
    """
    _login(client, dodid)
    r = client.get("/api/pulse/forecast", params={"unit": OOS_UNIT})
    assert r.status_code == 403, (
        f"{role} expected 403 on ?unit={OOS_UNIT}; "
        f"got {r.status_code} {r.text!r}"
    )


def test_forecast_security_manager_denied_at_view_scope(client):
    """`security_manager` is not in `PULSE_VIEW_ROLES`, so any PULSE call
    short-circuits with `view_scope_denied` / 403 / OutOfScope before unit
    scoping runs.

    Locked down here so a future broadening of PULSE_VIEW_ROLES to add
    `security_manager` is caught and the unit-scope tests for that role
    can be added at the same time.
    """
    _login(client, DODID_SECURITY_MANAGER)
    r = client.get("/api/pulse/forecast", params={"unit": OOS_UNIT})
    assert r.status_code == 403
    detail = r.json().get("detail")
    assert isinstance(detail, dict) and detail.get("error") == "OutOfScope", detail
    assert detail.get("view") == "/pulse"
    assert detail.get("user_role") == "security_manager"


def test_forecast_mef_commander_200_on_any_unit(client):
    """Maj Gen Hayes is unrestricted; every unit in the dataset must
    return 200 + a real projection."""
    _login(client, DODID_MEF_COMMANDER)
    ds = get_dataset()
    for unit in sorted({u.name for u in ds.units}):
        r = client.get("/api/pulse/forecast", params={"unit": unit})
        assert r.status_code == 200, (
            f"mef_commander expected 200 on ?unit={unit}; "
            f"got {r.status_code} {r.text!r}"
        )
        body = r.json()
        assert body["unit"] == unit
        assert isinstance(body.get("projection"), list)


# ---------------------------------------------------------------------------
# /pulse/risk-board — no `unit` param, scoping enforced by data shape.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "dodid,role",
    [
        (DODID_G4,                "g4"),
        (DODID_MAINTENANCE_CHIEF, "maintenance_chief"),
    ],
)
def test_risk_board_returns_only_in_scope_units(client, dodid: str, role: str):
    """The risk board does not accept a `?unit=` filter — scoping is
    enforced by what shows up in the response. For a scoped role, every
    asset returned must belong to that role's `allowed_units` set.

    The test deliberately does NOT pass `?role=` — that's the FE's
    default call shape; the session middleware injects the authenticated
    role. If that middleware override regresses, this assertion fails.
    """
    _login(client, dodid)
    allowed = _allowed_units_for(role)
    assert allowed is not None, (
        f"{role} should be a scoped role; ROLE_TO_UNITS_FILTER drift?"
    )

    # Ask for a generous slice so a future ranking change doesn't make
    # the test pass by returning zero rows.
    r = client.get("/api/pulse/risk-board", params={"top": 100})
    assert r.status_code == 200, r.text
    units_returned = {a["unit_name"] for a in r.json().get("assets", [])}
    out_of_scope = units_returned - allowed
    assert not out_of_scope, (
        f"{role} risk-board leaked out-of-scope units: {sorted(out_of_scope)} "
        f"(allowed={sorted(allowed)})"
    )


def test_risk_board_mef_commander_returns_cross_unit(client):
    """Unrestricted role must see assets from more than one unit when
    the dataset has them — ensures the test above isn't hiding a bug
    that scopes everyone to a single unit."""
    _login(client, DODID_MEF_COMMANDER)
    r = client.get("/api/pulse/risk-board", params={"top": 100})
    assert r.status_code == 200, r.text
    units_returned = {a["unit_name"] for a in r.json().get("assets", [])}
    assert len(units_returned) > 1, (
        f"mef_commander risk-board returned a single unit ({units_returned}) — "
        "expected cross-unit visibility."
    )


# ---------------------------------------------------------------------------
# /pulse/predict-failures and /pulse/recommend-actions — same scoping
# contract: 403 on out-of-scope asset_id, scoped result on default call.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "dodid,role",
    [
        (DODID_G4,                "g4"),
        (DODID_MAINTENANCE_CHIEF, "maintenance_chief"),
    ],
)
@pytest.mark.parametrize(
    "path",
    ["/api/pulse/predict-failures", "/api/pulse/recommend-actions"],
)
def test_predict_recommend_403_on_out_of_scope_asset(
    client, dodid: str, role: str, path: str
):
    """A scoped role asking for a specific out-of-scope asset must 403.

    `predict-failures` and `recommend-actions` both check `asset_id`
    against `allowed_units(...)` at request entry and raise
    `HTTPException(403, "asset out of scope")`. This is the per-asset
    leak surface — without this gate a G-4 could pull failure
    predictions for an MV-22 they have no business reading.
    """
    _login(client, dodid)
    r = client.get(path, params={"asset_id": OOS_ASSET_ID})
    assert r.status_code == 403, (
        f"{role} expected 403 on {path}?asset_id={OOS_ASSET_ID}; "
        f"got {r.status_code} {r.text!r}"
    )


@pytest.mark.parametrize(
    "dodid,role",
    [
        (DODID_G4,                "g4"),
        (DODID_MAINTENANCE_CHIEF, "maintenance_chief"),
    ],
)
def test_predict_failures_only_returns_in_scope_assets(
    client, dodid: str, role: str
):
    """Default call (no unit / asset filter) must still come back scoped.

    Threshold relaxed below the default so the response is non-empty on
    the synthetic dataset; horizon widened for the same reason.
    """
    _login(client, dodid)
    allowed = _allowed_units_for(role)
    assert allowed is not None

    r = client.get(
        "/api/pulse/predict-failures",
        params={"threshold": 0.05, "horizon_days": 30},
    )
    assert r.status_code == 200, r.text
    assets = r.json().get("assets", [])
    assert assets, f"{role} predict-failures returned no assets at relaxed threshold"
    out_of_scope = {a["unit_name"] for a in assets} - allowed
    assert not out_of_scope, (
        f"{role} predict-failures leaked out-of-scope units: {sorted(out_of_scope)} "
        f"(allowed={sorted(allowed)})"
    )


@pytest.mark.parametrize(
    "dodid,role",
    [
        (DODID_G4,                "g4"),
        (DODID_MAINTENANCE_CHIEF, "maintenance_chief"),
    ],
)
def test_recommend_actions_only_returns_in_scope_assets(
    client, dodid: str, role: str
):
    """Same scoping contract as predict-failures, applied to recommend-
    actions: every recommended action must reference an in-scope asset.
    """
    _login(client, dodid)
    allowed = _allowed_units_for(role)
    assert allowed is not None
    ds = get_dataset()
    asset_to_unit = {a.asset_id: a.unit_name for a in ds.assets}

    r = client.get("/api/pulse/recommend-actions", params={"top": 20})
    if r.status_code == 503:
        # Replenishment rate primitives didn't load — non-scoping signal.
        pytest.skip("recommend-actions unavailable (replenishment module)")
    assert r.status_code == 200, r.text
    items = r.json().get("recommendations") or r.json().get("items") or r.json()
    if isinstance(items, dict):
        # Endpoint returns a dict envelope; pull the candidate list out.
        items = (
            items.get("recommendations")
            or items.get("items")
            or items.get("actions")
            or []
        )
    # Walk every asset_id referenced anywhere in the payload.
    leaked: set[str] = set()
    for entry in items:
        if not isinstance(entry, dict):
            continue
        aid = entry.get("asset_id")
        if aid and aid in asset_to_unit:
            unit = asset_to_unit[aid]
            if unit not in allowed:
                leaked.add(unit)
    assert not leaked, (
        f"{role} recommend-actions leaked out-of-scope units: {sorted(leaked)} "
        f"(allowed={sorted(allowed)})"
    )


@pytest.mark.parametrize(
    "path",
    ["/api/pulse/predict-failures", "/api/pulse/recommend-actions"],
)
def test_mef_commander_can_reach_out_of_scope_asset(client, path: str):
    """The unrestricted commander must be able to read the same
    `OOS_ASSET_ID` that 403s for G-4 / Maintenance Chief — proves the
    test above isn't asserting "everyone gets 403" by accident.
    """
    _login(client, DODID_MEF_COMMANDER)
    r = client.get(path, params={"asset_id": OOS_ASSET_ID})
    if r.status_code == 503 and path.endswith("recommend-actions"):
        pytest.skip("recommend-actions unavailable (replenishment module)")
    assert r.status_code == 200, (
        f"mef_commander expected 200 on {path}?asset_id={OOS_ASSET_ID}; "
        f"got {r.status_code} {r.text!r}"
    )


# ---------------------------------------------------------------------------
# Sanity: ROLE_TO_UNITS_FILTER constants the suite relies on.
#
# A future task editing `ROLE_TO_UNITS_FILTER` (e.g. expanding G-4's
# parent set or moving Maintenance Chief off CLB-6) without updating the
# tests should fail loudly here, not silently invalidate every other
# assertion in this module.
# ---------------------------------------------------------------------------

def test_role_filter_constants_match_test_assumptions():
    assert ROLE_TO_UNITS_FILTER["maintenance_chief"]["units"] == {"CLB-6"}
    assert ROLE_TO_UNITS_FILTER["maintenance_chief"]["parents"] == set()
    assert ROLE_TO_UNITS_FILTER["g4"]["units"] == set()
    assert ROLE_TO_UNITS_FILTER["g4"]["parents"] == {"2d MLG"}
    assert ROLE_TO_UNITS_FILTER["mef_commander"]["units"] == set()
    assert ROLE_TO_UNITS_FILTER["mef_commander"]["parents"] == set()

    # MALS-31 must remain out of both scoped roles' allowlists. If the
    # dataset is ever restructured so MALS-31 sits under 2d MLG, this
    # whole test module needs a fresh OOS_UNIT pick.
    ds = get_dataset()
    parents = {u.name: u.parent for u in ds.units}
    assert OOS_UNIT in parents, f"{OOS_UNIT} missing from dataset"
    assert parents[OOS_UNIT] != "2d MLG", (
        f"{OOS_UNIT} is now under 2d MLG — pick a different OOS_UNIT."
    )
    assert OOS_UNIT != "CLB-6"
