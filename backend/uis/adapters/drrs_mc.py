"""DRRS-MC unit C-rating + MET score export adapter.

Defense Readiness Reporting System — Marine Corps. Per-Service A&S
directive, every unit publishes a weekly C-rating (C1-C5) plus a
per-mission-essential-task (MET) score 0-100. SPIRE consumes this
to color the BASTION COP unit-readiness drawer and the Decision
Bridge mission tile.

Schema parity (5 columns, the typical DRRS-MC export shape):

    UNIT_UIC          owning UIC; sanitized hashed form
    AS_OF_DATE        YYYY-MM-DD or DD-MON-YY
    C_RATING          "C1" / "C2" / "C3" / "C4" / "C5"
    MET_SCORES_JSON   serialized {task: score} mapping (or "" if none)
    OPERATOR_ASSESSMENT  free-text commander rationale

This is the second IDM entity to gain an adapter (after Asset),
proving the framework extends cleanly. The pipeline's per-cell
transforms, mapping, validation, and audit-chain integration all
work against CRating rows the same way they work against Asset
rows — no entity-specific code paths.
"""
from __future__ import annotations

from .registry import register_adapter
from .spec import AdapterSpec, ColumnSpec


_C_RATING_ALIASES = {
    "C1": "C1", "c1": "C1", "C 1": "C1", "Cat 1": "C1",
    "C2": "C2", "c2": "C2", "C 2": "C2", "Cat 2": "C2",
    "C3": "C3", "c3": "C3", "C 3": "C3", "Cat 3": "C3",
    "C4": "C4", "c4": "C4", "C 4": "C4", "Cat 4": "C4",
    "C5": "C5", "c5": "C5", "C 5": "C5", "Cat 5": "C5",
}


ADAPTER = register_adapter(AdapterSpec(
    id="drrs-mc/c-rating",
    name="DRRS-MC unit C-rating + MET scores",
    target_entity="CRating",
    version="1.0",
    canonical_columns=[
        ColumnSpec(
            "unit_uic",
            required=True,
            sensitive=True,
            hash_prefix="OWNER_UIC",
            source_aliases=["UNIT_UIC", "UIC", "OWNER_UIC", "REPORTING_UIC"],
        ),
        ColumnSpec(
            "as_of_date",
            type="date",
            required=True,
            source_aliases=["AS_OF_DATE", "DATE", "REPORT_DATE", "EFFECTIVE_DATE"],
        ),
        ColumnSpec(
            "c_rating",
            type="enum",
            enum_aliases=_C_RATING_ALIASES,
            source_aliases=["C_RATING", "RATING", "CAT", "CATEGORY"],
            description="Unit C-rating: C1 (full mission-capable) → C5 (not capable)",
        ),
        # met_scores ships as a serialized JSON column on the export.
        # The pipeline keeps it as a string here; downstream
        # consumers parse it. Future: add a "json" canonical type.
        ColumnSpec(
            "met_scores",
            source_aliases=["MET_SCORES", "METS", "MET_SCORES_JSON", "TASK_SCORES"],
            description="Per-MET score map serialized as JSON string",
        ),
        ColumnSpec(
            "operator_assessment",
            source_aliases=["OPERATOR_ASSESSMENT", "ASSESSMENT", "COMMANDER_REMARKS", "REMARKS"],
            description="Free-text commander rationale for the rating",
        ),
    ],
    primary_key=["unit_uic", "as_of_date"],
    description=(
        "DRRS-MC weekly C-rating export. One row per (unit, date). "
        "Replaces the synthetic c-rating field on Decision Bridge "
        "mission tile and BASTION COP unit-readiness drawer once "
        "applied. Apply path is dry-run only at this surface — "
        "writing CRating rows requires a separate canonical-table "
        "store that doesn't exist yet."
    ),
))
