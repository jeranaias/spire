"""Canonical SPIRE Internal Data Model (IDM).

Every adapter produces against the IDM. Every consumer (PULSE,
SENTRY, BASTION, Decision Bridge) reads from it. There is exactly
one canonical shape per entity.
"""
from __future__ import annotations

from .schema import (
    Asset,
    CRating,
    IncidentEvent,
    MaintRecord,
    Personnel,
    Requisition,
    ServiceRequest,
    TMR,
    Unit,
)
from .registry import IDM_ENTITIES, get_entity, precedence_for

__all__ = [
    "Asset",
    "CRating",
    "IDM_ENTITIES",
    "IncidentEvent",
    "MaintRecord",
    "Personnel",
    "Requisition",
    "ServiceRequest",
    "TMR",
    "Unit",
    "get_entity",
    "precedence_for",
]
