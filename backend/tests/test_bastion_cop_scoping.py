"""
Task #55 — adversarial review finding F2.

`/api/bastion/cop` used to return the entire installation map (ammo, ARMS,
fuel, hazmat, every ECP, every rally point) regardless of role scope. A
battalion-level Maintenance Chief CAC therefore received a complete OSINT
installation product. This test pins the fix:

  * Maintenance Chief sees buildings filtered by occupant-unit affiliation
    (or shared-infra sector association); ECPs and RPs filtered by sector;
    no ammunition / arms_storage / fuel / hazmat / communications /
    tactical types in the payload.
  * G-4 sees the 2d MLG footprint, not Pendleton or 14th Marines.
  * Security Manager and MEF Commander still receive the full map.
  * `buildings_count` reflects the scoped count, not the master count.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from backend.persistence import AUDIT_KIND_SCOPE_FILTERED, recent_entries
from backend.routes import bastion as bastion_routes


SENSITIVE_TYPES = {
    "ammunition",
    "arms_storage",
    "fuel",
    "hazmat",
    "communications",
    "tactical",
}


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


def _login(client: TestClient, dodid: str) -> None:
    r = client.post("/api/auth/login", json={"dodid": dodid, "pin": "123456"})
    assert r.status_code == 200, r.text


def _cop(client: TestClient, role: str) -> dict:
    r = client.get(f"/api/bastion/cop?role={role}")
    assert r.status_code == 200, r.text
    return r.json()


def test_maintenance_chief_does_not_see_ammo_arms_fuel_hazmat(client):
    _login(client, "2345678901")  # Diana Kowalski, maintenance_chief
    cop = _cop(client, "maintenance_chief")

    types = {b["type"] for b in cop["buildings"]}
    leaked = types & SENSITIVE_TYPES
    assert not leaked, (
        f"Maintenance Chief payload still leaks sensitive infra types: {leaked}"
    )
    # Should also be far smaller than 50.
    assert len(cop["buildings"]) < 30
    assert cop["buildings_count"] == len(cop["buildings"])


def test_maintenance_chief_only_sees_her_sector_ecps_and_rps(client):
    _login(client, "2345678901")
    cop = _cop(client, "maintenance_chief")

    # CLB-6 anchors in the NW sector. The Chief should not see all four
    # ECPs nor all eight rally points.
    assert 0 < len(cop["ecps"]) < 4, cop["ecps"]
    assert 0 < len(cop["rally_points"]) < 8, cop["rally_points"]

    # Every visible ECP / RP must be tagged to the Chief's sector(s).
    visible_sectors = {b.get("sector") for b in cop["buildings"]}
    visible_sectors.discard(None)
    for e in cop["ecps"]:
        assert e["sector"] in visible_sectors, e
    for rp in cop["rally_points"]:
        assert rp["sector"] in visible_sectors, rp


def test_maintenance_chief_sees_her_own_critical_building_only_coarsened(client):
    """Occupant CI carve-out: CLB-6 motor pool is critical infrastructure
    + hazmat. The Chief needs to know it exists in her footprint, but
    she must NOT receive the same precision an adversary could mine
    (exact lat/lon, occupancy figures, utility wiring, notes). The
    payload returns a 1km-MGRS-centroid with `coarsened: True`."""
    _login(client, "2345678901")
    cop = _cop(client, "maintenance_chief")
    by_id = {b["id"]: b for b in cop["buildings"]}

    # Non-CI occupant building — full fidelity is fine.
    assert "CLB6-HQ" in by_id

    # CI occupant building — coarsened, not stripped.
    assert "CLB6-MP" in by_id, "CLB-6 motor pool must remain visible to its occupant"
    mp = by_id["CLB6-MP"]
    assert mp.get("coarsened") is True, mp
    # OSINT-adjacent fields stripped.
    for forbidden in (
        "current_occupancy",
        "occupancy_capacity",
        "utilities",
        "hazmat_present",
        "critical_infrastructure",
        "notes",
        "nearest_rally_point",
        "floors",
    ):
        assert forbidden not in mp, (
            f"Coarsened CI building must not leak {forbidden}: {mp}"
        )
    # Coarsened to ~1km — 2 decimals of lat/lon, last two grid digits
    # zeroed. Anything finer is an adversary aim point.
    assert mp["lat"] == round(mp["lat"], 2)
    assert mp["lon"] == round(mp["lon"], 2)
    assert mp["grid"].endswith("00 71000") or mp["grid"].endswith("00")


def test_no_lower_scoped_role_receives_precise_critical_or_hazmat(client):
    """Defense-in-depth: regardless of role, if a building is flagged
    critical_infrastructure OR hazmat_present, no non-full-view role can
    receive its precise lat/lon or unredacted attribute set. Either
    coarsened (occupant carve-out) or absent (everyone else)."""
    for dodid, role in (
        ("2345678901", "maintenance_chief"),
        ("1234567890", "g4"),
    ):
        _login(client, dodid)
        cop = _cop(client, role)
        for b in cop["buildings"]:
            # Coarsened buildings have stripped CI/hazmat flags by
            # construction — only the full-fidelity records can carry
            # them. Assert no full-fidelity CI/hazmat slipped through.
            if b.get("coarsened"):
                # Coarsened records are allowed but must not carry
                # adversary-aim-point fields.
                assert "current_occupancy" not in b
                assert "utilities" not in b
                continue
            assert not b.get("critical_infrastructure"), (
                f"{role} got full-fidelity CI building: {b['id']}"
            )
            assert not b.get("hazmat_present"), (
                f"{role} got full-fidelity hazmat building: {b['id']}"
            )


def test_g4_sees_2d_mlg_footprint_not_pendleton_or_14th_marines(client):
    _login(client, "1234567890")  # Marcus Reyes, g4
    cop = _cop(client, "g4")

    # 2d MLG units' home buildings are NW-sector. CLB-1 (1st MLG, Pendleton)
    # and TOC-MAIN (2/14 Marines) are not in scope.
    ids = {b["id"] for b in cop["buildings"]}
    assert "CLB6-MP" in ids   # CLB-6, 2d MLG
    assert "ESB-WS" in ids    # 7th ESB, 2d MLG
    assert "MLG-SSC" in ids   # 3d Maint Bn, 2d MLG
    assert "TOC-MAIN" not in ids   # 2/14 Marines, sensitive type
    assert "TANK-MP" not in ids    # 3/6 Marines, occupant mismatch

    types = {b["type"] for b in cop["buildings"]}
    assert not (types & SENSITIVE_TYPES)


def test_security_manager_sees_full_installation_map(client):
    _login(client, "3456789012")  # James Park, security_manager
    cop = _cop(client, "security_manager")
    assert len(cop["buildings"]) == 50
    assert len(cop["ecps"]) == 4
    assert len(cop["rally_points"]) == 8
    assert cop["buildings_count"] == 50

    # Sensitive types are present for the security_manager role.
    types = {b["type"] for b in cop["buildings"]}
    assert SENSITIVE_TYPES & types == SENSITIVE_TYPES


def test_mef_commander_sees_full_installation_map(client):
    _login(client, "4567890123")  # Robert Hayes, mef_commander
    cop = _cop(client, "mef_commander")
    assert len(cop["buildings"]) == 50
    assert len(cop["ecps"]) == 4
    assert len(cop["rally_points"]) == 8


# ---------------------------------------------------------------------------
# Task #117 — `scope_filtered` audit row whenever the COP held records back.
#
# The auditing CDAO judge needs evidence that the role scope did its job.
# `spillage_prevented` covers the classification path; this row covers the
# OSINT path (Task #55's per-role building/ECP/RP filter), which used to be
# silent.
# ---------------------------------------------------------------------------


def _last_scope_filtered_for(actor_role: str) -> dict | None:
    """Return the most recent `scope_filtered` audit row for ``actor_role``,
    or ``None`` if the chain has none in the recent tail. The test database
    is shared across the whole module so we always look up by actor."""
    rows = recent_entries(limit=200, include_payload=True)
    for r in rows:
        if r["kind"] == AUDIT_KIND_SCOPE_FILTERED and r["actor"] == actor_role:
            return r
    return None


def test_scope_filtered_audit_emitted_for_maintenance_chief(client):
    """A reduced-view role must leave a `scope_filtered` row in the chain
    naming who, what view, and how many records were withheld — the
    auditor's evidence the OSINT scope held back content."""
    # Reset the rate-limit so this assertion isn't suppressed by a prior
    # test in the same session having already logged for this role.
    bastion_routes._SCOPE_FILTERED_LAST_LOG.pop("maintenance_chief", None)

    _login(client, "2345678901")  # Diana Kowalski, maintenance_chief
    cop_resp = _cop(client, "maintenance_chief")

    row = _last_scope_filtered_for("maintenance_chief")
    assert row is not None, (
        "maintenance_chief should produce a scope_filtered audit row when "
        "the COP held records back; chain has none."
    )
    payload = row["payload"]
    assert payload["view"] == "/bastion"
    assert payload["endpoint"] == "/api/bastion/cop"
    assert payload["decision"] == "filtered"
    assert payload["reason"] == "osint_role_scope"
    withheld = payload["withheld"]
    # The Chief gets a tiny scoped view; buildings + ECPs + RPs were all
    # cut down from the master installation footprint.
    assert withheld["buildings"] > 0, withheld
    assert withheld["ecps"] > 0, withheld
    assert withheld["rally_points"] > 0, withheld
    # And the totals/withheld arithmetic must reconcile with the response.
    totals = payload["totals"]
    assert totals["buildings"] - withheld["buildings"] == len(cop_resp["buildings"])
    assert totals["ecps"] - withheld["ecps"] == len(cop_resp["ecps"])
    assert totals["rally_points"] - withheld["rally_points"] == len(cop_resp["rally_points"])


