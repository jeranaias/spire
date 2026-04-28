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

from fastapi import HTTPException, Request

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
# SENTRY sanitized export + download. The Export tab is custodian-class only;
# operator/commander roles see the FE InsufficientPrivilege panel and the
# backend mirrors that with `require_user_role` so a curl past the FE gate
# returns 403 with `InsufficientRole` rather than a 2,306-record bundle.
SENTRY_EXPORT_ROLES      = frozenset({"data_custodian", "security_manager"})
# Mission-clock playback controls (B4). Operator-class roles only — the
# clock is a piece of demo plumbing, not an analyst surface.
SCENARIO_CONTROL_ROLES   = frozenset({"security_manager", "mef_commander", "g4"})

# BASTION ThermalHawk simulate (task #54 / critique F1). The button is
# hidden in the UI for everyone outside this set; the API now mirrors
# that gate so a Maintenance Chief's CAC can't reach the endpoint via
# `curl` and trigger a CRITICAL UAS incident on another battalion's
# motor pool. Matches `frontend/src/views/BastionView.tsx:674`.
BASTION_SIMULATE_ROLES   = frozenset({"mef_commander", "security_manager", "g4"})

# Joint COP export — release authority for the OMS/UCI and Link 16 adapters.
# A joint export is a topic-style subscription (the partner J4 console wants
# the full MAGTF), not a per-operator slice. We therefore gate emission to
# release-authority roles instead of letting per-operator unit scoping
# silently shape the partner's view. `joint_release_authority` is reserved
# for a future dedicated billet; the two existing roles cover demo identities.
JOINT_RELEASE_ROLES      = frozenset({
    "security_manager",
    "mef_commander",
    "joint_release_authority",
})

# Model registry / supply-chain page (W1 task #30). The model card surface
# enumerates every model SPIRE uses with its provenance, hosting target,
# vendor jurisdiction, and validation history. The data is mostly public
# but exposing 'who runs what model where' to lower roles invites
# adversary mining of the SPIRE supply chain — gate it to security_manager.
MODEL_REGISTRY_ROLES     = frozenset({"security_manager"})


# ---------------------------------------------------------------------------
# View-level role gates — backend mirror of `VIEW_SCOPE` in
# `frontend/src/state/store.ts`.
#
# The React ScopeGuard hides whole tabs (PULSE / BASTION / Admin / SENTRY)
# from roles that aren't supposed to see them. Without a matching backend
# gate, anyone with a valid session cookie can hand-roll
# `GET /api/pulse/fleet-overview` (or any sibling) past the FE shell and
# get the full payload — the PULSE Fleet Overview critique (F-2) caught
# `security_manager` doing exactly that. These constants are the truth
# source the router-level dependency `require_view_scope` enforces.
#
# Keep these in lockstep with the frontend table; the regression test in
# `backend/tests/test_role_gates.py` walks every (CAC × view) combo and
# asserts FE allow/deny == BE allow/deny so drift is caught at CI time.
# ---------------------------------------------------------------------------
PULSE_VIEW_ROLES   = frozenset({"maintenance_chief", "g4", "mef_commander"})
BASTION_VIEW_ROLES = frozenset({"mef_commander", "g4", "security_manager", "maintenance_chief"})
ADMIN_VIEW_ROLES   = frozenset({"security_manager"})
SENTRY_VIEW_ROLES  = frozenset({"data_custodian", "security_manager", "maintenance_chief", "g4"})

VIEW_ROLES: dict[str, frozenset[str]] = {
    "/pulse":   PULSE_VIEW_ROLES,
    "/bastion": BASTION_VIEW_ROLES,
    "/admin":   ADMIN_VIEW_ROLES,
    "/sentry":  SENTRY_VIEW_ROLES,
}


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


def require_role(
    role: Optional[str],
    allowed: frozenset[str],
    action: str,
    *,
    audit_actor: Optional[str] = None,
    audit_subject: Optional[str] = None,
    user_dodid: Optional[str] = None,
) -> str:
    """Raise 403 + emit a `role_denied` audit row unless `role` is in `allowed`.

    `action` is a short label included in the error body and the audit
    payload so an investigator can correlate the deny with the request.
    Audit emission mirrors the `spillage_prevented` pattern in
    `require_clearance`: every blocked request leaves a row in the chain.
    """
    if not role or role not in allowed:
        try:
            from .persistence import log as audit_log  # noqa: WPS433
            audit_log(
                "role_denied",
                actor=audit_actor or role or "unknown",
                subject_id=audit_subject or action,
                payload={
                    "action": action,
                    "user_role": role or "unknown",
                    "user_dodid": user_dodid,
                    "roles_allowed": sorted(allowed),
                    "decision": "blocked",
                    "surface": "backend",
                },
            )
        except Exception:
            # Never let an audit-write failure mask the 403 — block first,
            # log second; the chain just temporarily lost a row.
            pass
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


