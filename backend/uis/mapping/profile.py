"""MappingProfile — operator-confirmed projection captured for reuse.

A profile is what makes the system *learnable*: every time an
operator confirms a mapping, the next file with the same shape
auto-applies. Profiles are stored in SQLite alongside the audit
chain (see `store.py`) and version forward — when a source schema
changes the operator creates a new profile rather than mutating
the old one.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Optional


def _utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass
class MappingProfile:
    """One persisted mapping."""

    profile_id: str                                    # "3d-mlr/gcss-mc-ecp/v2026-04"
    source_id: str                                     # "gcss-mc/ecp"
    column_map: Dict[str, str]                         # source_col → canonical_field
    unit: Optional[str] = None                         # "3d MLR" or None for fleet-wide
    source_version: Optional[str] = None               # operator-tagged
    cell_transforms: Dict[str, str] = field(default_factory=dict)  # canonical_field → transform_id override
    operator_notes: str = ""
    created_by: str = ""                               # DODID
    created_at: str = field(default_factory=_utc_iso)
    confirmed_at: Optional[str] = None
    confidence: float = 1.0                            # 1.0 once operator-confirmed

    def is_confirmed(self) -> bool:
        return self.confirmed_at is not None

    def to_dict(self) -> dict:
        return {
            "profile_id": self.profile_id,
            "source_id": self.source_id,
            "unit": self.unit,
            "source_version": self.source_version,
            "column_map": dict(self.column_map),
            "cell_transforms": dict(self.cell_transforms),
            "operator_notes": self.operator_notes,
            "created_by": self.created_by,
            "created_at": self.created_at,
            "confirmed_at": self.confirmed_at,
            "confidence": self.confidence,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "MappingProfile":
        return cls(
            profile_id=d["profile_id"],
            source_id=d["source_id"],
            unit=d.get("unit"),
            source_version=d.get("source_version"),
            column_map=dict(d.get("column_map") or {}),
            cell_transforms=dict(d.get("cell_transforms") or {}),
            operator_notes=d.get("operator_notes", ""),
            created_by=d.get("created_by", ""),
            created_at=d.get("created_at") or _utc_iso(),
            confirmed_at=d.get("confirmed_at"),
            confidence=float(d.get("confidence", 1.0)),
        )