def test_scope_filtered_audit_NOT_emitted_for_security_manager(client):
    """A full-view role withholds nothing, so no `scope_filtered` row
    should land for that actor on this request. Snapshot the chain
    head row count for the kind, hit /cop, and assert it didn't move."""
    bastion_routes._SCOPE_FILTERED_LAST_LOG.pop("security_manager", None)

    before = len([
        r for r in recent_entries(limit=200)
        if r["kind"] == AUDIT_KIND_SCOPE_FILTERED
        and r["actor"] == "security_manager"
    ])

    _login(client, "3456789012")  # James Park, security_manager
    cop_resp = _cop(client, "security_manager")
    # Sanity: full-view actually returned the master footprint.
    assert len(cop_resp["buildings"]) == 50

    after = len([
        r for r in recent_entries(limit=200)
        if r["kind"] == AUDIT_KIND_SCOPE_FILTERED
        and r["actor"] == "security_manager"
    ])
    assert after == before, (
        "security_manager is a full-view role and should NOT trigger a "
        "scope_filtered audit row for /cop; chain row count moved."
    )


def test_scope_filtered_audit_rate_limited_per_role(client):
    """A polling COP must not flood the chain. Two consecutive /cop
    calls inside the rate-limit window emit at most one row for that
    role — otherwise a 30-second refresh would write 2 rows / minute
    per operator and drown the auditor's view."""
    bastion_routes._SCOPE_FILTERED_LAST_LOG.pop("maintenance_chief", None)

    _login(client, "2345678901")  # maintenance_chief

    def _count() -> int:
        return len([
            r for r in recent_entries(limit=400)
            if r["kind"] == AUDIT_KIND_SCOPE_FILTERED
            and r["actor"] == "maintenance_chief"
        ])

    before = _count()
    _cop(client, "maintenance_chief")
    after_first = _count()
    _cop(client, "maintenance_chief")
    after_second = _count()

    assert after_first == before + 1, (
        f"first call should add exactly one scope_filtered row "
        f"(before={before}, after={after_first})"
    )
    assert after_second == after_first, (
        f"second call inside the rate-limit window must NOT add another "
        f"scope_filtered row (after_first={after_first}, after_second={after_second})"
    )


