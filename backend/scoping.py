"""
Role-based data scoping + classification clearance gating.

Classification gates are co-located with role gates because they share the
same shape (raise 403 + structured detail + audit trail entry). The numeric
rank model — UNCLAS=0 → TS//SCI=5 — is the truth source the frontend gate
mirrors; the backend always re-checks because the FE primitive is UX, not
authorization.

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
# SENTRY Review Queue clearing authority. A maintenance chief can flag /
# triage but may not approve, reject, or modify a held SR — that decision
# touches the hash-chained marking record and must sit with the data
# custodian / security manager / MEF commander pay grade. G-4 stays in the
# allowlist because the operator-class persona owns the daily review pace.
SENTRY_REVIEW_ROLES      = frozenset({"g4", "data_custodian", "security_manager", "mef_commander"})
# Mission-clock playback controls (B4). Operator-class roles only — the
# clock is a piece of demo plumbing, not an analyst surface.
SCENARIO_CONTROL_ROLES   = frozenset({"security_manager", "mef_commander", "g4"})

# Model registry / supply-chain page (W1 task #30). The model card surface
# enumerates every model SPIRE uses with its provenance, hosting target,
# vendor jurisdiction, and validation history. The data is mostly public
# but exposing 'who runs what model where' to lower roles invites
# adversary mining of the SPIRE supply chain — gate it to security_manager.
MODEL_REGISTRY_ROLES     = frozenset({"security_manager"})


# ---------------------------------------------------------------------------
# Classification / clearance ranking — the truth source for export gates.
# ---------------------------------------------------------------------------

# UNCLAS=0 monotone up to TS//SCI=5. Order chosen so `next_rank >= prev_rank`
# is the monotonic-write check and `user_rank >= artifact_rank` is the
# clearance check. Aligned with frontend `levels.ts` so a single mental model
# governs both layers.
CLEARANCE_RANK: dict[str, int] = {
    "UNCLASSIFIED": 0,
    "CUI":          1,
    "CONFIDENTIAL": 2,
    "SECRET":       3,
    "TOP_SECRET":   4,
    "TS_SCI":       5,
}


def _normalize_classification(raw: Optional[str]) -> str:
    """Collapse common spelling variants to canonical keys.

    Accepts "TS//SCI", "TOP SECRET//SCI", "TS_SCI", "Top Secret", "FOUO",
    "controlled", etc. Returns one of the CLEARANCE_RANK keys; unknowns map
    to UNCLASSIFIED so the gate stays permissive for benign records (the
    real classified content always passes through `tier1_classify` upstream).
    """
    if not raw:
        return "UNCLASSIFIED"
    s = str(raw).strip().upper().replace(" ", "_").replace("/", "_")
    while "__" in s:
        s = s.replace("__", "_")
    if "SCI" in s and ("TS" in s or "TOP_SECRET" in s):
        return "TS_SCI"
    if "TOP_SECRET" in s or s == "TS":
        return "TOP_SECRET"
    if "SECRET" in s and "TOP" not in s:
        return "SECRET"
    if "CONFIDENTIAL" in s:
        return "CONFIDENTIAL"
    if s == "CUI" or "CONTROLLED" in s or s == "FOUO":
        return "CUI"
    if "UNCLAS" in s:
        return "UNCLASSIFIED"
    return "UNCLASSIFIED"


def classification_rank(raw: Optional[str]) -> int:
    return CLEARANCE_RANK[_normalize_classification(raw)]


def clearance_rank(raw: Optional[str]) -> int:
    # Same lattice as artifact classification — kept as a separate name so
    # call sites read intentionally ("user clearance" vs "artifact class").
    return CLEARANCE_RANK[_normalize_classification(raw)]


def meets_clearance(user: Optional[dict], required: str) -> bool:
    if not user:
        return False
    return clearance_rank(user.get("clearance")) >= classification_rank(required)


def require_clearance(
    user: Optional[dict],
    required: str,
    action: str,
    *,
    audit_actor: Optional[str] = None,
    audit_subject: Optional[str] = None,
) -> str:
    """Backend export-gate truth source.

    Raises 403 + emits a `spillage_prevented` audit entry when the
    operator's clearance rank is below the artifact's classification rank.
    Returns the normalized classification string on success so callers can
    persist it on the artifact / bundle metadata.
    """
    canonical = _normalize_classification(required)
    if user is None:
        # Should never happen behind session_middleware, but defend anyway.
        raise HTTPException(
            status_code=403,
            detail={
                "error": "Unauthenticated",
                "action": action,
                "required_classification": canonical,
            },
        )
    user_clearance = _normalize_classification(user.get("clearance"))
    if clearance_rank(user_clearance) < classification_rank(canonical):
        # Append-only spillage record. Lazy-import to avoid the persistence
        # module pulling SQLite at scoping import time (CLI tools that touch
        # scoping.py shouldn't trigger DB init).
        try:
            from .persistence import log as audit_log  # noqa: WPS433
            audit_log(
                "spillage_prevented",
                actor=audit_actor or user.get("role") or "unknown",
                subject_id=audit_subject or action,
                payload={
                    "action": action,
                    "user_dodid": user.get("dodid"),
                    "user_role": user.get("role"),
                    "user_clearance": user_clearance,
                    "required_classification": canonical,
                    "decision": "blocked",
                    "surface": "backend",
                },
            )
        except Exception:
            # Never let an audit-write failure mask the 403 — we still
            # block the spillage; the chain just temporarily lost a row.
            pass
        raise HTTPException(
            status_code=403,
            detail={
                "error": "InsufficientClearance",
                "action": action,
                "required_classification": canonical,
                "user_clearance": user_clearance,
                "user_role": user.get("role"),
            },
        )
    return canonical


def require_no_downgrade(
    prev: Optional[str],
    new: Optional[str],
    *,
    actor: str,
    action: str,
    subject_id: Optional[str] = None,
) -> str:
    """Block monotonic-write violations.

    Classification can only be raised or held — never lowered — without an
    explicit downgrade-with-justification flow. That flow is out of scope
    for this lane; this helper surfaces the block (403 + audit) so the
    UI can render the message cleanly.
    """
    new_canonical = _normalize_classification(new)
    if prev is None:
        return new_canonical
    if classification_rank(new_canonical) < classification_rank(prev):
        try:
            from .persistence import log as audit_log  # noqa: WPS433
            audit_log(
                "downgrade_blocked",
                actor=actor,
                subject_id=subject_id or action,
                payload={
                    "action": action,
                    "prev_classification": _normalize_classification(prev),
                    "attempted_classification": new_canonical,
                    "decision": "blocked",
                    "reason": "monotonic_write_violation",
                },
            )
        except Exception:
            pass
        raise HTTPException(
            status_code=403,
            detail={
                "error": "DowngradeBlocked",
                "action": action,
                "prev_classification": _normalize_classification(prev),
                "attempted_classification": new_canonical,
                "remediation": (
                    "Classification is monotonic. Raise via standard write or "
                    "open the formal downgrade-with-justification request."
                ),
            },
        )
    return new_canonical


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
