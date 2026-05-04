"""CRatingWriter — DRRS-MC unit C-rating apply.

Closes the Phase 3 loop: a non-Asset entity flowing through the
same EntityWriter protocol that Asset writers use. Proves the
framework is entity-agnostic — adding TC-AIMS II / DLA / Army-
GCSS / etc. is a per-source AdapterSpec + matching writer, no
pipeline or route changes.

DRRS-MC C-rating data is keyed on (unit_uic, as_of_date). Each
unit emits one rating per reporting period; a fresh export with
the same (unit_uic, as_of_date) updates the prior record's MET
scores / commander assessment / category.
"""
from __future__ import annotations

import hashlib
from copy import copy
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Tuple

from .base import EntityWriter, WriterApplyResult, WriterDiff, register_writer


C_RATING_FIELDS = (
    "c_rating",
    "met_scores",
    "operator_assessment",
)


@dataclass
class CRatingRecord:
    """In-memory C-rating record. Lightweight stand-in until the
    canonical IDM grows a typed entity for it. Fields mirror the
    DRRS-MC adapter's canonical_columns.
    """
    unit_uic: str
    as_of_date: Any  # date or ISO string
    c_rating: str = ""
    met_scores: str = ""
    operator_assessment: str = ""


@dataclass
class CRChange:
    field: str
    before: Any
    after: Any


@dataclass
class CRMatched:
    key: Tuple[str, Any]
    changes: List[CRChange] = field(default_factory=list)
    parsed_row: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CRNew:
    key: Tuple[str, Any]
    parsed_row: Dict[str, Any] = field(default_factory=dict)


@dataclass
class CRUnchanged:
    key: Tuple[str, Any]


@dataclass
class CRDiff:
    matched: List[CRMatched] = field(default_factory=list)
    new: List[CRNew] = field(default_factory=list)
    unchanged: List[CRUnchanged] = field(default_factory=list)
    conflicts: List[Any] = field(default_factory=list)
    stale: List[Any] = field(default_factory=list)

    def counts(self) -> Dict[str, int]:
        return {
            "matched_changed": len(self.matched),
            "new": len(self.new),
            "unchanged": len(self.unchanged),
            "stale": 0,
            "conflicts": 0,
        }