# ---------------------------------------------------------------------------
# Task #116 — `scoping` block surfaces hidden counts so a Chief reading
# "0 ECPs" understands records were elided rather than absent.
# ---------------------------------------------------------------------------

def test_scoping_block_shape_and_full_view_roles(client):
    _login(client, "2345678901")
    cop = _cop(client, "maintenance_chief")
    sc = cop.get("scoping")
    assert sc is not None, "scoping block missing from /cop response"
    for key in ("buildings_hidden", "ecps_hidden", "rally_points_hidden", "reason", "full_view_roles"):
        assert key in sc, f"scoping missing {key}"
    assert isinstance(sc["buildings_hidden"], int)
    assert isinstance(sc["ecps_hidden"], int)
    assert isinstance(sc["rally_points_hidden"], int)
    # The full_view_roles is now sourced from INSTALLATION_FULL_VIEW_ROLES
    assert sorted(sc["full_view_roles"]) == ["mef_commander", "security_manager"]
    assert sc["reason"]


def test_maintenance_chief_scoping_reports_hidden_counts(client):
    """Chief sees < the master count of buildings/ECPs/RPs; the
    `scoping` block reports the exact difference so the COP card can
    render '(N hidden)' alongside the visible numbers."""
    _login(client, "2345678901")
    cop = _cop(client, "maintenance_chief")
    sc = cop["scoping"]
    # Must hide at least some sensitive infra and out-of-sector perimeter.
    assert sc["buildings_hidden"] > 0
    assert sc["ecps_hidden"] > 0
    assert sc["rally_points_hidden"] > 0
    # Hidden + visible == master totals (50 buildings, 4 ECPs, 8 RPs).
    assert sc["buildings_hidden"] + len(cop["buildings"]) == 50
    assert sc["ecps_hidden"] + len(cop["ecps"]) == 4
    assert sc["rally_points_hidden"] + len(cop["rally_points"]) == 8
    assert "sensitive infrastructure" in sc["reason"].lower()


def test_security_manager_scoping_reports_zero_hidden(client):
    _login(client, "3456789012")
    cop = _cop(client, "security_manager")
    sc = cop["scoping"]
    assert sc["buildings_hidden"] == 0
    assert sc["ecps_hidden"] == 0
    assert sc["rally_points_hidden"] == 0
    assert "full" in sc["reason"].lower()


def test_g4_scoping_hidden_counts_consistent_with_payload(client):
    _login(client, "1234567890")
    cop = _cop(client, "g4")
    sc = cop["scoping"]
    assert sc["buildings_hidden"] == 50 - len(cop["buildings"])
    assert sc["ecps_hidden"] == 4 - len(cop["ecps"])
    assert sc["rally_points_hidden"] == 8 - len(cop["rally_points"])
    assert sc["buildings_hidden"] > 0  # 2d MLG is a strict subset of MAGTF

