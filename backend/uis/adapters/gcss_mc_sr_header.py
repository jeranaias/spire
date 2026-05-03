"""GCSS-MC SR header export adapter spec.

The 12-column SR-header export. Dry-run only via the new pipeline
— the full bundle write path stays at /api/system/stage-ingest
because writing SRs without the parts + due-in joins leaves the
canonical lifecycle.ServiceRequest half-populated.
"""
from __future__ import annotations

from .registry import register_adapter
from .spec import AdapterSpec, ColumnSpec, RowConstraint


ADAPTER = register_adapter(AdapterSpec(
    id="gcss-mc/sr-header",
    name="GCSS-MC SR Header Export",
    target_entity="ServiceRequest",
    version="1.0",
    canonical_columns=[
        ColumnSpec(
            "service_request_type",
            description='Typically "Maintenance - CM" — pipeline filters non-CM rows',
        ),
        ColumnSpec(
            "sr_number",
            required=True,
            sensitive=True,
            hash_prefix="SR_NUMBER",
        ),
        ColumnSpec("defect_code_primary"),
        ColumnSpec("defect_code_secondary"),
        ColumnSpec("problem_summary"),
        ColumnSpec("open_date", type="date_oracle"),
        ColumnSpec("echelon_of_maint"),
        ColumnSpec(
            "serial_number",
            sensitive=True,
            hash_prefix="SERIAL_NUMBER",
        ),
        ColumnSpec(
            "tamcn",
            sensitive=True,
            hash_prefix="TAMCN",
        ),
        ColumnSpec("deadlined_date", type="date_oracle"),
        ColumnSpec("priority"),
        ColumnSpec(
            "unit_uic",
            sensitive=True,
            hash_prefix="OWNER_UIC",
        ),
        ColumnSpec("job_status_date", type="date_oracle"),
    ],
    primary_key=["sr_number"],
    fallback_key=["serial_number"],
    constraints=[
        RowConstraint(
            kind="at_least_one_of",
            fields=["sr_number", "serial_number"],
            message="SR must carry sr_number or serial_number",
        ),
    ],
    description=(
        "USMC SR header export — service request records with defect "
        "codes, deadlined dates, priority. Pipeline analyzer only at "
        "this surface; full bundle write (header + sr_parts + due_in) "
        "lives at /api/system/stage-ingest."
    ),
))
