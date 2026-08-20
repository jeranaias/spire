"""Field-observation router — the handheld ingest lane.

A Marine standing at a supply point with a phone is a sensor. This router is
where that sensor's reports land. It is deliberately *not* an adapter on the
UIS pipeline: UIS is a pull-mode, tabular, file-shaped ingest for
authoritative logistics exports (GCSS-MC, DRRS-MC), gated to
`data_custodian` / `security_manager`. A field observation is the opposite on
all three axes — it is pushed, it is a single geospatial event, and it comes
from exactly the operator roles UIS denies.

The important consequence: opening ingest to operator roles must NOT mean
loosening `INGEST_ROLES`. That gate protects writes into the record of truth.
Instead this lane keeps its own policy and its own table, and observations are
an **advisory overlay** on the COP:

    * Nothing here mutates `CanonicalDataset`. An unverified phone report
      cannot contaminate the GCSS-derived, hash-chained dataset.
    * Promotion to authoritative is a separate, custodian-class action
      (`POST /observations/{id}/promote`) which reuses the existing ingest
      pay grade rather than weakening it.

Authorization, in the order the endpoints apply it:

    submit  — any authenticated ops role may file, but
              (a) the marking may not exceed the submitter's clearance, and
              (b) the submitter may only file against a unit *they themselves
                  can see*. Without (b) a battalion maintenance chief could
                  plant an observation on another battalion's COP.
    read    — `allowed_units(...)` for unit scope (the same predicate BASTION
              uses) intersected with a clearance ceiling, so a G-4 sees 2d MLG
              observations and a MEF commander sees the MAGTF.
    resolve — `FIELD_OBS_RESOLVE_ROLES`, mirroring `INGEST_ROLES`.

Geometry is Cursor-on-Target shaped (`cot_type`, point lat/lon/hae/ce/le,
observed/stale times) so an ATAK bridge is a serializer over the stored row
rather than a schema migration. No CoT emission ships in this change.

Gated on `SPIRE_FIELD_OBS_ENABLED=1`, matching the `SPIRE_INGEST_ENABLED`
convention: the router always mounts so the surface is visible to operators
and integration tests, but every endpoint returns 503 until a pilot turns it
on explicitly.
"""
from __future__ import annotations

import os
import uuid
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from ..auth import session_role
from ..persistence import (
    AuditWriteFailure,
    get_field_observation,
    insert_field_observation,
    list_field_observations,
    log_or_flag as audit_log,
    resolve_field_observation,
)
from ..scoping import (
    ALL_OPS_ROLES,
    CLEARANCE_RANK,
    allowed_units,
    classification_rank,
    clearance_rank,
    require_clearance,
    require_user_role,
)
from ..state import get_dataset
from ..timeutil import utcnow

router = APIRouter()


# Resolution authority. Mirrors `INGEST_ROLES` in routes/channels.py — the
# decision to turn an advisory report into authoritative data is the same
# pay grade as bringing a GCSS export in, and for the same reason.
FIELD_OBS_RESOLVE_ROLES = frozenset({"data_custodian", "security_manager"})

# Observation taxonomy. Kept small and closed: a free-text `category` would
# defeat the point of a COP overlay, and an operator on a phone in the rain
# is not going to pick from thirty options.
CATEGORIES = frozenset({
    "supply_point",
    "route_status",
    "uas_sighting",
    "infra_damage",
    "casualty_evac",
    "other",
})

# Default CoT event type per category. `a-u-G` is "atom, unknown affiliation,
# ground" — the honest default for an unverified human report. Hostile/friendly
# affiliation is a judgement the overlay does not let a submitter assert.
_DEFAULT_COT_TYPE = {
    "supply_point":  "a-f-G-I-B",   # friendly ground installation, supply
    "route_status":  "b-m-r",       # route
    "uas_sighting":  "a-u-A",       # unknown air
    "infra_damage":  "a-u-G",
    "casualty_evac": "b-r-f-h-c",   # CASEVAC request
    "other":         "a-u-G",
}

# How long an observation stays "fresh" on the COP before ATAK-style staling.
# Two hours matches the tempo of the logistics picture SPIRE is modelling;
# a UAS sighting ages out faster than a supply point but the overlay does not
# yet model per-category decay.
_DEFAULT_STALE_AFTER = timedelta(hours=2)

_MAX_LIMIT = 500


def _enabled() -> bool:
    return os.environ.get("SPIRE_FIELD_OBS_ENABLED", "0") == "1"


def _require_enabled() -> None:
    if not _enabled():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "FieldObservationsDisabled",
                "hint": "set SPIRE_FIELD_OBS_ENABLED=1 and restart the backend",
            },
        )


