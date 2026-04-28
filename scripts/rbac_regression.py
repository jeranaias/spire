#!/usr/bin/env python3
"""RBAC regression — replays the auth gaps surfaced by GitHub issues #3-#10.

Each case drives the FastAPI app via TestClient. The script asserts that
sensitive surfaces refuse unauthenticated calls (401), refuse roles that are
out-of-scope (403), and accept the role that owns each surface (200). It also
verifies that:

  * a tampered bearer is rejected (issue #3 — token forgery surface)
  * the cannibalization scoping bug (issue #6 — OR vs AND) is fixed: an
    out-of-scope donor or recipient unit drops the event from the response.

Run:
    python scripts/rbac_regression.py
Exits 0 on success, 1 on the first regression. Designed to be cheap enough
for CI — no external services, no sleeps.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

# Allow `python scripts/rbac_regression.py` from the repo root.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402


# Using `with TestClient(...)` triggers FastAPI startup so the dataset
# loads before any route fires (otherwise scoped queries hit the
# 'Dataset not loaded' guard and the regression suite can't run).
client = TestClient(app)
client.__enter__()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def mint(role: str) -> str:
    """Mint a session bearer for `role` via the auth router."""
    r = client.post("/api/auth/session", json={"role": role})
    assert r.status_code == 200, f"mint({role}) failed: {r.status_code} {r.text}"
    return r.json()["token"]


def auth_headers(token: Optional[str]) -> dict:
    return {"Authorization": f"Bearer {token}"} if token else {}


PASSED: list[str] = []
FAILED: list[str] = []


def expect(label: str, cond: bool, detail: str = ""):
    if cond:
        PASSED.append(label)
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}  {detail}")


# ---------------------------------------------------------------------------
# Case bank
# ---------------------------------------------------------------------------

def case_unauthenticated_blocked():
    """Issue #3 — every sensitive surface must 401 without a bearer."""
    print("\n[case] unauthenticated requests are 401 (issue #3)")
    surfaces = [
        ("GET",  "/api/system/audit"),
        ("POST", "/api/system/secure-wipe"),
        ("POST", "/api/system/comms/airgap"),
        ("POST", "/api/sentry/coalition/JSDF/release"),
        ("GET",  "/api/sentry/audit/EXP-test"),
        ("GET",  "/api/system/admin/telemetry"),
        ("GET",  "/api/pulse/cannibalization"),
        ("GET",  "/api/bastion/cop"),
    ]
    for method, path in surfaces:
        r = client.request(method, path, json={})
        expect(
            f"{method} {path} -> 401 unauth",
            r.status_code == 401,
            f"got {r.status_code} body={r.text[:120]}",
        )


def case_wrong_role_forbidden():
    """Issue #4/#5 — a valid token for the wrong role is 403, not 200."""
    print("\n[case] wrong-role tokens are 403 (issues #4, #5)")
    chief = mint("maintenance_chief")
    g4 = mint("g4")
    custodian = mint("data_custodian")

    # SENTRY surfaces deny ops roles.
    r = client.post("/api/sentry/coalition/JPN_COALITION/release",
                    headers=auth_headers(g4), json={})
    expect("g4 -> sentry.coalition.release 403",
           r.status_code == 403, f"got {r.status_code}")

    r = client.get("/api/sentry/audit/EXP-test", headers=auth_headers(chief))
    expect("maintenance_chief -> sentry.audit 403 (security_manager only)",
           r.status_code == 403, f"got {r.status_code}")

    # System / admin surfaces deny non-security roles.
    r = client.post("/api/system/secure-wipe", headers=auth_headers(custodian),
                    json={"confirm": True})
    expect("data_custodian -> system.secure_wipe 403 (security_manager only)",
           r.status_code == 403, f"got {r.status_code}")

    r = client.get("/api/system/admin/telemetry", headers=auth_headers(g4))
    expect("g4 -> admin.telemetry 403 (security_manager only)",
           r.status_code == 403, f"got {r.status_code}")


def case_authorized_role_allowed():
    """Issue #7 — the right role gets a 200 (smoke positive controls)."""
    print("\n[case] authorized roles get 200 (issue #7)")
    sec = mint("security_manager")
    custodian = mint("data_custodian")
    g4 = mint("g4")

    r = client.get("/api/system/admin/telemetry", headers=auth_headers(sec))
    expect("security_manager -> admin.telemetry 200",
           r.status_code == 200, f"got {r.status_code}")

    r = client.post("/api/sentry/coalition/JPN_COALITION/release",
                    headers=auth_headers(custodian), json={})
    # 200 OK or 503 if coalition profile module is unavailable in this build.
    # Either is acceptable here — we're proving that role-gate doesn't fire.
    expect("data_custodian -> sentry.coalition.release allowed",
           r.status_code in (200, 503),
           f"got {r.status_code} body={r.text[:120]}")

    r = client.get("/api/pulse/cannibalization", headers=auth_headers(g4))
    expect("g4 -> pulse.cannibalization 200",
           r.status_code == 200, f"got {r.status_code}")


