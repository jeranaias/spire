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
