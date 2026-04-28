"""
Task #119 — lock down the cert-directory field list so it can never re-leak
before sign-in.

Task #27 trimmed the unauthenticated `GET /api/auth/users` payload down to
the eight fields a real CAC reader surfaces on the cert-selection screen
(`name`, `rank`, `branch`, masked `dodid`, `initials`, plus the three cert
metadata fields). Nothing today stops someone from absent-mindedly
re-adding `clearance`, `role`, `billet`, `unit`, or `parent_command` to
`_PUBLIC_USER_FIELDS` in `backend/auth.py` — or from writing a new helper
that bypasses it. Either regression would let a passer-by glancing at the
splash (or an unauth API caller) re-enumerate who holds TS//SCI vs
SECRET, who is the security manager, etc.

This module pins the contract on both sides of the auth gate:

  • Unauthenticated callers get EXACTLY the eight public fields per cert,
    and none of the sensitive fields appear on any element.
  • Authenticated callers get the FULL 16-field payload so the in-app
    identity switcher in `frontend/src/components/TopBar.tsx` keeps
    working.

It also pins the `cert_serial` / `dodid` shapes (16 hex chars, no `0x`
prefix; 10 digits) so a future "let's pretty-print the serial" change
doesn't quietly break the CAC-reader illusion.
"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from backend.auth import MOCK_USERS
from backend.main import app


# Exact key set the splash is allowed to see. Mirrors `_PUBLIC_USER_FIELDS`
# in `backend/auth.py` and `PublicAuthUser` in `frontend/src/api.ts`.
EXPECTED_PUBLIC_KEYS: frozenset[str] = frozenset(
    {
        "dodid",
        "name",
        "rank",
        "branch",
        "initials",
        "cert_issuer",
        "cert_serial",
        "cert_expires",
    }
)

# Fields that MUST NOT appear on the unauthenticated payload. Re-adding
# any of these is the regression this test exists to catch.
FORBIDDEN_PUBLIC_KEYS: frozenset[str] = frozenset(
    {
        "clearance",
        "role",
        "billet",
        "unit",
        "parent_command",
        "first_name",
        "last_name",
        "rank_long",
    }
)

# Authenticated callers get the full directory. Mirrors `MOCK_USERS` keys
# and `AuthUser` in `frontend/src/api.ts`. The count (16) is part of the
# contract — bumping it requires updating both ends.
EXPECTED_FULL_KEYS: frozenset[str] = EXPECTED_PUBLIC_KEYS | FORBIDDEN_PUBLIC_KEYS

CERT_SERIAL_RE = re.compile(r"^[0-9A-Fa-f]{16}$")
DODID_RE = re.compile(r"^\d{10}$")


@pytest.fixture()
def client():
    # Fresh client per test so the authenticated case can't leak its
    # session cookie back into the unauthenticated case.
    with TestClient(app) as c:
        yield c


def test_unauthenticated_users_endpoint_returns_only_public_fields(client):
    """No cookie → strictly the 8 public fields per cert, nothing else."""
    resp = client.get("/api/auth/users")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "users" in body and isinstance(body["users"], list)
    users = body["users"]
    assert len(users) == len(MOCK_USERS), (
        f"expected {len(MOCK_USERS)} certs on the splash, got {len(users)}"
    )

    for entry in users:
        keys = set(entry.keys())

        # Exact set — catches both additions (re-leaks) and accidental
        # removals (would break the splash).
        assert keys == EXPECTED_PUBLIC_KEYS, (
            f"unauthenticated cert payload key drift for dodid={entry.get('dodid')!r}: "
            f"unexpected={sorted(keys - EXPECTED_PUBLIC_KEYS)}, "
            f"missing={sorted(EXPECTED_PUBLIC_KEYS - keys)}"
        )

        # Defense in depth — re-state the OPSEC invariant directly so a
        # future refactor of EXPECTED_PUBLIC_KEYS can't silently weaken
        # the test.
        leaked = keys & FORBIDDEN_PUBLIC_KEYS
        assert not leaked, (
            f"sensitive fields leaked on unauthenticated /api/auth/users "
            f"for dodid={entry.get('dodid')!r}: {sorted(leaked)}"
        )

        # Cert serial: 16 hex chars, mixed case allowed, no `0x` prefix
        # — the shape DEERS actually issues. Task #27 F7.
        serial = entry["cert_serial"]
        assert isinstance(serial, str) and CERT_SERIAL_RE.match(serial), (
            f"cert_serial {serial!r} is not 16 hex chars (no 0x prefix) "
            f"for dodid={entry.get('dodid')!r}"
        )

        # DODID must remain a 10-digit string. The splash masks it
        # client-side; the wire shape is still the canonical 10-digit
        # form so the in-app switcher can match it.
        dodid = entry["dodid"]
        assert isinstance(dodid, str) and DODID_RE.match(dodid), (
            f"dodid {dodid!r} is not a 10-digit string"
        )


def test_authenticated_users_endpoint_returns_full_payload(client):
    """With a valid session cookie → full 16-field directory.

    The in-app identity switcher in `frontend/src/components/TopBar.tsx`
    relies on the post-login re-fetch returning the full `AuthUser`
    shape (role / billet / clearance / unit / parent_command). If this
    test fails, the topbar switcher will render with empty role badges.
    """
    # Sign in as Reyes (g4, SECRET). Any of the four mock CACs would
    # do — the response shape is identical across roles.
    login = client.post(
        "/api/auth/login",
        json={"dodid": "1234567890", "pin": "123456"},
    )
    assert login.status_code == 200, login.text

    resp = client.get("/api/auth/users")
    assert resp.status_code == 200, resp.text
    users = resp.json()["users"]
    assert len(users) == len(MOCK_USERS)

    for entry in users:
        keys = set(entry.keys())
        assert keys == EXPECTED_FULL_KEYS, (
            f"authenticated cert payload key drift for dodid={entry.get('dodid')!r}: "
            f"unexpected={sorted(keys - EXPECTED_FULL_KEYS)}, "
            f"missing={sorted(EXPECTED_FULL_KEYS - keys)}"
        )
        # Spot-check that the previously-stripped sensitive fields are
        # actually present and non-empty for an authenticated caller —
        # the topbar switcher needs them.
        for sensitive in ("clearance", "role", "billet", "unit", "parent_command"):
            assert entry.get(sensitive), (
                f"authenticated payload missing sensitive field "
                f"{sensitive!r} for dodid={entry.get('dodid')!r}"
            )