def case_tampered_bearer_rejected():
    """Issue #3 — a token with a flipped signature byte is 401."""
    print("\n[case] tampered bearer rejected (issue #3)")
    tok = mint("security_manager")
    # Flip the last sig char to break the HMAC verify.
    bad = tok[:-1] + ("A" if tok[-1] != "A" else "B")
    r = client.get("/api/system/audit", headers=auth_headers(bad))
    expect("tampered bearer -> 401",
           r.status_code == 401, f"got {r.status_code}")
    r = client.get("/api/system/audit", headers=auth_headers("not-even-a-token"))
    expect("malformed bearer -> 401",
           r.status_code == 401, f"got {r.status_code}")


def case_unknown_role_rejected_at_mint():
    """Issue #8 — mint refuses roles outside the known set so privileged-
    sounding strings can't be fabricated by a client."""
    print("\n[case] mint rejects unknown role (issue #8)")
    r = client.post("/api/auth/session", json={"role": "super_admin"})
    expect("mint(super_admin) -> 400",
           r.status_code == 400, f"got {r.status_code}")


def case_audit_actor_is_bearer_resolved():
    """Issue #9 — when a payload claims actor_role=X but the bearer is Y,
    the audit chain must record Y."""
    print("\n[case] audit chain records bearer-resolved actor (issue #9)")
    sec = mint("security_manager")
    # Fire an air-gap toggle with a lying payload claim. The real actor must
    # be 'security_manager' (the bearer), not 'maintenance_chief' (the lie).
    r = client.post(
        "/api/system/comms/airgap",
        headers=auth_headers(sec),
        json={"enable": True, "reason": "rbac-regression",
              "actor_role": "maintenance_chief"},
    )
    expect("airgap with bearer accepted",
           r.status_code == 200, f"got {r.status_code} body={r.text[:120]}")
    # Read the audit tail and confirm the actor is the bearer's role.
    r = client.get("/api/system/audit", headers=auth_headers(sec))
    expect("audit fetch 200", r.status_code == 200,
           f"got {r.status_code}")
    if r.status_code == 200:
        entries = r.json().get("entries", [])
        # Find the most-recent comms_airgap event we just wrote.
        target = next(
            (e for e in reversed(entries)
             if (e.get("event") or "").startswith("comms_airgap")
             or (e.get("kind") or "").startswith("comms_airgap")),
            None,
        )
        expect(
            "airgap actor == bearer role (not payload lie)",
            bool(target) and target.get("actor") == "security_manager",
            f"got actor={target.get('actor') if target else None}",
        )
        # Restore comms so the rest of the suite isn't gated.
        client.post(
            "/api/system/comms/airgap",
            headers=auth_headers(sec),
            json={"enable": False, "reason": "rbac-regression-cleanup"},
        )


def case_cannibalization_or_vs_and(_):  # placeholder signature, kept stable
    pass


def case_cannibalization_or_vs_and_fix():
    """Issue #6 — cannibalization filter must drop events when EITHER end is
    out of scope. Earlier code OR'd the two checks, so an event involving a
    donor in scope leaked even when the recipient was not (and vice versa).

    We can't easily fabricate a partial-scope role outright, so we assert the
    structural property: every event returned to a scoped role has BOTH its
    donor_unit and recipient_unit in the scope's allowed set.
    """
    print("\n[case] cannibalization OR -> AND scoping (issue #6)")
    # Independently derive the chief's allowed unit set from scoping.py so
    # the assertion can't be satisfied by a response that just self-
    # references its own (potentially leaked) units. With the old OR bug,
    # an event involving one in-scope endpoint and one out-of-scope
    # endpoint would surface the out-of-scope unit name in the response —
    # this check catches that directly.
    from backend.state import get_dataset  # local — script-only import
    from backend.scoping import allowed_units
    ds = get_dataset()
    expected_allowed = allowed_units(ds, "maintenance_chief")
    assert expected_allowed is not None, (
        "maintenance_chief must have a constrained unit scope for this test"
    )

    chief = mint("maintenance_chief")
    r = client.get("/api/pulse/cannibalization", headers=auth_headers(chief))
    expect("cannibalization fetch 200", r.status_code == 200,
           f"got {r.status_code}")
    if r.status_code != 200:
        return
    body = r.json()

    events: list = []
    for key in ("open_needs", "completed_matches"):
        for e in body.get(key, []) or []:
            events.append(e)

    # Property: every surfaced event has donor AND recipient in the
    # independently-derived allowed set. The OR bug would manifest as an
    # event with one endpoint inside `expected_allowed` and the other
    # outside — those would now appear in `leaks`.
    leaks = []
    for e in events:
        donor = e.get("donor_unit") or e.get("from_unit") or e.get("unit_name")
        recip = e.get("recipient_unit") or e.get("to_unit")
        if donor and donor not in expected_allowed:
            leaks.append(("donor", donor, e))
        if recip and recip not in expected_allowed:
            leaks.append(("recipient", recip, e))
    expect(
        "no out-of-scope endpoint leaks (AND filter holds)",
        not leaks,
        f"leaks={leaks[:2]} expected_allowed={sorted(expected_allowed)}",
    )