# ---------------------------------------------------------------------------
# Router-level view-scope dependency.
#
# Mounted on the router include in `backend/main.py` for entire view groups
# (PULSE, BASTION) so EVERY route under that prefix is gated without
# touching individual handlers. Reads `request.state.user` populated by
# `session_middleware`; never re-parses the cookie itself (the auth
# middleware contract is preserved).
#
# Emits a `view_scope_denied` audit row on deny, structurally identical to
# `spillage_prevented` so the same downstream tooling can ingest both.
# ---------------------------------------------------------------------------

def require_view_scope(view: str, allowed: frozenset[str]):
    """Build a FastAPI dependency that gates a router by view-level role.

    Use as ``Depends(require_view_scope("/pulse", PULSE_VIEW_ROLES))`` in
    the ``dependencies=[...]`` kwarg on ``include_router``. The factory
    runs once at app boot; the returned coroutine runs per request after
    auth middleware has set ``request.state.user``.
    """
    allowed_sorted = sorted(allowed)

    async def _dep(request: Request) -> str:
        user = getattr(request.state, "user", None)
        if user is None:
            # Defensive: session_middleware should have already 401'd any
            # unauthenticated /api/* request. If this branch ever fires it
            # means a route slipped past the open-prefix list.
            raise HTTPException(
                status_code=401,
                detail={"error": "Unauthenticated", "view": view},
            )
        role = user.get("role")
        if role in allowed:
            return role
        try:
            from .persistence import log as audit_log  # noqa: WPS433
            audit_log(
                "view_scope_denied",
                actor=role or "unknown",
                subject_id=request.url.path,
                payload={
                    "view": view,
                    "path": request.url.path,
                    "method": request.method,
                    "user_dodid": user.get("dodid"),
                    "user_role": role,
                    "roles_allowed": allowed_sorted,
                    "decision": "blocked",
                    "surface": "backend",
                },
            )
        except Exception:
            pass
        raise HTTPException(
            status_code=403,
            detail={
                "error": "OutOfScope",
                "view": view,
                "user_role": role,
                "roles_allowed": allowed_sorted,
                "remediation": (
                    f"This view is restricted to {', '.join(allowed_sorted)}. "
                    "Sign in with a CAC bearing one of those roles."
                ),
            },
        )

    return _dep


def require_user_role(
    user: Optional[dict],
    allowed: frozenset[str],
    action: str,
    *,
    audit_subject: Optional[str] = None,
) -> str:
    """Backend role-gate companion to `require_clearance`.

    Companion (not replacement) of `require_role` because this variant takes
    the full session `user` dict — same shape `require_clearance` consumes —
    and writes a structured `role_denied` audit entry on a miss. The dict
    surface lets the audit row carry the user's DoDID alongside the role,
    which an investigator needs to chase a misuse claim back to the cert.

    The error body uses `InsufficientRole` (distinct from the legacy
    `InsufficientPrivilege` shape `require_role` returns) so frontends can
    branch on the wire contract without grepping action strings. Both
    helpers write `role_denied` audit rows so the SOC view sees a single
    consistent kind regardless of which gate fired.
    """
    if user is None:
        # Should never happen behind session_middleware, but defend anyway.
        raise HTTPException(
            status_code=403,
            detail={
                "error": "Unauthenticated",
                "action": action,
                "roles_allowed": sorted(allowed),
            },
        )
    role = user.get("role")
    if not role or role not in allowed:
        # Append-only role-denial record. Lazy-import for the same reason
        # require_clearance does — keep CLI tools from triggering DB init.
        try:
            from .persistence import log as audit_log  # noqa: WPS433
            audit_log(
                "role_denied",
                actor=role or "unknown",
                subject_id=audit_subject or action,
                payload={
                    "action": action,
                    "user_dodid": user.get("dodid"),
                    "user_role": role,
                    "user_clearance": user.get("clearance"),
                    "roles_allowed": sorted(allowed),
                    "decision": "blocked",
                    "surface": "backend",
                },
            )
        except Exception:
            # Never let an audit-write failure mask the 403.
            pass
        raise HTTPException(
            status_code=403,
            detail={
                "error": "InsufficientRole",
                "action": action,
                "roles_allowed": sorted(allowed),
                "user_role": role,
            },
        )
    return role


