"""System-level endpoints: status, audit, secure wipe (stubbed)."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter

from ..state import get_dataset

router = APIRouter()


def _dataset_fingerprint() -> str:
    """Stable 16-char digest of the current in-memory dataset for status ping."""
    ds = get_dataset()
    payload = {
        "seed": ds.seed,
        "assets": len(ds.assets),
        "srs": len(ds.srs),
        "snapshots": len(ds.snapshots),
        "incidents": len(ds.incidents),
    }
    raw = json.dumps(payload, sort_keys=True).encode()
    return hashlib.sha256(raw).hexdigest()[:16]


@router.get("/status")
async def status():
    ds = get_dataset()
    err = sum(1 for v in ds.violations if v.severity == "error")
    return {
        "mode": os.environ.get("SPIRE_MODE", "full"),
        "version": "0.1.0",
        "backend_time_local": datetime.now().isoformat(timespec="seconds"),
        "dataset": {
            "seed": ds.seed,
            "generated_at": ds.generated_at,
            "fingerprint": _dataset_fingerprint(),
            "units": len(ds.units),
            "assets": len(ds.assets),
            "personnel": len(ds.roster),
            "srs": len(ds.srs),
            "snapshots": len(ds.snapshots),
            "requisitions": len(ds.reqs),
            "incidents": len(ds.incidents),
            "cannibalization_events": len(ds.cannib_events),
            "data_quality_defects": ds.dq_defects,
            "consistency_errors": err,
        },
        "llm": {
            "reachable": False,  # filled in when Gemma4 is online
            "model": "gemma4-26b-a4b-fp8",
            "max_context": 524288,
            "proxy": "http://127.0.0.1:8095",
        },
        "features": {
            "sentry": True,
            "pulse": True,
            "bastion": True,
            "nl_queries": False,  # flips when LLM proxy reachable
        },
    }


@router.get("/audit")
async def audit():
    """Placeholder audit log endpoint. The real append-only hash-chained log
    will live in SQLite. For the hackathon we return a synthetic trailing
    window of the most recent actions tracked in-memory."""
    return {
        "note": "Audit log persistence is in-memory for the hackathon. Production uses SHA-256 hash-chained SQLite.",
        "entries": [],
    }