def _iso(dt) -> str:
    return dt.isoformat(timespec="seconds").replace("+00:00", "") + "Z"


def _readable_classifications(user: dict) -> list[str]:
    """Markings at or below the reader's clearance.

    Returned as an explicit allowlist rather than a rank comparison so the
    storage layer can filter in SQL without importing the scoping lattice.
    """
    ceiling = clearance_rank(user.get("clearance"))
    return [name for name, rank in CLEARANCE_RANK.items() if rank <= ceiling]


class ObservationIn(BaseModel):
    """Submission payload.

    Note what is *absent*: no submitter identity and no status. Both are
    stamped server-side from the session. A client that supplies them is
    ignored rather than trusted — provenance on an advisory overlay is the
    only thing making it worth anything.
    """

    category: str
    summary: str = Field(min_length=1, max_length=280)
    detail: str = Field(default="", max_length=4000)
    unit_name: str
    lat: float = Field(ge=-90.0, le=90.0)
    lon: float = Field(ge=-180.0, le=180.0)
    hae: Optional[float] = None
    ce: Optional[float] = Field(default=None, ge=0.0)
    le: Optional[float] = Field(default=None, ge=0.0)
    classification: str = "UNCLASSIFIED"
    cot_type: Optional[str] = None
    observed_at: Optional[str] = None
    source: str = Field(default="handheld", max_length=32)


@router.get("/status")
async def field_obs_status(request: Request):
    """Feature-flag + policy probe.

    Mirrors `/api/ingest/status`: lets the mobile client discover whether the
    lane is live, and which units/markings it may file against, without
    hard-coding policy into the handheld.
    """
    user = getattr(request.state, "user", None) or {}
    role = session_role(request) or user.get("role")
    ds = get_dataset()
    allowed = allowed_units(ds, role)
    return {
        "enabled": _enabled(),
        "role": role,
        "clearance": user.get("clearance"),
        "categories": sorted(CATEGORIES),
        # None => unrestricted. Serialized as null so the client renders a
        # free unit picker for commander-class roles and a fixed list for
        # scoped ones.
        "writable_units": None if allowed is None else sorted(allowed),
        "max_classification": user.get("clearance") or "UNCLASSIFIED",
        "can_resolve": bool(role and role in FIELD_OBS_RESOLVE_ROLES),
        "stale_after_seconds": int(_DEFAULT_STALE_AFTER.total_seconds()),
    }


@router.post("/observations", status_code=201)
async def submit_observation(payload: ObservationIn, request: Request):
    """File one advisory observation.

    Every operator role may submit; the two gates are the marking ceiling and
    the unit-write scope. See the module docstring for why (b) matters.
    """
    _require_enabled()
    user = getattr(request.state, "user", None) or {}
    role = require_user_role(user, ALL_OPS_ROLES, action="field_obs.submit")

    if payload.category not in CATEGORIES:
        raise HTTPException(
            status_code=400,
            detail={"error": "UnknownCategory", "categories": sorted(CATEGORIES)},
        )

    # Marking ceiling. `require_clearance` raises 403 + writes a
    # `spillage_prevented` audit row, and returns the normalized string we
    # persist — so "cui", "FOUO" and "CUI" all land as one value.
    classification = require_clearance(
        user,
        payload.classification,
        action="field_obs.submit",
        audit_subject=payload.unit_name,
    )

    # Unit-write scope. An observation is addressed *to* a unit's COP, so
    # filing against a unit the submitter cannot see is a write into someone
    # else's picture. Unrestricted roles (allowed is None) may file anywhere.
    ds = get_dataset()
    known_units = {u.name for u in ds.units}
    if payload.unit_name not in known_units:
        raise HTTPException(
            status_code=400,
            detail={"error": "UnknownUnit", "unit_name": payload.unit_name},
        )

    allowed = allowed_units(ds, role)
    if allowed is not None and payload.unit_name not in allowed:
        try:
            audit_log(
                "field_obs_scope_blocked",
                actor=role,
                subject_id=payload.unit_name,
                payload={
                    "action": "field_obs.submit",
                    "user_dodid": user.get("dodid"),
                    "user_role": role,
                    "target_unit": payload.unit_name,
                    "allowed_units": sorted(allowed),
                    "decision": "blocked",
                    "surface": "backend",
                },
            )
        except AuditWriteFailure:
            raise
        except Exception:  # noqa: BLE001 — never mask the 403
            pass
        raise HTTPException(
            status_code=403,
            detail={
                "error": "UnitOutOfScope",
                "action": "field_obs.submit",
                "unit_name": payload.unit_name,
            },
        )

    now = utcnow()
    observed_at = payload.observed_at or _iso(now)
    obs = {
        "obs_id": f"obs-{uuid.uuid4().hex[:12]}",
        "cot_type": payload.cot_type or _DEFAULT_COT_TYPE[payload.category],
        "category": payload.category,
        "summary": payload.summary.strip(),
        "detail": payload.detail.strip(),
        "lat": payload.lat,
        "lon": payload.lon,
        "hae": payload.hae,
        "ce": payload.ce,
        "le": payload.le,
        "observed_at": observed_at,
        "stale_at": _iso(now + _DEFAULT_STALE_AFTER),
        "classification": classification,
        "unit_name": payload.unit_name,
        "submitter_dodid": user.get("dodid", ""),
        "submitter_name": user.get("name", ""),
        "submitter_role": role,
        "submitter_unit": user.get("unit", ""),
        "source": payload.source,
        "status": "advisory",
        "created_at": _iso(now),
    }
    insert_field_observation(obs)

    try:
        audit_log(
            "field_obs_submit",
            actor=role,
            subject_id=obs["obs_id"],
            payload={
                "unit_name": obs["unit_name"],
                "category": obs["category"],
                "classification": obs["classification"],
                "user_dodid": user.get("dodid"),
                "source": obs["source"],
                # Coordinates stay out of the audit payload — the audit chain
                # is read by roles whose unit scope may not cover this unit.
                "decision": "accepted",
                "surface": "backend",
            },
        )
    except AuditWriteFailure:
        raise
    except Exception:  # noqa: BLE001
        pass

    return obs


