"""GCSS-MC Equipment Custodian Report (ECP) adapter spec.

The 8-column roster export. Replaces the bespoke
backend/integrations/pulse_gcss_ecp_adapter parser; the pipeline
walks this spec to derive identical behavior.
"""
from __future__ import annotations

from .registry import register_adapter
from .spec import AdapterSpec, ColumnSpec, RowConstraint


ADAPTER = register_adapter(AdapterSpec(
    id="gcss-mc/ecp",
    name="GCSS-MC Equipment Custodian Report",
    target_entity="Asset",
    version="1.0",
    canonical_columns=[
        ColumnSpec("tamcn", description="TAMCN code"),
        ColumnSpec("nsn", description="National Stock Number"),
        ColumnSpec(
            "serial_number",
            sensitive=True,
            hash_prefix="SERIAL_NUMBER",
            description="Equipment serial; sanitized at ingest",
        ),
        ColumnSpec("nomenclature"),
        ColumnSpec(
            "owner_uic",
            sensitive=True,
            hash_prefix="OWNER_UIC",
            description="Owning unit UIC; sanitized at ingest",
        ),
        ColumnSpec("allowance_qty", type="int", default=0),
        ColumnSpec("on_hand_qty", type="int", default=0),
        ColumnSpec("last_inventory_date", type="date_oracle"),
    ],
    primary_key=["serial_number"],
    fallback_key=["tamcn", "owner_uic"],
    constraints=[
        # Drop rows with neither a TAMCN nor a serial — nothing to
        # merge against the canonical roster.
        RowConstraint(
            kind="at_least_one_of",
            fields=["tamcn", "serial_number"],
            message="row must carry TAMCN or serial",
        ),
    ],
    description=(
        "USMC Equipment Custodian Report — system-of-record for what gear "
        "a unit owns. Lands the asset roster columns; behavioral state "
        "(hours / miles / readiness) comes from the UTIL adapter."
    ),
))