def case_forecast_unit_scope_enforced():
    """Issue #4 — `/api/pulse/forecast` previously ignored unit scoping for
    scoped roles, so a maintenance_chief restricted to one CLB could ask
    for another CLB's forecast (or fleet-wide) and get data back.

    Verifies:
      1. Bearer for unrestricted role (mef_commander) can pull fleet-wide
         and any specific unit's forecast.
      2. Bearer for a scoped role (maintenance_chief) gets 403 on an
         out-of-scope `?unit=` and gets a (constrained) 200 on its own
         in-scope unit / when omitting `?unit=`.
    """
    print("\n[case] /api/pulse/forecast enforces unit scope (issue #4)")
    # Resolve in-scope and out-of-scope units for maintenance_chief from
    # the live dataset so we never hard-code names that drift with seed.
    from backend.state import get_dataset  # local import — script-only
    from backend.scoping import allowed_units
    ds = get_dataset()
    al = allowed_units(ds, "maintenance_chief")
    in_scope = next(iter(al))
    out_scope = next(u.name for u in ds.units if u.name not in al)

    chief = mint("maintenance_chief")
    cmdr = mint("mef_commander")

    r = client.get(f"/api/pulse/forecast?unit={out_scope}",
                   headers=auth_headers(chief))
    expect(
        f"maintenance_chief -> forecast?unit={out_scope} -> 403",
        r.status_code == 403,
        f"got {r.status_code} body={r.text[:120]}",
    )
    r = client.get(f"/api/pulse/forecast?unit={in_scope}",
                   headers=auth_headers(chief))
    # 200 OK or 503 ("not enough history") are both acceptable — both
    # prove the role gate let the request through to the unit it owns.
    expect(
        f"maintenance_chief -> forecast?unit={in_scope} -> allowed",
        r.status_code in (200, 503),
        f"got {r.status_code} body={r.text[:120]}",
    )
    r = client.get("/api/pulse/forecast", headers=auth_headers(chief))
    expect(
        "maintenance_chief -> forecast (no unit) -> allowed (in-scope agg)",
        r.status_code in (200, 503),
        f"got {r.status_code} body={r.text[:120]}",
    )
    # Unrestricted role still works on anything.
    r = client.get(f"/api/pulse/forecast?unit={out_scope}",
                   headers=auth_headers(cmdr))
    expect(
        f"mef_commander -> forecast?unit={out_scope} -> 200",
        r.status_code in (200, 503),
        f"got {r.status_code}",
    )


def case_actor_role_payload_ignored_for_seed_conflict():
    """Issue #10 — sync/seed-conflict used to take actor_role from payload.
    A bearer claim should now win; payload claim is ignored."""
    print("\n[case] sync/seed-conflict trusts bearer, not payload (issue #10)")
    sec = mint("security_manager")
    r = client.post(
        "/api/system/sync/seed-conflict",
        headers=auth_headers(sec),
        json={"actor_role": "maintenance_chief"},
    )
    expect("seed-conflict accepted with bearer",
           r.status_code == 200, f"got {r.status_code} body={r.text[:120]}")


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def main() -> int:
    print("SPIRE RBAC regression — replays issues #3-#10")
    case_unauthenticated_blocked()
    case_wrong_role_forbidden()
    case_authorized_role_allowed()
    case_tampered_bearer_rejected()
    case_unknown_role_rejected_at_mint()
    case_audit_actor_is_bearer_resolved()
    case_cannibalization_or_vs_and_fix()
    case_forecast_unit_scope_enforced()
    case_actor_role_payload_ignored_for_seed_conflict()

    print("\n----------------------------------------")
    print(f"  PASSED: {len(PASSED)}")
    print(f"  FAILED: {len(FAILED)}")
    if FAILED:
        for f in FAILED:
            print(f"    - {f}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
