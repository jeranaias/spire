"""System-level endpoints: status, audit, secure wipe (stubbed)."""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from ..state import get_dataset
from ..persistence import (
    feedback_summary,
    log as audit_log,
    recent_entries,
    secure_wipe,
    verify_chain,
)

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
    chain = verify_chain()
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
        "security": {
            "audit_chain_intact": chain["ok"],
            "audit_entries": chain["entries"],
            "audit_head_hash": chain.get("head_hash", ""),
            "encrypted_at_rest": bool(os.environ.get("SPIRE_DB_PASSPHRASE")),
        },
        "models": _model_status(),
        "network_egress": _network_egress_summary(),
    }


def _model_status() -> dict:
    try:
        from ..model_hooks import STATE as MS
        return MS.status()
    except Exception as e:  # noqa: BLE001
        return {"error": str(e)}


def _network_egress_summary() -> dict:
    try:
        from ..network_monitor import recent, unapproved_count
        return {
            "armed": True,
            "recent": recent()[-10:],
            "unapproved_attempts": unapproved_count(),
        }
    except Exception as e:  # noqa: BLE001
        return {"armed": False, "error": str(e)}


@router.get("/audit")
async def audit(limit: int = 50):
    """Append-only hash-chained audit log backed by SQLite. Each entry is
    SHA-256 chained to the previous; any mutation breaks the chain and
    verify_chain() reports the first offending id."""
    chain = verify_chain()
    entries = recent_entries(limit=limit)
    return {
        "chain": chain,
        "entries": entries,
        "feedback_summary": feedback_summary(),
        "storage": {
            "encrypted_at_rest": bool(os.environ.get("SPIRE_DB_PASSPHRASE")),
            "db_path": "runtime/spire.db (plaintext)" if not os.environ.get("SPIRE_DB_PASSPHRASE") else "runtime/spire.db.enc (AES-256 via Fernet/PBKDF2-200k)",
        },
    }


@router.post("/secure-wipe")
async def _secure_wipe(payload: dict = Body(default={})):
    """Destructive. Requires payload {'confirm': 'CONFIRM'}."""
    token = (payload or {}).get("confirm", "")
    if token != "CONFIRM":
        raise HTTPException(status_code=400, detail="Send {confirm: 'CONFIRM'} to execute")
    actor = (payload or {}).get("actor_role", "security_manager")
    result = secure_wipe(actor=actor)
    return result
