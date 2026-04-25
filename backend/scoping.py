"""
Role-based data scoping.

Every request can pass `?role=<role>` and the backend filters the records
that role is allowed to see. This makes the TopBar role dropdown actually
change what's visible rather than just changing the default view.

Scoping rules follow the spec's §Role-based Access section:

  maintenance_chief  → scoped to CLB-6 only (the chief's own unit)
  g4                 → scoped to 2d MLG parent command
  mef_commander      → full MEF view (no filter)
  data_custodian     → no PULSE/BASTION filter; primary home is SENTRY
  security_manager   → no filter; primary home is audit log
  (unknown / absent) → no filter -- safe default for demo paths
"""
from __future__ import annotations

from typing import Iterable, Optional

from fastapi import HTTPException

from .state import CanonicalDataset


# Per-action role allowlists. Server-side enforcement so URL-hacking past
# the frontend's ScopeGuard returns 403 instead of executing. The full
# CAC-bound identity layer migrates pre-ATO; this is the durable subset
# that defangs the catastrophic surfaces (audit-chain wipe, coalition
# release, air-gap toggle, admin telemetry read) without waiting for it.
SECURE_WIPE_ROLES        = frozenset({"security_manager"})
AIRGAP_ROLES             = frozenset({"security_manager", "mef_commander"})
COALITION_RELEASE_ROLES  = frozenset({"data_custodian", "security_manager"})
ADMIN_TELEMETRY_ROLES    = frozenset({"security_manager"})
AUDIT_READ_ROLES         = frozenset({"security_manager"})


def require_role(role: Optional[str], allowed: frozenset[str], action: str) -> str:
    """Raise 403 unless `role` is in `allowed`. Returns the role on success.

    `action` is a short label included in the error body so the operator
    sees which gate denied them. Audit-log entries elsewhere reference the
    same string so an investigator can correlate.
    """
    if not role or role not in allowed:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "InsufficientPrivilege",
                "action": action,
                "role_seen": role or "unknown",
                "roles_allowed": sorted(allowed),
            },
        )
    return role


ROLE_TO_UNITS_FILTER: dict[str, dict] = {
    "maintenance_chief": {"units": {"CLB-6"}, "parents": set()},
    "g4":                {"units": set(), "parents": {"2d MLG"}},
    "mef_commander":     {"units": set(), "parents": set()},   # no filter
    "data_custodian":    {"units": set(), "parents": set()},   # no filter
    "security_manager":  {"units": set(), "parents": set()},   # no filter
}


def allowed_units(ds: CanonicalDataset, role: Optional[str]) -> Optional[set[str]]:
    """Return a set of unit names the role can see, or None for unrestricted."""
    if not role or role not in ROLE_TO_UNITS_FILTER:
        return None
    rule = ROLE_TO_UNITS_FILTER[role]
    if not rule["units"] and not rule["parents"]:
        return None
    allowed: set[str] = set(rule["units"])
    if rule["parents"]:
        for u in ds.units:
            if u.parent in rule["parents"]:
                allowed.add(u.name)
    return allowed


def filter_units(ds: CanonicalDataset, role: Optional[str]) -> list:
    """Return the list of Unit objects visible to this role."""
    allowed = allowed_units(ds, role)
    if allowed is None:
        return ds.units
    return [u for u in ds.units if u.name in allowed]


def filter_assets(ds: CanonicalDataset, role: Optional[str]) -> list:
    """Return the list of Asset objects visible to this role."""
    allowed = allowed_units(ds, role)
    if allowed is None:
        return ds.assets
    return [a for a in ds.assets if a.unit_name in allowed]


def keep(role: Optional[str], allowed: Optional[set[str]], unit_name: str) -> bool:
    """Filter predicate used inside endpoint comprehensions."""
    if allowed is None:
        return True
    return unit_name in allowed
