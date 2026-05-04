"""Dry-run merge engine for the GCSS-MC ECP adapter.

The ECP adapter (`pulse_gcss_ecp_adapter.py`) parses the file. This
module compares the parsed rows against the canonical dataset and
returns a structural diff: which rows would land as new assets, which
would update existing assets, which assets are missing from the file,
and which carry conflicts the operator has to resolve.

Match strategy
--------------
Primary key in the canonical dataset is `Asset.asset_id` (a synthetic
UIC-equipment-type-index string the dataset generator assembles —
e.g. "M21670-MTVR_CARGO-006"). The ECP file does not carry that ID;
the operator-grade key in the file is `SERIAL_NUMBER` plus the owning
UIC. Both can be sanitized (hashed) on either side, so we resolve in
this priority:

  1. Exact serial-number match.
  2. (TAMCN, OWNER_UIC) tuple match if the row has neither a clear
     nor a pre-hashed serial — last-resort, and we flag it.

A row that doesn't match anything is "new". An asset that has no
matching row is "stale" — present in the canonical roster but absent
from this ECP. Stale rows are NOT auto-deleted; they're surfaced for
the operator to confirm the unit really does no longer custody the
asset (vs. the file just being incomplete).

Field comparison
----------------
Only roster columns are compared. Behavioral fields (current_hours,
current_miles, current_status, days_nmc_last_12mo, etc.) come from
utilization extracts and live simulation; they are out-of-scope for
ECP merge.

Compared fields:
  - tamcn
  - nsn
  - nomenclature
  - unit_uic (mapped from OWNER_UIC)
  - allowance_qty (NEW field — not in current Asset; surfaced for
    schema-extension review at apply time)
  - on_hand_qty (NEW field — same)
  - last_inventory_date (NEW field — same)

The diff lists per-field changes for each updated row so the operator
can spot suspicious bulk edits ("every NSN flipped — is this a real
re-cataloguing or a column drift?").
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from .pulse_gcss_ecp_adapter import ParsedAssetRow


@dataclass
class FieldChange:
    field: str
    before: Any
    after: Any


@dataclass
class MatchedRow:
    """A parsed row that resolved to an existing dataset asset."""

    asset_id: str  # canonical dataset key
    parsed: ParsedAssetRow
    changes: List[FieldChange] = field(default_factory=list)
    match_method: str = "serial_number"  # or "tamcn_uic_tuple"


@dataclass
class NewRow:
    """A parsed row that has no canonical asset to match."""

    parsed: ParsedAssetRow
    reason: str = "no_serial_match"  # or "no_tamcn_uic_match"


@dataclass
class StaleAsset:
    """An asset in the canonical roster that has no row in this ECP."""

    asset_id: str
    serial_number: str
    tamcn: str
    unit_uic: str
    nomenclature: str


@dataclass
class ConflictRow:
    """A parsed row that matched multiple canonical assets — operator resolves."""

    parsed: ParsedAssetRow
    candidate_asset_ids: List[str]
    reason: str  # e.g. "duplicate_serial"


@dataclass
class MergeDiff:
    """Structured comparison the upload route returns to the operator."""

    matched: List[MatchedRow] = field(default_factory=list)
    new: List[NewRow] = field(default_factory=list)
    unchanged: List[MatchedRow] = field(default_factory=list)
    stale: List[StaleAsset] = field(default_factory=list)
    conflicts: List[ConflictRow] = field(default_factory=list)

    def counts(self) -> Dict[str, int]:
        return {
            "matched_changed": len(self.matched),
            "new": len(self.new),
            "unchanged": len(self.unchanged),
            "stale": len(self.stale),
            "conflicts": len(self.conflicts),
        }


# ---------------------------------------------------------------------------
# Public entrypoint
# ---------------------------------------------------------------------------


def compute_diff(
    parsed_rows: Sequence[ParsedAssetRow],
    canonical_assets: Sequence[Any],
) -> MergeDiff:
    """Compute the structural diff between an ECP file and the dataset.

    Parameters
    ----------
    parsed_rows
        Output of `parse_ecp(...)` — list of `ParsedAssetRow`.
    canonical_assets
        Iterable of `dataset.fleet.Asset` (or any object exposing
        `.asset_id`, `.serial_number`, `.tamcn`, `.unit_uic`,
        `.nsn`, `.nomenclature`).

    Returns
    -------
    MergeDiff
    """
    # Index canonical assets for cheap lookup. We build three indexes
    # because the ECP can present a row keyed any of three ways:
    #
    # - serial-only      → exact serial match
    # - (TAMCN, UIC)     → fallback tuple match for serial-less rows
    # - by asset_id      → for completeness counts only
    by_serial: Dict[str, List[Any]] = {}
    by_tamcn_uic: Dict[tuple, List[Any]] = {}
    seen_asset_ids: set = set()
    for asset in canonical_assets:
        asset_id = getattr(asset, "asset_id", "")
        if not asset_id:
            continue
        seen_asset_ids.add(asset_id)
        sn = (getattr(asset, "serial_number", "") or "").strip()
        if sn:
            by_serial.setdefault(sn, []).append(asset)
        tamcn = (getattr(asset, "tamcn", "") or "").strip()
        uic = (getattr(asset, "unit_uic", "") or "").strip()
        if tamcn and uic:
            by_tamcn_uic.setdefault((tamcn, uic), []).append(asset)

    diff = MergeDiff()
    matched_asset_ids: set = set()

    for row in parsed_rows:
        match = _resolve_match(row, by_serial, by_tamcn_uic)
        if match is None:
            diff.new.append(NewRow(parsed=row, reason="no_serial_match"))
            continue
        if isinstance(match, list):
            diff.conflicts.append(
                ConflictRow(
                    parsed=row,
                    candidate_asset_ids=[
                        getattr(a, "asset_id", "") for a in match
                    ],
                    reason="duplicate_serial",
                )
            )
            continue
        # match is a single canonical asset
        matched_asset_ids.add(match.asset_id)
        method = "serial_number" if row.serial_number else "tamcn_uic_tuple"
        changes = _compare_row_to_asset(row, match)
        record = MatchedRow(
            asset_id=match.asset_id,
            parsed=row,
            changes=changes,
            match_method=method,
        )
        if changes:
            diff.matched.append(record)
        else:
            diff.unchanged.append(record)

    # Stale = in canonical, not in this ECP
    stale_ids = seen_asset_ids - matched_asset_ids
    for asset in canonical_assets:
        if getattr(asset, "asset_id", "") not in stale_ids:
            continue
        diff.stale.append(
            StaleAsset(
                asset_id=getattr(asset, "asset_id", ""),
                serial_number=getattr(asset, "serial_number", "") or "",
                tamcn=getattr(asset, "tamcn", "") or "",
                unit_uic=getattr(asset, "unit_uic", "") or "",
                nomenclature=getattr(asset, "nomenclature", "") or "",
            )
        )

    return diff


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_match(
    row: ParsedAssetRow,
    by_serial: Dict[str, List[Any]],
    by_tamcn_uic: Dict[tuple, List[Any]],
) -> Any:
    """Return the matched asset, a list of candidates on conflict, or None.

    Resolution rule:
      * If the row has a serial number, that's the operator's primary
        key — the match is decided by serial. No serial match means
        "new asset", regardless of whether some other asset on the same
        unit happens to share the row's TAMCN. Falling through to the
        tuple lookup here would silently merge two different assets
        (the new one, and a same-TAMCN asset already on the unit)
        whenever the file's serial sanitization scheme differs from
        the dataset's.
      * If the row has no serial at all, fall back to (TAMCN, OWNER_UIC)
        as a last-resort heuristic and flag the match method so the
        operator sees the resolution path.
    """
    if row.serial_number:
        candidates = by_serial.get(row.serial_number, [])
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            return candidates  # caller treats as conflict
        return None  # serial present but no match → new
    if row.tamcn and row.owner_uic:
        candidates = by_tamcn_uic.get((row.tamcn, row.owner_uic), [])
        if len(candidates) == 1:
            return candidates[0]
        if len(candidates) > 1:
            return candidates
    return None


def _compare_row_to_asset(row: ParsedAssetRow, asset: Any) -> List[FieldChange]:
    """Per-field comparison. Only roster columns are inspected."""
    changes: List[FieldChange] = []
    pairs = [
        ("tamcn", row.tamcn, getattr(asset, "tamcn", "") or ""),
        ("nsn", row.nsn, getattr(asset, "nsn", "") or ""),
        ("nomenclature", row.nomenclature, getattr(asset, "nomenclature", "") or ""),
        ("unit_uic", row.owner_uic, getattr(asset, "unit_uic", "") or ""),
    ]
    for field_name, after, before in pairs:
        if not after:
            # File doesn't carry the field — skip the comparison entirely
            # rather than reporting "set to empty" as a change. The
            # parser already flagged missing fields as warnings.
            continue
        if (after or "").strip() != (before or "").strip():
            changes.append(FieldChange(field=field_name, before=before, after=after))
    # ECP-only fields. The canonical Asset doesn't carry these yet;
    # apply path will need a schema extension. For dry-run, surface
    # the value the file proposes so the operator sees what would
    # land.
    if row.allowance_qty:
        changes.append(
            FieldChange(field="allowance_qty", before=None, after=row.allowance_qty)
        )
    if row.on_hand_qty:
        changes.append(
            FieldChange(field="on_hand_qty", before=None, after=row.on_hand_qty)
        )
    if row.last_inventory_date:
        changes.append(
            FieldChange(
                field="last_inventory_date",
                before=None,
                after=row.last_inventory_date.isoformat(),
            )
        )
    return changes


# ---------------------------------------------------------------------------
# Serializer for the upload-route response
# ---------------------------------------------------------------------------


def apply_diff(
    diff: MergeDiff,
    canonical_assets: Sequence[Any],
    *,
    asset_factory=None,
) -> List[Any]:
    """Produce a new asset list with the diff applied — does NOT swap.

    The caller owns the swap (atomic via state.swap_dataset). This
    function is pure: it returns a new list reflecting matched-row
    updates and new-row appends. Stale assets are passed through
    unchanged — operator hand-off, not auto-delete. Conflicts are
    skipped (the operator must resolve before apply).

    Parameters
    ----------
    diff
        Output of `compute_diff(...)`.
    canonical_assets
        Same iterable used to compute the diff. We rebuild the list
        deterministically so hot writes can't sneak in between
        diff and apply.
    asset_factory
        Callable that takes a `ParsedAssetRow` and returns a new
        `dataset.fleet.Asset`. The merge engine doesn't import the
        Asset class directly to keep this module test-friendly;
        callers (the route) inject the constructor. New rows are
        skipped with a warning if no factory is supplied.

    Returns
    -------
    List of asset objects (same type as input) reflecting the apply.
    """
    # Index matched changes by asset_id for cheap lookup.
    matched_by_id: Dict[str, List[FieldChange]] = {
        m.asset_id: m.changes for m in diff.matched
    }

    new_assets: List[Any] = []
    for asset in canonical_assets:
        asset_id = getattr(asset, "asset_id", "")
        changes = matched_by_id.get(asset_id)
        if changes:
            _apply_changes_in_place(asset, changes)
        new_assets.append(asset)

    if asset_factory is not None:
        import logging as _logging
        _log = _logging.getLogger(__name__)
        for new_row in diff.new:
            try:
                new_assets.append(asset_factory(new_row.parsed))
            except Exception as e:  # noqa: BLE001
                # The factory rejected the row (typically a missing
                # required field after coercion). Log at WARN so the
                # backend operator can grep stderr / journalctl when
                # they wonder why a "diff said 100 new" but only "92
                # new applied" happened. The route-level audit entry
                # carries the diff counts; this log gives per-row
                # visibility for debugging.
                _log.warning(
                    "apply_diff: asset_factory rejected row tamcn=%r serial=%r reason=%s",
                    getattr(new_row.parsed, "tamcn", ""),
                    getattr(new_row.parsed, "serial_number", ""),
                    str(e)[:200],
                )

    # Conflicts and stale: untouched. The operator resolves conflicts
    # in a follow-up flow; stale assets stay in the canonical roster
    # until the operator confirms removal.
    return new_assets


def _apply_changes_in_place(asset: Any, changes: List[FieldChange]) -> None:
    """Mutate the asset object to reflect each FieldChange.

    Roster fields are direct attribute assignments. ECP-only fields
    (allowance_qty, on_hand_qty, last_inventory_date) are also direct
    assignments on the post-RD6a Asset schema. Fields the asset
    object doesn't expose are skipped (defensive — keeps this
    function safe against future schema changes).
    """
    for change in changes:
        if not hasattr(asset, change.field):
            continue
        value = change.after
        if change.field == "last_inventory_date" and isinstance(value, str):
            # diff serialized the date as ISO string; parse it back.
            from datetime import date as _date
            try:
                yyyy, mm, dd = value.split("-")
                value = _date(int(yyyy), int(mm), int(dd))
            except (ValueError, AttributeError):
                continue
        setattr(asset, change.field, value)


def diff_to_payload(diff: MergeDiff, *, max_samples: int = 10) -> Dict[str, Any]:
    """Convert a MergeDiff to a JSON-serializable preview payload.

    Caps each list at `max_samples` so the upload route stays under
    sensible response sizes — the operator's dry-run UI only ever
    paginates a handful at a time. The full counts are still in the
    `counts` dict.
    """
    return {
        "counts": diff.counts(),
        "matched_changed": [
            {
                "asset_id": r.asset_id,
                "match_method": r.match_method,
                "changes": [
                    {"field": c.field, "before": c.before, "after": c.after}
                    for c in r.changes
                ],
            }
            for r in diff.matched[:max_samples]
        ],
        "new": [
            {
                "tamcn": r.parsed.tamcn,
                "serial_number": r.parsed.serial_number,
                "owner_uic": r.parsed.owner_uic,
                "nomenclature": r.parsed.nomenclature,
                "reason": r.reason,
            }
            for r in diff.new[:max_samples]
        ],
        "stale": [
            {
                "asset_id": s.asset_id,
                "serial_number": s.serial_number,
                "tamcn": s.tamcn,
                "unit_uic": s.unit_uic,
                "nomenclature": s.nomenclature,
            }
            for s in diff.stale[:max_samples]
        ],
        "conflicts": [
            {
                "tamcn": c.parsed.tamcn,
                "serial_number": c.parsed.serial_number,
                "owner_uic": c.parsed.owner_uic,
                "candidate_asset_ids": c.candidate_asset_ids,
                "reason": c.reason,
            }
            for c in diff.conflicts[:max_samples]
        ],
    }