@router.get("/observations")
async def list_observations(
    request: Request,
    status: Optional[str] = None,
    limit: int = 200,
):
    """Return observations visible to the caller.

    Scoping is the same `allowed_units` predicate BASTION uses, intersected
    with a clearance ceiling. This is the whole point of the lane: one
    submission surface, and what each reader sees is a function of their role
    and their cert — not of what the handheld chose to send.
    """
    _require_enabled()
    user = getattr(request.state, "user", None) or {}
    role = require_user_role(user, ALL_OPS_ROLES, action="field_obs.list")

    if status is not None and status not in ("advisory", "promoted", "rejected"):
        raise HTTPException(
            status_code=400,
            detail={"error": "UnknownStatus", "status": status},
        )

    ds = get_dataset()
    allowed = allowed_units(ds, role)
    rows = list_field_observations(
        units=allowed,
        classifications=_readable_classifications(user),
        status=status,
        limit=max(1, min(limit, _MAX_LIMIT)),
    )
    return {
        "observations": rows,
        "count": len(rows),
        "scope": "all" if allowed is None else sorted(allowed),
    }


@router.post("/observations/{obs_id}/{action}")
async def resolve_observation(obs_id: str, action: str, request: Request):
    """Promote an advisory observation to authoritative, or reject it.

    Custodian-class only. Promotion currently records the decision and stamps
    the row; wiring a promoted observation into the canonical dataset is
    deliberately left to the follow-on change so the advisory boundary lands
    and is tested on its own.
    """
    _require_enabled()
    if action not in ("promote", "reject"):
        raise HTTPException(status_code=400, detail=f"unknown action: {action}")

    user = getattr(request.state, "user", None) or {}
    role = require_user_role(
        user, FIELD_OBS_RESOLVE_ROLES, action=f"field_obs.{action}",
        audit_subject=obs_id,
    )

    existing = get_field_observation(obs_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"unknown observation id: {obs_id}")

    # A resolver may hold cross-unit scope but not the marking. Re-check
    # rather than assume the role gate covered it.
    if classification_rank(existing["classification"]) > clearance_rank(user.get("clearance")):
        raise HTTPException(
            status_code=403,
            detail={
                "error": "InsufficientClearance",
                "action": f"field_obs.{action}",
            },
        )

    if existing["status"] != "advisory":
        raise HTTPException(
            status_code=409,
            detail={
                "error": "AlreadyResolved",
                "obs_id": obs_id,
                "status": existing["status"],
            },
        )

    new_status = "promoted" if action == "promote" else "rejected"
    row = resolve_field_observation(obs_id, status=new_status, actor=role)

    try:
        audit_log(
            f"field_obs_{new_status}",
            actor=role,
            subject_id=obs_id,
            payload={
                "unit_name": existing["unit_name"],
                "category": existing["category"],
                "classification": existing["classification"],
                "user_dodid": user.get("dodid"),
                "submitter_dodid": existing["submitter_dodid"],
                "decision": new_status,
                "surface": "backend",
            },
        )
    except AuditWriteFailure:
        raise
    except Exception:  # noqa: BLE001
        pass

    return row