@dataclass
class CRatingWriter:
    adapter_id: str = "drrs-mc/c-rating"
    target_entity: str = "CRating"

    def state_token(self, dataset: Any) -> str:
        h = hashlib.sha256()
        items: List[str] = []
        for cr in getattr(dataset, "c_ratings", []) or []:
            uic = getattr(cr, "unit_uic", "") or ""
            d = getattr(cr, "as_of_date", "") or ""
            d_s = d.isoformat() if hasattr(d, "isoformat") else str(d)
            rating = getattr(cr, "c_rating", "") or ""
            items.append(f"{uic}|{d_s}|{rating}")
        items.sort()
        for i in items:
            h.update(i.encode("utf-8"))
            h.update(b"\n")
        return h.hexdigest()[:16]

    def preview(self, pipeline_result: Any, dataset: Any) -> WriterDiff:
        existing_by_key: Dict[Tuple[str, Any], Any] = {}
        for cr in getattr(dataset, "c_ratings", []) or []:
            uic = getattr(cr, "unit_uic", "")
            asof = getattr(cr, "as_of_date", None)
            existing_by_key[(uic, _norm_date(asof))] = cr

        diff = CRDiff()
        for row in pipeline_result.rows:
            uic = (row.get("unit_uic") or "").strip()
            asof = row.get("as_of_date")
            if not uic or asof is None:
                continue
            key = (uic, _norm_date(asof))
            existing = existing_by_key.get(key)
            if existing is None:
                diff.new.append(CRNew(key=key, parsed_row=dict(row)))
                continue
            changes = _compute_changes(existing, row)
            if changes:
                diff.matched.append(CRMatched(
                    key=key, changes=changes, parsed_row=dict(row),
                ))
            else:
                diff.unchanged.append(CRUnchanged(key=key))

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
        canonical = list(getattr(dataset, "c_ratings", []) or [])
        existing_by_key: Dict[Tuple[str, Any], Any] = {}
        for cr in canonical:
            uic = getattr(cr, "unit_uic", "")
            asof = getattr(cr, "as_of_date", None)
            existing_by_key[(uic, _norm_date(asof))] = cr

        native: CRDiff = diff.native

        new_records: List[Any] = []
        matched_keys = {m.key for m in native.matched}
        matched_payloads: Dict[Tuple[str, Any], CRMatched] = {
            m.key: m for m in native.matched
        }

        for cr in canonical:
            key = (
                getattr(cr, "unit_uic", ""),
                _norm_date(getattr(cr, "as_of_date", None)),
            )
            if key in matched_keys:
                clone = copy(cr)
                _apply_changes(clone, matched_payloads[key].changes)
                new_records.append(clone)
            else:
                new_records.append(cr)

        for n in native.new:
            row = n.parsed_row
            new_records.append(CRatingRecord(
                unit_uic=row.get("unit_uic", ""),
                as_of_date=row.get("as_of_date"),
                c_rating=row.get("c_rating", ""),
                met_scores=row.get("met_scores", ""),
                operator_assessment=row.get("operator_assessment", ""),
            ))

        new_dataset = _replace_dataset_c_ratings(dataset, new_records)

        audit_rows: List[Dict[str, Any]] = []
        for m in native.matched[:200]:
            uic, d = m.key
            audit_rows.append({
                "kind": "ingest.crating.apply.row",
                "subject_id": f"{uic}|{d}",
                "payload": {
                    "match_method": "uic_asof_tuple",
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
            uic, d = n.key
            audit_rows.append({
                "kind": "ingest.crating.apply.new",
                "subject_id": f"{uic}|{d}",
                "payload": {
                    "c_rating": n.parsed_row.get("c_rating", ""),
                },
            })

        return WriterApplyResult(
            new_dataset=new_dataset,
            summary_counts=native.counts(),
            audit_rows=audit_rows,
        )


def _norm_date(value: Any) -> str:
    """Normalize as_of_date to ISO string for stable dict keys."""
    if value is None or value == "":
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _compute_changes(existing: Any, parsed_row: Dict[str, Any]) -> List[CRChange]:
    out: List[CRChange] = []
    for f in C_RATING_FIELDS:
        new_value = parsed_row.get(f)
        if new_value in (None, "", 0):
            continue
        old_value = getattr(existing, f, None)
        if old_value != new_value:
            out.append(CRChange(field=f, before=old_value, after=new_value))
    return out


def _apply_changes(record: Any, changes: List[CRChange]) -> None:
    for c in changes:
        setattr(record, c.field, c.after)


def _diff_to_payload(diff: CRDiff) -> Dict[str, Any]:
    return {
        "counts": diff.counts(),
        "matched": [
            {
                "unit_uic": m.key[0],
                "as_of_date": str(m.key[1]),
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
                "unit_uic": n.key[0],
                "as_of_date": str(n.key[1]),
                "c_rating": n.parsed_row.get("c_rating", ""),
            }
            for n in diff.new[:50]
        ],
        "unchanged_count": len(diff.unchanged),
    }


def _serialize_for_audit(value: Any) -> Any:
    if isinstance(value, date):
        return value.isoformat()
    return value


def _replace_dataset_c_ratings(ds: Any, new_c_ratings: List[Any]) -> Any:
    from ...state import CanonicalDataset
    return CanonicalDataset(
        units=ds.units,
        assets=ds.assets,
        roster=ds.roster,
        srs=ds.srs,
        snapshots=ds.snapshots,
        reqs=ds.reqs,
        cannib_events=ds.cannib_events,
        incidents=ds.incidents,
        tmrs=ds.tmrs,
        dq_defects=ds.dq_defects,
        violations=ds.violations,
        c_ratings=new_c_ratings,
        generated_at=ds.generated_at,
        seed=ds.seed,
    )


register_writer(CRatingWriter())
