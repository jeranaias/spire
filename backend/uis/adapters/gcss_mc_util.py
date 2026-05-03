"""GCSS-MC Utilization Extract adapter spec.

The 6-column per-asset reading export. Replaces
backend/integrations/pulse_gcss_util_adapter — the pipeline walks
this spec.
"""
from __future__ import annotations

from .registry import register_adapter
from .spec import AdapterSpec, ColumnSpec


# Canonical readiness-code alias map. Real exports send mc/MC/m.c./
# Mission Capable etc.; the pipeline collapses them via map_enum().
_READINESS_ALIASES = {
    "MC": "MC",
    "mc": "MC",
    "M.C.": "MC",
    "Mission Capable": "MC",
    "PMC": "PMC",
    "pmc": "PMC",
    "Partial Mission Capable": "PMC",
    "NMCM": "NMCM",
    "nmcm": "NMCM",
    "Not Mission Capable - Maintenance": "NMCM",
    "NMCS": "NMCS",
    "nmcs": "NMCS",
    "Not Mission Capable - Supply": "NMCS",
}

# Reading source aliases — the four canonical channels.
_SOURCE_ALIASES = {
    "manual": "manual",
    "Manual": "manual",
    "telematics": "telematics",
    "Telematics": "telematics",
    "telem": "telematics",
    "pmcs": "pmcs",
    "PMCS": "pmcs",
    "inspection": "inspection",
    "Inspection": "inspection",
    "insp": "inspection",
}


ADAPTER = register_adapter(AdapterSpec(
    id="gcss-mc/util",
    name="GCSS-MC Utilization Extract",
    target_entity="Asset",   # writes to current_hours / current_miles / current_status
    version="1.0",
    canonical_columns=[
        ColumnSpec(
            "asset_id",
            required=True,
            source_aliases=["ASSET_ID", "ASSETID", "ASSET", "ID"],
            description="Stable asset identifier matching the ECP roster",
        ),
        ColumnSpec(
            "reading_date",
            type="date_oracle",
            source_aliases=["READING_DATE", "DATE", "AS_OF_DATE"],
        ),
        ColumnSpec(
            "current_hours",
            type="float",
            default=0.0,
            source_aliases=["TOTAL_HOURS", "HOURS", "ENGINE_HOURS"],
        ),
        ColumnSpec(
            "current_miles",
            type="int",
            default=0,
            source_aliases=["TOTAL_MILES", "MILES", "ODOMETER"],
        ),
        ColumnSpec(
            "current_status",
            type="enum",
            enum_aliases=_READINESS_ALIASES,
            source_aliases=["READINESS_CODE", "READINESS", "STATUS", "MC_STATUS"],
            description="MC | PMC | NMCM | NMCS",
        ),
        ColumnSpec(
            "reading_source",
            type="enum",
            enum_aliases=_SOURCE_ALIASES,
            source_aliases=["READING_SOURCE", "SOURCE"],
            description="manual | telematics | pmcs | inspection",
        ),
    ],
    primary_key=["asset_id"],
    description=(
        "Per-asset readings — engine hours, odometer miles, readiness "
        "code. Latest reading per asset wins on apply. Behavioral data "
        "the PULSE risk-board model needs to score real assets instead "
        "of synthetic trajectories."
    ),
))
