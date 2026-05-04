"""AssetEcpWriter — reference implementation of the EntityWriter protocol.

Composes (does not duplicate) the existing GCSS-MC ECP merge engine
in ``backend.integrations.pulse_gcss_ecp_merge``. The merge engine is
already proven and tested; this writer is a thin facade that:

  - Converts ``PipelineResult`` → list[ParsedAssetRow]
  - Delegates diff computation to the merge engine
  - Wraps the apply step so route code is one ``writer.apply(diff, ds)``
    call instead of bespoke ``apply_diff`` + ``_replace_assets`` +
    audit fan-out logic
  - Exposes ``state_token`` so the optimistic-concurrency check is
    available from any apply path (HTTP, SFTP, email)

When other Asset-targeting adapters (UTIL, future GCSS-Army-ECP, etc.)
land, each gets its own writer pulling from its own merge engine.
The protocol is the only thing they share.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date
from typing import Any, Dict, List

from .base import EntityWriter, WriterApplyResult, WriterDiff, register_writer


@dataclass
class AssetEcpWriter:
    """Writer for ``gcss-mc/ecp`` — Equipment Custodian Report apply.

    Touches roster fields only (tamcn, nsn, nomenclature, owner_uic,
    allowance_qty, on_hand_qty, last_inventory_date). Behavioral
    fields stay anchored to the simulator / utilization extract.
    """

    adapter_id: str = "gcss-mc/ecp"
    target_entity: str = "Asset"

    def state_token(self, dataset: Any) -> str:
        """Fingerprint over (asset_id, serial_number, on_hand_qty,
        last_inventory_date) — exactly the columns ECP apply touches.

        Mirrors the legacy route's _dataset_state_token so existing
        clients (which captured a token before the refactor) keep
        working without re-uploading."""
        h = hashlib.sha256()
        items: List[str] = []
        for a in getattr(dataset, "assets", []) or []:
            aid = getattr(a, "asset_id", "") or ""
            sn = getattr(a, "serial_number", "") or ""
            oh = str(getattr(a, "on_hand_qty", 0) or 0)
            inv = getattr(a, "last_inventory_date", None)
            inv_s = inv.isoformat() if inv else ""
            items.append(f"{aid}|{sn}|{oh}|{inv_s}")
        items.sort()
        for i in items:
            h.update(i.encode("utf-8"))
            h.update(b"\n")
        return h.hexdigest()[:16]

    def preview(self, pipeline_result: Any, dataset: Any) -> WriterDiff:
        """Compute the ECP merge diff against the canonical asset roster."""
        from ...integrations.pulse_gcss_ecp_merge import (
            compute_diff,
            diff_to_payload,
        )
        from ..route_helpers import to_parsed_asset_rows

        rows = to_parsed_asset_rows(pipeline_result)
        canonical_assets = list(getattr(dataset, "assets", []) or [])
        native_diff = compute_diff(rows, canonical_assets)
        return WriterDiff(
            counts=native_diff.counts(),
            payload=diff_to_payload(native_diff),
            matched=list(native_diff.matched),
            new=list(native_diff.new),
            stale=list(native_diff.stale),
            conflicts=list(native_diff.conflicts),
            unchanged=list(native_diff.unchanged),
            native=native_diff,
        )

    def apply(self, diff: WriterDiff, dataset: Any) -> WriterApplyResult:
        """Apply the diff and return the new dataset + per-row audit payloads.

        Pure: no swap_dataset, no audit_log. The route emits the audit
        rows (it has the actor + preview_token context).
        """
        from ...integrations.pulse_gcss_ecp_merge import apply_diff

        canonical_assets = list(getattr(dataset, "assets", []) or [])
        native_diff = diff.native
        new_assets = apply_diff(
            native_diff,
            canonical_assets,
            asset_factory=_ecp_row_to_asset,
        )

        # RD6c — flag stale assets needs_verification = True; the
        # operator surface (/api/ingest/stale) lists them for review.
        stale_ids = {s.asset_id for s in native_diff.stale}
        if stale_ids:
            for a in new_assets:
                if (
                    getattr(a, "asset_id", "") in stale_ids
                    and hasattr(a, "needs_verification")
                ):
                    a.needs_verification = True

        new_dataset = _replace_dataset_assets(dataset, new_assets)

        audit_rows: List[Dict[str, Any]] = []
        for matched in native_diff.matched[:200]:
            audit_rows.append({
                "kind": "ingest.ecp.apply.row",
                "subject_id": matched.asset_id,
                "payload": {
                    "match_method": matched.match_method,
                    "changes": [
                        {
                            "field": c.field,
                            "before": _serialize_for_audit(c.before),
                            "after": _serialize_for_audit(c.after),
                        }
                        for c in matched.changes
                    ],
                },
            })

        return WriterApplyResult(
            new_dataset=new_dataset,
            summary_counts=native_diff.counts(),
            audit_rows=audit_rows,
        )


def _ecp_row_to_asset(row: Any) -> Any:
    """Build a ``dataset.fleet.Asset`` from one parsed ECP row.

    Roster + ECP-only fields are populated; behavioral state
    (current_hours, current_miles, current_status, etc.) defaults
    so a real-data new asset slots into the simulator without
    crashing it. Lifecycle data fills in via later joins (UTIL
    extracts, SR streams).

    Late-binds the dataset import so the writer remains importable
    in standalone extraction contexts where the consumer supplies
    its own Asset type.
    """
    from dataset.fleet import Asset
    from datetime import date as _date

    asset_id = f"new-{row.tamcn}-{row.serial_number[-8:] or 'unknown'}"
    return Asset(
        asset_id=asset_id,
        equipment_type=row.equipment_type or row.tamcn,
        tamcn=row.tamcn,
        nsn=row.nsn,
        serial_number=row.serial_number,
        nomenclature=row.nomenclature,
        model="",
        fsc=(row.nsn.split("-")[0] if row.nsn else ""),
        unit_uic=row.owner_uic,
        unit_name="",
        unit_parent="",
        location="",
        optempo="medium",
        deployment_status="garrison",
        fielding_date=row.last_inventory_date or _date.today(),
        initial_hours=0.0,
        initial_miles=0,
        classification_risk="LOW",
        allowance_qty=row.allowance_qty,
        on_hand_qty=row.on_hand_qty,
        last_inventory_date=row.last_inventory_date,
    )


def _replace_dataset_assets(ds: Any, new_assets: List[Any]) -> Any:
    """Clone the CanonicalDataset with assets replaced.

    Late-bound import keeps this writer importable in standalone
    extraction contexts where the consumer supplies its own dataset
    type. The shape match is duck-typed — any dataclass with the
    expected fields works.
    """
    from ...state import CanonicalDataset
    return CanonicalDataset(
        units=ds.units,
        assets=new_assets,
        roster=ds.roster,
        srs=ds.srs,
        snapshots=ds.snapshots,
        reqs=ds.reqs,
        cannib_events=ds.cannib_events,
        incidents=ds.incidents,
        tmrs=ds.tmrs,
        dq_defects=ds.dq_defects,
        violations=ds.violations,
        generated_at=ds.generated_at,
        seed=ds.seed,
    )


def _serialize_for_audit(value: Any) -> Any:
    """Coerce values into JSON-serializable forms for the audit
    chain canonicalizer (dates → ISO strings)."""
    if isinstance(value, date):
        return value.isoformat()
    return value


# Auto-register on import so the route layer doesn't have to know
# about specific writer classes — `from .writers import asset_ecp`
# (or the package-level import from __init__.py) is enough.
register_writer(AssetEcpWriter())
