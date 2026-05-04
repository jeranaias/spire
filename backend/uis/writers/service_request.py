"""ServiceRequestWriter — GCSS-MC SR-header apply.

First non-Asset entity on the EntityWriter protocol. SR-header
applies are merge-by-sr_number:

  - matched   — sr_number already in canonical, header fields differ
                from current; record per-field changes and update
  - unchanged — sr_number in canonical, header fields all match
  - new       — sr_number not in canonical; append as header-only
                SR (data_quality_flag="header_only" so downstream
                consumers know parts + due-in are still TBD)
  - no stale  — SR-header batches are incremental; absent SRs aren't
                an apply-time signal (some live in older batches).

The full-bundle write path (header + parts + due-in joins) stays
at /api/system/stage-ingest. This writer is for the streaming
case: operator drips header batches in via the universal-ingest
surface; SRs land partial-populated and the parts join fills in
later.

Per-row audit entries cap at 200 like ECP — keeps the chain
inspectable on a 5,000-row drop.
"""
from __future__ import annotations

import hashlib
from copy import copy
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Tuple

from .base import EntityWriter, WriterApplyResult, WriterDiff, register_writer


# Canonical SR fields the SR-header export populates. Only these
# fields participate in the diff / merge — parts cost, requisitions,
# mechanic, etc. are owned by other ingest surfaces.
SR_HEADER_FIELDS = (
    "service_request_type",
    "defect_code_primary",
    "defect_code_secondary",
    "open_date",
    "echelon_numeric",
    "serial_number",
    "tamcn",
    "deadlined_date",
    "priority",
    "unit_uic",
)


@dataclass
class SRChange:
    field: str
    before: Any
    after: Any


@dataclass
class SRMatched:
    sr_number: str
    changes: List[SRChange] = field(default_factory=list)
    parsed_row: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SRNew:
    sr_number: str
    parsed_row: Dict[str, Any] = field(default_factory=dict)


@dataclass
class SRUnchanged:
    sr_number: str


@dataclass
class SRDiff:
    """Native diff for SR-header merges."""

    matched: List[SRMatched] = field(default_factory=list)
    new: List[SRNew] = field(default_factory=list)
    unchanged: List[SRUnchanged] = field(default_factory=list)
    conflicts: List[Any] = field(default_factory=list)  # always empty — sr_number is unique
    stale: List[Any] = field(default_factory=list)      # always empty — incremental batches

    def counts(self) -> Dict[str, int]:
        return {
            "matched_changed": len(self.matched),
            "new": len(self.new),
            "unchanged": len(self.unchanged),
            "stale": 0,
            "conflicts": 0,
        }