ROLE_TO_UNITS_FILTER: dict[str, dict] = {
    "maintenance_chief": {"units": {"CLB-6"}, "parents": set()},
    "g4":                {"units": set(), "parents": {"2d MLG"}},
    "mef_commander":     {"units": set(), "parents": set()},   # no filter
    # data_custodian — no PULSE/BASTION unit filter is applied here because
    # the role's primary surface is SENTRY (the upload + classify + release
    # pipeline), where data scoping is governed by classification + release-
    # authority gates, not unit allowlists. The view-scope gate
    # `SENTRY_VIEW_ROLES` keeps this role out of PULSE/BASTION entirely, so
    # the no-filter row never resolves on those endpoints in practice.
    "data_custodian":    {"units": set(), "parents": set()},
    # security_manager — needs cross-MEF visibility to inspect the audit
    # chain and chase spillage events that may originate from any unit, so
    # there is no unit allowlist. Read access on PULSE is denied by
    # `PULSE_VIEW_ROLES`; read access on BASTION (where SOC oversight
    # legitimately requires a fleet-wide view) is allowed and unfiltered
    # by design.
    "security_manager":  {"units": set(), "parents": set()},
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


# ---------------------------------------------------------------------------
# Installation footprint scoping (buildings, ECPs, rally points).
#
# Background: the BASTION COP used to return the full installation map
# (every building, every ECP, every rally point — including ammo, ARMS,
# fuel, hazmat) to every role, including a battalion-level Maintenance
# Chief whose unit scope is a single CLB. That payload is a complete
# OSINT installation product handed to the role most likely to be phished.
#
# Truth source for which roles see the full map. Everyone else gets a
# scoped, sensitive-infra-stripped view derived from `allowed_units(...)`
# and the per-record `sector` / `occupant_unit` tags in
# `dataset/data/installation_data.json`.
# ---------------------------------------------------------------------------

INSTALLATION_FULL_VIEW_ROLES = frozenset({"security_manager", "mef_commander"})

# Roles for which the installation map is not part of their workflow at
# all. Returning an empty footprint to them is safer than leaking the
# full perimeter just because their unit-scope happens to be unrestricted.
INSTALLATION_NO_VIEW_ROLES = frozenset({"data_custodian"})

# Building types that are sensitive OSINT regardless of who occupies the
# building. Stripped from any non-INSTALLATION_FULL_VIEW_ROLES payload —
# even an occupant has no operational need for the rest of the base's
# ammo / ARMS / fuel / hazmat / comms-node / TOC inventory in their COP.
SENSITIVE_BUILDING_TYPES = frozenset({
    "ammunition",
    "arms_storage",
    "fuel",
    "hazmat",
    "communications",
    "tactical",
})


def allowed_sectors(
    ds: CanonicalDataset,
    role: Optional[str],
    buildings: Iterable[dict],
) -> Optional[set[str]]:
    """Sectors of the installation visible to this role.

    Returns:
        - `None` when the role gets the full installation view (no filter).
        - `set()` when the role explicitly gets no installation footprint.
        - A populated set otherwise — derived from the `sector` field on
          each allowed unit's `home_building`.
    """
    if role in INSTALLATION_FULL_VIEW_ROLES:
        return None
    # Unknown / absent role: preserve the legacy "no filter" behaviour for
    # internal call sites (CLI tools, tests). Production traffic always
    # passes a role through the session middleware.
    if not role:
        return None
    if role in INSTALLATION_NO_VIEW_ROLES:
        return set()
    allowed = allowed_units(ds, role)
    if allowed is None:
        # A role with no configured unit filter but also not in the
        # full-view set — collapse to empty footprint rather than leak.
        return set()
    bldgs_by_id = {b["id"]: b for b in buildings}
    sectors: set[str] = set()
    for u in ds.units:
        if u.name not in allowed:
            continue
        home_id = getattr(u, "home_building", None)
        if not home_id:
            continue
        b = bldgs_by_id.get(home_id)
        if b and b.get("sector"):
            sectors.add(b["sector"])
    return sectors


def _coarsen_grid(grid: Optional[str]) -> Optional[str]:
    """Reduce a 5-digit MGRS grid to its 1km cell centroid.

    "18S UJ 28580 71040" -> "18S UJ 28500 71000". Returns the input
    unchanged if it doesn't parse as 5-digit easting/northing — coarsening
    is a defence-in-depth measure, not the truth source for OSINT
    protection (the strip / drop rules in `filter_buildings` are)."""
    if not grid:
        return grid
    parts = grid.split()
    if len(parts) != 4:
        return grid
    zone, square, e, n = parts
    if not (e.isdigit() and n.isdigit() and len(e) == len(n) >= 3):
        return grid
    drop = min(2, len(e) - 1)
    e_coarse = e[: len(e) - drop] + ("0" * drop)
    n_coarse = n[: len(n) - drop] + ("0" * drop)
    return f"{zone} {square} {e_coarse} {n_coarse}"


def _coarsen_critical_building(b: dict) -> dict:
    """Return a 1km-MGRS-centroid view of a critical / hazmat building.

    Stripped: precise lat/lon, occupancy figures, utility wiring detail,
    floor counts, free-text notes, the `nearest_rally_point` tag (an
    operator inside the building doesn't need to be told their own RP,
    and that tag is OSINT for adversary planning).
    Kept: id, name, type, sector, occupant_unit, coarsened grid +
    coarsened lat/lon (~1km precision), and a `coarsened: True` flag so
    the operator knows the COP is a reduced-resolution view of their own
    footprint.
    """
    out: dict = {
        "id": b.get("id"),
        "name": b.get("name"),
        "type": b.get("type"),
        "sector": b.get("sector"),
        "occupant_unit": b.get("occupant_unit"),
        "grid": _coarsen_grid(b.get("grid")),
        "coarsened": True,
    }
    # 2-decimal lat/lon ≈ 1.1km precision at this latitude — matches the
    # 1km-MGRS coarsening above so map and grid agree.
    if b.get("lat") is not None:
        out["lat"] = round(float(b["lat"]), 2)
    if b.get("lon") is not None:
        out["lon"] = round(float(b["lon"]), 2)
    return out


def filter_buildings(
    buildings: Iterable[dict],
    ds: CanonicalDataset,
    role: Optional[str],
) -> list[dict]:
    """Return the buildings visible to this role.

    Rules (in order of precedence):
      1. `INSTALLATION_FULL_VIEW_ROLES` — full list, no strip, no coarsen.
      2. `INSTALLATION_NO_VIEW_ROLES` — empty list.
      3. No role passed (CLI / test) — preserve legacy unrestricted view.
      4. Otherwise, per building:
         a. Drop if `type in SENSITIVE_BUILDING_TYPES` (ammo / ARMS / fuel
            / hazmat / comms-node / TOC are OSINT regardless of who
            occupies them).
         b. If `hazmat_present` or `critical_infrastructure`:
              - if `occupant_unit ∈ allowed_units`, COARSEN the record
                to a 1km-MGRS centroid + minimal attributes (no precise
                lat/lon, no occupancy, no utility wiring, no notes) so
                the operator knows their CI footprint exists without
                handing a full OSINT product to a phished CAC.
              - otherwise, drop.
         c. Else if `occupant_unit ∈ allowed_units`, keep at full
            fidelity (the operator's own non-CI building).
         d. Else if the building has no occupant tag and its `sector` is
            in `allowed_sectors(role)`, keep at full fidelity (shared
            base infra in the operator's neighbourhood — barracks,
            DFAC, MWR).
         e. Drop everything else.
    """
    bldgs = list(buildings)
    if role in INSTALLATION_FULL_VIEW_ROLES:
        return bldgs
    if not role:
        return bldgs
    if role in INSTALLATION_NO_VIEW_ROLES:
        return []
    allowed_u = allowed_units(ds, role) or set()
    sectors = allowed_sectors(ds, role, bldgs) or set()
    out: list[dict] = []
    for b in bldgs:
        if b.get("type") in SENSITIVE_BUILDING_TYPES:
            continue
        occupant = b.get("occupant_unit")
        is_critical = bool(b.get("hazmat_present") or b.get("critical_infrastructure"))
        if is_critical:
            if occupant and occupant in allowed_u:
                out.append(_coarsen_critical_building(b))
            # Otherwise drop — non-occupant CI is never visible to a
            # lower-scoped role, even within their sector.
            continue
        if occupant and occupant in allowed_u:
            out.append(b)
            continue
        if not occupant and b.get("sector") in sectors:
            out.append(b)
    return out


def filter_perimeter(
    items: Iterable[dict],
    sectors: Optional[set[str]],
) -> list[dict]:
    """Filter ECPs / rally-points / similar perimeter records by sector.

    `sectors=None` (full-view role) returns the input unchanged. An empty
    set returns an empty list — the caller asked for a scoped view and we
    found no association, which is the safe default."""
    items = list(items)
    if sectors is None:
        return items
    return [i for i in items if i.get("sector") in sectors]
