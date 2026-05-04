"""AssetUtilWriter — GCSS-MC utilization extract apply.

Updates current_hours / current_miles / current_status on assets
already in the canonical roster. Unlike ECP this isn't a roster
mutation — no new assets, no stale flagging — so the writer's
diff stage is a counts-only preview rather than a per-row diff
engine.

The shape still fits the EntityWriter protocol; preview returns
counts + the post-merge asset list cached in ``native``, and
apply commits that cached list. The state_token fingerprints the
columns this writer touches (asset_id + current_hours/miles/
status) so a parallel apply can't silently overwrite a fresher
reading.
"""
from __future__ import annotations

import hashlib
from copy import copy
from dataclasses import dataclass
from typing import Any, List

from .base import EntityWriter, WriterApplyResult, WriterDiff, register_writer


@dataclass
class AssetUtilWriter:
    adapter_id: str = "gcss-mc/util"
    target_entity: str = "Asset"

    def state_token(self, dataset: Any) -> str:
        """Fingerprint over (asset_id, current_hours, current_miles,
        current_status) — exactly the columns UTIL apply touches."""
        h = hashlib.sha256()
        items: List[str] = []
        for a in getattr(dataset, "assets", []) or []:
            aid = getattr(a, "asset_id", "") or ""
            ch = str(getattr(a, "current_hours", 0) or 0)
            cm = str(getattr(a, "current_miles", 0) or 0)
            cs = getattr(a, "current_status", "") or ""
            items.append(f"{aid}|{ch}|{cm}|{cs}")
        items.sort()
        for i in items:
            h.update(i.encode("utf-8"))
            h.update(b"\n")
        return h.hexdigest()[:16]

    def preview(self, pipeline_result: Any, dataset: Any) -> WriterDiff:
        from ...integrations.pulse_gcss_util_adapter import apply_latest_readings
        from ..route_helpers import to_parsed_util_rows

        rows = to_parsed_util_rows(pipeline_result)
        canonical_assets = list(getattr(dataset, "assets", []) or [])
        # Shallow-copy so the dry-run merge doesn't mutate the live
        # singleton (apply_latest_readings writes in place on the
        # asset objects). Apply will redo the merge on the real
        # objects.
        preview_assets = [copy(a) for a in canonical_assets]
        updated, counts = apply_latest_readings(rows, preview_assets)

        # No matched/new/stale lists — UTIL is counts-only. Conflicts
        # never arise (latest-reading rule resolves ties internally).
        return WriterDiff(
            counts=counts,
            payload={"counts": counts},
            native={"rows": rows},
        )

    def apply(self, diff: WriterDiff, dataset: Any) -> WriterApplyResult:
        from ...integrations.pulse_gcss_util_adapter import apply_latest_readings

        canonical_assets = list(getattr(dataset, "assets", []) or [])
        rows = (diff.native or {}).get("rows", [])
        updated_assets, applied_counts = apply_latest_readings(
            rows, canonical_assets,
        )
        new_dataset = _replace_dataset_assets(dataset, updated_assets)
        return WriterApplyResult(
            new_dataset=new_dataset,
            summary_counts=applied_counts,
            audit_rows=[],  # UTIL doesn't fan out per-row audits
        )


def _replace_dataset_assets(ds: Any, new_assets: List[Any]) -> Any:
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


register_writer(AssetUtilWriter())