@dataclass
class ServiceRequestWriter:
    adapter_id: str = "gcss-mc/sr-header"
    target_entity: str = "ServiceRequest"

    def state_token(self, dataset: Any) -> str:
        """Fingerprint over (sr_number, job_status, deadlined_date) —
        enough to detect concurrent applies that touched the same SRs."""
        h = hashlib.sha256()
        items: List[str] = []
        for sr in getattr(dataset, "srs", []) or []:
            sn = getattr(sr, "sr_number", "") or ""
            js = getattr(sr, "job_status", "") or ""
            dl = getattr(sr, "deadlined_date", None)
            dl_s = dl.isoformat() if dl else ""
            items.append(f"{sn}|{js}|{dl_s}")
        items.sort()
        for i in items:
            h.update(i.encode("utf-8"))
            h.update(b"\n")
        return h.hexdigest()[:16]

    def preview(self, pipeline_result: Any, dataset: Any) -> WriterDiff:
        canonical_srs = list(getattr(dataset, "srs", []) or [])
        sr_by_number = {
            getattr(sr, "sr_number", ""): sr for sr in canonical_srs
        }

        diff = SRDiff()
        for row in pipeline_result.rows:
            sr_number = (row.get("sr_number") or "").strip()
            if not sr_number:
                continue
            existing = sr_by_number.get(sr_number)
            if existing is None:
                diff.new.append(SRNew(sr_number=sr_number, parsed_row=dict(row)))
                continue
            changes = _compute_field_changes(existing, row)
            if changes:
                diff.matched.append(SRMatched(
                    sr_number=sr_number, changes=changes, parsed_row=dict(row),
                ))
            else:
                diff.unchanged.append(SRUnchanged(sr_number=sr_number))

        return WriterDiff(
            counts=diff.counts(),
            payload=_diff_to_payload(diff),
            matched=list(diff.matched),
            new=list(diff.new),
            stale=list(diff.stale),
            conflicts=list(diff.conflicts),
            unchanged=list(diff.unchanged),
            native=diff,
        )

    def apply(self, diff: WriterDiff, dataset: Any) -> WriterApplyResult:
        from dataset.lifecycle import ServiceRequest as _SR

        canonical_srs = list(getattr(dataset, "srs", []) or [])
        sr_by_number = {
            getattr(sr, "sr_number", ""): sr for sr in canonical_srs
        }
        native: SRDiff = diff.native

        # Update matched SRs in place (on copies, to keep apply pure).
        new_srs: List[Any] = []
        updated_numbers = {m.sr_number for m in native.matched}
        matched_payloads: Dict[str, SRMatched] = {
            m.sr_number: m for m in native.matched
        }

        for sr in canonical_srs:
            sn = getattr(sr, "sr_number", "")
            if sn in updated_numbers:
                # Copy then apply changes — protects the live singleton
                clone = copy(sr)
                _apply_changes(clone, matched_payloads[sn].changes)
                new_srs.append(clone)
            else:
                new_srs.append(sr)

        # Append new SRs as header-only records. Required fields
        # (asset_id, equipment_type, etc.) are best-effort populated
        # from the parsed row; parts/due-in joins fill in later.
        for n in native.new:
            row = n.parsed_row
            new_sr = _SR(
                sr_number=n.sr_number,
                asset_id="",  # filled by later join when serial → asset resolves
                unit_uic=row.get("unit_uic", ""),
                unit_name="",
                equipment_type="",
                tamcn=row.get("tamcn", ""),
                nsn="",
                serial_number=row.get("serial_number", ""),
                open_date=row.get("open_date") or date.today(),
                close_date=None,
                job_status="OPEN",
                priority=row.get("priority", "02"),
                defect_code_primary=row.get("defect_code_primary", ""),
                defect_code_secondary=row.get("defect_code_secondary", ""),
                service_request_type=row.get("service_request_type", "Maintenance - CM"),
                echelon_numeric=int(row.get("echelon_numeric") or 1) or 1,
                deadlined_date=row.get("deadlined_date"),
                # Header-only — flag so downstream consumers know
                # parts/due-in haven't joined yet.
                data_quality_flag="header_only",
            )
            new_srs.append(new_sr)

        new_dataset = _replace_dataset_srs(dataset, new_srs)

        audit_rows: List[Dict[str, Any]] = []
        for m in native.matched[:200]:
            audit_rows.append({
                "kind": "ingest.sr.apply.row",
                "subject_id": m.sr_number,
                "payload": {
                    "match_method": "sr_number",
                    "changes": [
                        {
                            "field": c.field,
                            "before": _serialize_for_audit(c.before),
                            "after": _serialize_for_audit(c.after),
                        }
                        for c in m.changes
                    ],
                },
            })
        for n in native.new[:200]:
            audit_rows.append({
                "kind": "ingest.sr.apply.new",
                "subject_id": n.sr_number,
                "payload": {
                    "data_quality_flag": "header_only",
                    "tamcn": n.parsed_row.get("tamcn", ""),
                    "unit_uic": n.parsed_row.get("unit_uic", ""),
                },
            })

        return WriterApplyResult(
            new_dataset=new_dataset,
            summary_counts=native.counts(),
            audit_rows=audit_rows,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _compute_field_changes(existing: Any, parsed_row: Dict[str, Any]) -> List[SRChange]:
    """Return SRChange entries for SR_HEADER_FIELDS where parsed
    differs from existing (only when parsed has a non-empty value
    — empty cells don't overwrite existing data)."""
    out: List[SRChange] = []
    for f in SR_HEADER_FIELDS:
        new_value = parsed_row.get(f)
        if new_value in (None, "", 0):
            continue
        old_value = getattr(existing, f, None)
        if old_value != new_value:
            out.append(SRChange(field=f, before=old_value, after=new_value))
    return out


def _apply_changes(sr: Any, changes: List[SRChange]) -> None:
    for c in changes:
        setattr(sr, c.field, c.after)


def _diff_to_payload(diff: SRDiff) -> Dict[str, Any]:
    """JSON-shaped diff for the dropzone. Caps each list at 50
    samples — counts() carries the totals."""
    return {
        "counts": diff.counts(),
        "matched": [
            {
                "sr_number": m.sr_number,
                "changes": [
                    {
                        "field": c.field,
                        "before": _serialize_for_audit(c.before),
                        "after": _serialize_for_audit(c.after),
                    }
                    for c in m.changes
                ],
            }
            for m in diff.matched[:50]
        ],
        "new": [
            {
                "sr_number": n.sr_number,
                "tamcn": n.parsed_row.get("tamcn", ""),
                "unit_uic": n.parsed_row.get("unit_uic", ""),
            }
            for n in diff.new[:50]
        ],
        "unchanged_count": len(diff.unchanged),
    }


def _serialize_for_audit(value: Any) -> Any:
    if isinstance(value, date):
        return value.isoformat()
    return value


def _replace_dataset_srs(ds: Any, new_srs: List[Any]) -> Any:
    from ...state import CanonicalDataset
    return CanonicalDataset(
        units=ds.units,
        assets=ds.assets,
        roster=ds.roster,
        srs=new_srs,
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


register_writer(ServiceRequestWriter())
