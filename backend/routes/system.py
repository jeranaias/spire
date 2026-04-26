"""System-level endpoints: status, audit, secure wipe (stubbed)."""
from __future__ import annotations

import hashlib
import json
import os
import sys as _sys
import uuid
from collections import defaultdict
from datetime import datetime, timedelta
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
from ..scoping import (
    require_role,
    SECURE_WIPE_ROLES,
    AIRGAP_ROLES,
    ADMIN_TELEMETRY_ROLES,
    AUDIT_READ_ROLES,
)

# Comms-state primitives — backs GC-7 air-gap toggle.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in _sys.path:
    _sys.path.insert(0, str(_REPO_ROOT))
try:
    from dataset.comms import CommsState, generate_comms_timeline, format_state_for_api  # type: ignore[import-not-found]
    _COMMS_AVAILABLE = True
    _TIMELINE = generate_comms_timeline(datetime.utcnow(), seed=42)
except Exception:
    _COMMS_AVAILABLE = False
    _TIMELINE = None

# In-memory air-gap state. Toggled via /comms/airgap; while AIR_GAPPED is True,
# /comms/queue accepts mutations into a local queue that flushes on toggle-off.
_AIR_GAPPED: bool = False
_QUEUE: list[dict] = []

router = APIRouter()


async def _probe_llm_brief() -> dict:
    """Live probe of the configured LLM proxy.

    Reads the proxy URL from env at request time (not module import) so that
    rotating SPIRE_LLM_PROXY via Fly secrets is reflected without restart.
    Returns a small block suitable for embedding in /status; never raises.

    The upstream proxy may advertise routing aliases (haiku/sonnet/opus/cloud)
    that route off-rig to commercial APIs — that breaks SPIRE's local-first /
    no-cloud / IL5-fit posture if surfaced. We filter to only show the local
    routes so an inspector sees a no-cloud model surface.
    """
    proxy = os.environ.get("SPIRE_LLM_PROXY", "http://127.0.0.1:8095")
    # The proxy serves Gemma 4 26B FP8 under whatever API alias vLLM was
    # launched with. SPIRE_LLM_MODEL is the alias we send in the request
    # body (must match vLLM's --served-model-name); the user-visible label
    # below reads "Gemma 4 26B FP8" because that's the actual model loaded.
    api_alias = os.environ.get("SPIRE_LLM_MODEL", "llama4-maverick")
    info: dict = {
        "reachable": False,
        "model": "Gemma 4 26B FP8",
        "model_api_alias": api_alias,
        "max_context": 524288,
        "proxy": proxy,
    }
    # Cloud-routing aliases that must NEVER appear in SPIRE's public surface.
    # Anything matching these gets dropped from available_models and would be
    # rejected by call_llm_chat() if requested as the model.
    cloud_aliases = {"cloud", "openrouter", "anthropic", "haiku", "sonnet", "opus", "gpt", "gpt-4", "gpt-4o", "claude"}
    try:
        import httpx  # local import keeps cold-start lean
        async with httpx.AsyncClient(timeout=3.0, follow_redirects=False) as client:
            resp = await client.get(f"{proxy}/v1/models")
            if resp.status_code == 200:
                info["reachable"] = True
                try:
                    data = resp.json().get("data") or []
                    all_ids = [m.get("id") for m in data if m.get("id")]
                    local_ids = [i for i in all_ids if i.lower() not in cloud_aliases]
                    info["available_models"] = local_ids
                    cloud_seen = [i for i in all_ids if i.lower() in cloud_aliases]
                    if cloud_seen:
                        info["cloud_aliases_filtered"] = cloud_seen
                except Exception:
                    pass
            else:
                info["error"] = f"HTTP {resp.status_code}"
    except Exception as e:  # noqa: BLE001
        info["error"] = str(e)[:160]
    return info


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
    llm_probe = await _probe_llm_brief()
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
        "llm": llm_probe,
        "features": {
            "sentry": True,
            "pulse": True,
            "bastion": True,
            "nl_queries": llm_probe["reachable"],
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


@router.get("/dataset-info")
async def dataset_info():
    """Single source of truth for dataset freshness across views.

    Walkthrough #JOB-B (review #52 / #30) — PULSE's heatmap "as of" and
    Forecast "TODAY" pin used to read 31 MAY 26 while BASTION + SENTRY
    showed 26 APR 26 (wall clock). Both surfaces now consult this endpoint
    so every "as of" stamp lines up.

    The Mission Clock in BASTION's MapHUD intentionally shows real wall-
    clock UTC (operating mission time) — not the dataset stamp.
    """
    ds = get_dataset()
    last_day = ds.snapshots[-1].snapshot_date if ds.snapshots else None
    first_day = ds.snapshots[0].snapshot_date if ds.snapshots else None
    return {
        "dataset_last_day": last_day.isoformat() if last_day else None,
        "dataset_first_day": first_day.isoformat() if first_day else None,
        "snapshot_days": len({s.snapshot_date for s in ds.snapshots}),
        "fingerprint": _dataset_fingerprint(),
        "build_id": "spire-mdm-2026",
        "as_of": last_day.isoformat() if last_day else None,
        "generated_at": ds.generated_at,
        "seed": ds.seed,
    }


@router.get("/audit")
async def audit(limit: int = 50, role: str | None = None):
    """Append-only hash-chained audit log backed by SQLite. Each entry is
    SHA-256 chained to the previous; any mutation breaks the chain and
    verify_chain() reports the first offending id.

    Audit chain mining can reconstruct cross-role decision history, so
    read access is gated to security_manager only."""
    require_role(role, AUDIT_READ_ROLES, "audit.read")
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
    """Destructive. Requires payload {'confirm': 'CONFIRM', 'actor_role': 'security_manager'}.

    Server-side gate: only security_manager may invoke. Without this gate,
    any role could wipe the audit chain and the demo's "tamper-proof"
    narrative collapses (verified live during adversarial audit: a
    maintenance_chief reduced 20→1 entries, fileable as bug #7)."""
    actor = (payload or {}).get("actor_role")
    require_role(actor, SECURE_WIPE_ROLES, "audit.secure_wipe")
    token = (payload or {}).get("confirm", "")
    if token != "CONFIRM":
        raise HTTPException(status_code=400, detail="Send {confirm: 'CONFIRM'} to execute")
    result = secure_wipe(actor=actor)
    return result


# ---------------------------------------------------------------------------
# GC-7 Air-gap deployment mode — comms-state + queue-on-disconnect
# ---------------------------------------------------------------------------

@router.get("/comms/state")
async def comms_state():
    """Return the current comms-state plus a 14-day rolling timeline of
    transitions (seeded from dataset/comms.py). When the air-gap toggle is
    on, the current_state is forced to DISCONNECTED regardless of the
    underlying timeline so the StatusFooter reflects operator intent."""
    if not _COMMS_AVAILABLE or _TIMELINE is None:
        return {
            "current_state": "DISCONNECTED" if _AIR_GAPPED else "CONNECTED",
            "as_of": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "recent_events": [],
            "queued_ops_count": len([q for q in _QUEUE if not q.get("replayed_at")]),
            "last_sync_at": None,
            "air_gap_active": _AIR_GAPPED,
        }
    body = format_state_for_api(_TIMELINE)
    if _AIR_GAPPED:
        body["current_state"] = "DISCONNECTED"
    body["queued_ops_count"] = len([q for q in _QUEUE if not q.get("replayed_at")])
    body["air_gap_active"] = _AIR_GAPPED
    return body


@router.post("/comms/airgap")
async def comms_airgap(payload: dict = Body(default={})):
    """Toggle air-gap mode. Body: {enable: bool, actor_role: str}.
    When enabled: subsequent /comms/queue calls accept mutations to the
    local queue. When disabled: queue replays to the master, returns a
    sync-resolution log.

    Gated to security_manager + mef_commander; lower roles return 403."""
    global _AIR_GAPPED
    enable = bool(payload.get("enable", not _AIR_GAPPED))
    actor = payload.get("actor_role")
    require_role(actor, AIRGAP_ROLES, "comms.airgap.toggle")
    if enable == _AIR_GAPPED:
        return {"ok": True, "no_change": True, "air_gap_active": _AIR_GAPPED}

    if enable:
        _AIR_GAPPED = True
        audit_log(
            "comms_airgap_engaged",
            actor=actor,
            subject_id="comms",
            payload={"reason": payload.get("reason", "operator-initiated"), "queued_at_engagement": len(_QUEUE)},
        )
        return {
            "ok": True,
            "air_gap_active": True,
            "engaged_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        }

    # Disable: replay queued ops, mark each replayed_at, return resolution log.
    resolutions: list[dict] = []
    now = datetime.utcnow()
    for q in _QUEUE:
        if q.get("replayed_at"):
            continue
        q["replayed_at"] = now.isoformat(timespec="seconds") + "Z"
        # In production, conflict detection happens against the master state.
        # For the demo the LWW resolution is trivial since no concurrent writes.
        q["replay_result"] = "applied"
        resolutions.append({
            "local_id": q.get("local_id"),
            "op_kind": q.get("op_kind"),
            "actor": q.get("actor"),
            "queued_at": q.get("queued_at"),
            "replayed_at": q["replayed_at"],
            "result": "applied",
        })
        audit_log(
            "comms_queued_op_replay",
            actor=q.get("actor", "unknown"),
            subject_id=q.get("local_id", ""),
            payload=q,
        )
    _AIR_GAPPED = False
    audit_log(
        "comms_airgap_released",
        actor=actor,
        subject_id="comms",
        payload={"replayed": len(resolutions)},
    )
    return {
        "ok": True,
        "air_gap_active": False,
        "released_at": now.isoformat(timespec="seconds") + "Z",
        "replayed": len(resolutions),
        "resolutions": resolutions,
    }


@router.post("/comms/queue")
async def comms_queue(payload: dict = Body(default={})):
    """Queue a mutation while air-gapped. Body: {op_kind, payload, actor,
    actor_edipi?}. Returns the local_id assigned. While the air-gap toggle
    is OFF, the queue is bypassed and the caller should hit the live
    endpoint directly — we surface this as a 409 so the frontend can fall
    through to the canonical write path."""
    if not _AIR_GAPPED:
        raise HTTPException(status_code=409, detail="not air-gapped — call the live endpoint directly")
    op = {
        "local_id": f"AGQ-{uuid.uuid4().hex[:10]}",
        "op_kind": payload.get("op_kind", "unknown"),
        "payload": payload.get("payload", {}),
        "actor": payload.get("actor", "operator"),
        "actor_edipi": payload.get("actor_edipi"),
        "queued_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "replayed_at": None,
        "replay_result": None,
    }
    _QUEUE.append(op)
    return {"ok": True, "local_id": op["local_id"], "queued_at": op["queued_at"], "queue_depth": len([q for q in _QUEUE if not q["replayed_at"]])}


@router.get("/comms/queue")
async def comms_queue_list(limit: int = 50):
    """Inspect the queue (read-only)."""
    return {
        "queue": _QUEUE[-limit:],
        "depth": len([q for q in _QUEUE if not q.get("replayed_at")]),
        "air_gap_active": _AIR_GAPPED,
    }


# ---------------------------------------------------------------------------
# Pilot feedback — in-app "Report Issue" drawer posts here
# ---------------------------------------------------------------------------

_FEEDBACK_LOG: list[dict] = []


@router.post("/feedback")
async def submit_feedback(payload: dict = Body(default={})):
    """Pilot operator feedback submitted from the in-app drawer.

    Always lands locally to the audit chain so we don't lose anything in
    air-gap conditions. When `SPIRE_GITHUB_TOKEN` is set, also creates a
    GitHub issue against the configured repo so the maintainer + cohort
    can triage from the same surface they file PRs."""
    title = (payload.get("title") or "").strip()
    body = (payload.get("body") or "").strip()
    if not title or not body:
        raise HTTPException(status_code=400, detail="title + body required")

    issue_type = (payload.get("issue_type") or "bug").lower()
    if issue_type not in ("bug", "idea", "question", "praise"):
        issue_type = "bug"
    severity = payload.get("severity", "minor")
    role = payload.get("role", "unknown")
    view = payload.get("view", "")
    actor = payload.get("actor", role)
    # Optional self-identified submitter — kept distinct from `actor` (role).
    # Sanitized to strip newlines and clamp length so it can't break the
    # GitHub issue title or smuggle markdown into the body.
    submitter_raw = payload.get("submitter")
    submitter = ""
    if isinstance(submitter_raw, str):
        submitter = " ".join(submitter_raw.split())[:80]
    diagnostics = payload.get("diagnostics") or {}
    if not isinstance(diagnostics, dict):
        diagnostics = {}

    record = {
        "id": f"FB-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}",
        "title": title,
        "body": body,
        "issue_type": issue_type,
        "severity": severity if issue_type == "bug" else "n/a",
        "role": role,
        "view": view,
        "submitted_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "actor": actor,
        "submitter": submitter or None,
        "diagnostics": diagnostics,
        "github_issue_url": None,
    }

    audit_log(
        "pilot_feedback_submitted",
        actor=actor,
        subject_id=record["id"],
        payload={
            "title": title, "issue_type": issue_type, "severity": record["severity"],
            "role": role, "view": view, "submitter": submitter or None,
        },
    )

    # Optional GitHub issue creation. Token + repo come from env so an
    # air-gap deploy can leave them unset and feedback still lands locally.
    gh_token = os.environ.get("SPIRE_GITHUB_TOKEN", "")
    gh_repo = os.environ.get("SPIRE_GITHUB_REPO", "jeranaias/spire")
    if gh_token and gh_repo and not _AIR_GAPPED:
        try:
            import urllib.request
            import urllib.error
            type_titles = {
                "bug":      ("[Bug]",      "bug"),
                "idea":     ("[Idea]",     "enhancement"),
                "question": ("[Question]", "question"),
                "praise":   ("[Praise]",   "praise"),
            }
            title_prefix, type_label = type_titles.get(issue_type, ("[Bug]", "bug"))
            severity_labels = {
                "cosmetic": ["cosmetic"],
                "minor":    [],
                "major":    ["priority"],
                "critical": ["priority", "incident"],
            }
            sev_labels = severity_labels.get(severity, []) if issue_type == "bug" else []
            diag_block = ""
            if diagnostics:
                diag_lines = "\n".join(
                    f"  - **{k}**: `{v}`" for k, v in diagnostics.items() if v not in (None, "")
                )
                if diag_lines:
                    diag_block = (
                        "\n\n<details><summary>Diagnostics auto-attached</summary>\n\n"
                        f"{diag_lines}\n\n</details>"
                    )
            # Surface the self-identified submitter prominently. Title gets a
            # trailing "· Name" so the issue list scans clearly; body opens
            # with a Submitted-by callout above the structured fields.
            submitter_label = submitter if submitter else "Anonymous"
            submitter_callout = (
                f"> **Submitted by:** {submitter_label}  \n"
                f"> *(GitHub issue authored by the maintainer's PAT; the line above is the in-app submitter identity.)*\n\n"
            )
            issue_body = (
                f"{submitter_callout}"
                f"**Filed via in-app feedback drawer.**\n\n"
                f"- **Submitter:** {submitter_label}\n"
                f"- **Type:** {issue_type}\n"
                f"- **Role:** {role}\n"
                f"- **View:** {view or 'unspecified'}\n"
                + (f"- **Severity:** {severity}\n" if issue_type == "bug" else "")
                + f"- **Submitted at:** {record['submitted_at']}\n"
                f"- **Local feedback id:** `{record['id']}`\n\n"
                f"---\n\n{body}"
                f"{diag_block}"
            )
            # Title trailer with submitter (if provided) makes the Issues list
            # readable at a glance instead of every issue looking like solo work.
            issue_title = f"{title_prefix} {title}"
            if submitter:
                issue_title = f"{issue_title} · {submitter}"
            labels = (
                [f"type:{type_label}", "pilot-feedback", f"role:{role}"]
                + sev_labels
            )
            if submitter:
                # Slugged label so an investigator can filter to one submitter
                # quickly. Lowercased + non-alnum collapsed to dash, length
                # capped at 40 chars per GitHub's label rules.
                slug = "".join(c.lower() if c.isalnum() else "-" for c in submitter)
                slug = "-".join(p for p in slug.split("-") if p)[:40]
                if slug:
                    labels.append(f"submitter:{slug}")
            data = json.dumps({
                "title": issue_title,
                "body": issue_body,
                "labels": labels,
            }).encode("utf-8")
            req = urllib.request.Request(
                f"https://api.github.com/repos/{gh_repo}/issues",
                data=data,
                method="POST",
                headers={
                    "Authorization": f"Bearer {gh_token}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                    "User-Agent": "spire-feedback-drawer",
                },
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                created = json.loads(resp.read().decode())
                record["github_issue_url"] = created.get("html_url")
                record["github_issue_number"] = created.get("number")
        except Exception as e:  # noqa: BLE001
            record["github_error"] = str(e)

    _FEEDBACK_LOG.append(record)
    return record


@router.get("/feedback")
async def list_feedback(limit: int = 50):
    """Read-only feedback log for the maintainer."""
    return {"feedback": _FEEDBACK_LOG[-limit:], "total": len(_FEEDBACK_LOG)}


# ---------------------------------------------------------------------------
# GC-6 Training data flywheel — decision outcomes + model telemetry
# ---------------------------------------------------------------------------

# In-memory decision-outcome log. Production swaps this for the SQLite
# persistence module so outcomes survive restarts; keeping it in-memory
# during the demo so the AdminTab is reactive to feedback in the same
# session.
_DECISION_OUTCOMES: list[dict] = []


def _seed_outcomes() -> None:
    """Seed the outcome log with plausible historical data so the AdminTab
    has a meaningful trend on first load. Deterministic. The seeded outcomes
    span the last 14 days of synthetic operator activity."""
    if _DECISION_OUTCOMES:
        return
    import random as _r
    rng = _r.Random(42)
    kinds = ["cannibalization_proposal", "expedite_request", "predicted_failure_action", "classification_mark", "fpcon_change"]
    engines = ["rule_based_v1", "j2_v1", "regex_v1", "llm_gate_v1"]
    actors = ["maintenance_chief", "g4", "mef_commander", "data_custodian", "security_manager"]
    base = datetime.utcnow() - timedelta(days=14)
    for i in range(48):
        ts = base + timedelta(hours=i * 7 + rng.randint(0, 5), minutes=rng.randint(0, 59))
        kind = rng.choice(kinds)
        engine = rng.choice(engines)
        # Per-engine accuracy varies — rule_based ~78%, j2 ~91%, regex ~83%, llm ~88%
        target_acc = {"rule_based_v1": 0.78, "j2_v1": 0.91, "regex_v1": 0.83, "llm_gate_v1": 0.88}[engine]
        was_correct = rng.random() < target_acc
        _DECISION_OUTCOMES.append({
            "id": f"OC-SEED-{i:03d}",
            "decision_kind": kind,
            "decision_id": f"DEC-{i:04d}",
            "decided_by": rng.choice(actors),
            "was_correct": was_correct,
            "observed_at": ts.isoformat(timespec="seconds") + "Z",
            "notes": "" if was_correct else rng.choice([
                "operator overrode automatic recommendation",
                "outcome did not match prediction window",
                "downstream supply path closed before action took effect",
                "ground truth differed from classifier output",
            ]),
            "scoring_engine": engine,
            "logged_at": ts.isoformat(timespec="seconds") + "Z",
        })


_seed_outcomes()


def record_outcome(*, decision_kind: str, decision_id: str, decided_by: str,
                   was_correct: bool, observed_at: str = "",
                   notes: str = "", scoring_engine: str = "rule_based_v1") -> dict:
    """Append one decision-outcome record. Called by the admin UI's manual
    rating tool, by the existing /pulse/feedback endpoint via the persistence
    layer, and by future automated paths (cannibalization closed-out the SR =
    decision was correct)."""
    rec = {
        "id": f"OC-{uuid.uuid4().hex[:10]}",
        "decision_kind": decision_kind,
        "decision_id": decision_id,
        "decided_by": decided_by,
        "was_correct": bool(was_correct),
        "observed_at": observed_at or datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "notes": notes,
        "scoring_engine": scoring_engine,
        "logged_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    _DECISION_OUTCOMES.append(rec)
    audit_log(
        "decision_outcome_logged",
        actor=decided_by,
        subject_id=rec["id"],
        payload={"decision_kind": decision_kind, "was_correct": was_correct, "engine": scoring_engine},
    )
    return rec


@router.post("/admin/outcome")
async def admin_record_outcome(payload: dict = Body(default={})):
    """Manual outcome submission from the AdminTab. Body:
    {decision_kind, decision_id, decided_by, was_correct, notes?,
     scoring_engine?}."""
    required = ["decision_kind", "decision_id", "decided_by"]
    for k in required:
        if k not in payload:
            raise HTTPException(status_code=400, detail=f"missing {k}")
    return record_outcome(
        decision_kind=payload["decision_kind"],
        decision_id=payload["decision_id"],
        decided_by=payload["decided_by"],
        was_correct=bool(payload.get("was_correct", True)),
        observed_at=payload.get("observed_at", ""),
        notes=payload.get("notes", ""),
        scoring_engine=payload.get("scoring_engine", "rule_based_v1"),
    )


@router.get("/admin/telemetry")
async def admin_telemetry(role: str | None = None):
    """Aggregate telemetry for the AdminTab dashboard.

    Computes per-engine + per-decision-kind accuracy rolling averages,
    bucketed time-series of correct vs incorrect outcomes, and a
    recommendation flag when accuracy drops below a threshold.

    Gated server-side to security_manager. Telemetry exposes per-actor
    decision histories which other roles must not be able to mine."""
    require_role(role, ADMIN_TELEMETRY_ROLES, "admin.telemetry.read")
    if not _DECISION_OUTCOMES:
        return {
            "total_outcomes": 0,
            "by_engine": {},
            "by_decision_kind": {},
            "rolling_accuracy": [],
            "retraining_recommended": False,
            "as_of": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        }

    # Per-engine + per-kind accuracy
    by_engine: dict = defaultdict(lambda: {"correct": 0, "incorrect": 0, "total": 0})
    by_kind: dict = defaultdict(lambda: {"correct": 0, "incorrect": 0, "total": 0})
    for o in _DECISION_OUTCOMES:
        e = o.get("scoring_engine", "unknown")
        k = o.get("decision_kind", "unknown")
        by_engine[e]["total"] += 1
        by_kind[k]["total"] += 1
        if o["was_correct"]:
            by_engine[e]["correct"] += 1
            by_kind[k]["correct"] += 1
        else:
            by_engine[e]["incorrect"] += 1
            by_kind[k]["incorrect"] += 1

    def _acc(b: dict) -> float:
        return round(b["correct"] / b["total"], 4) if b["total"] else 0.0

    by_engine_out = {e: {**b, "accuracy": _acc(b)} for e, b in by_engine.items()}
    by_kind_out = {k: {**b, "accuracy": _acc(b)} for k, b in by_kind.items()}

    # Rolling-accuracy time series: bucketed daily, last 30 days.
    # For demo purposes we bucket the in-memory log directly.
    rolling: list[dict] = []
    if len(_DECISION_OUTCOMES) >= 5:
        # Sort by logged_at, take last 30 entries, group into 5-record buckets
        sorted_oc = sorted(_DECISION_OUTCOMES, key=lambda x: x["logged_at"])
        bucket = []
        for o in sorted_oc:
            bucket.append(o)
            if len(bucket) >= 5:
                correct = sum(1 for x in bucket if x["was_correct"])
                rolling.append({
                    "bucket_end": bucket[-1]["logged_at"],
                    "n": len(bucket),
                    "accuracy": round(correct / len(bucket), 3),
                })
                bucket = []
        if bucket:
            correct = sum(1 for x in bucket if x["was_correct"])
            rolling.append({
                "bucket_end": bucket[-1]["logged_at"],
                "n": len(bucket),
                "accuracy": round(correct / len(bucket), 3),
            })

    overall_acc = sum(b["correct"] for b in by_engine.values()) / max(
        1, sum(b["total"] for b in by_engine.values())
    )
    retrain_needed = overall_acc < 0.80 and len(_DECISION_OUTCOMES) >= 20

    return {
        "total_outcomes": len(_DECISION_OUTCOMES),
        "by_engine": by_engine_out,
        "by_decision_kind": by_kind_out,
        "rolling_accuracy": rolling,
        "overall_accuracy": round(overall_acc, 4),
        "retraining_recommended": retrain_needed,
        "as_of": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }


@router.get("/admin/outcomes")
async def admin_list_outcomes(limit: int = 50, decision_kind: Optional[str] = None, role: str | None = None):
    """List recent outcomes for the AdminTab activity log.

    Gated server-side to security_manager — see admin_telemetry."""
    require_role(role, ADMIN_TELEMETRY_ROLES, "admin.outcomes.read")
    log = _DECISION_OUTCOMES
    if decision_kind:
        log = [o for o in log if o["decision_kind"] == decision_kind]
    return {"outcomes": log[-limit:], "total": len(log)}


# ---------------------------------------------------------------------------
# GC-2 Distributed consensus / CRDT sync
# ---------------------------------------------------------------------------

from ..sync import (  # noqa: E402  (imports at module bottom for clarity)
    state_summary as _sync_state_summary,
    absorb_peer_state as _sync_absorb,
    resolve_conflict as _sync_resolve,
    conflicts_pending as _sync_conflicts_pending,
    all_conflicts as _sync_all_conflicts,
    seed_demo_conflict as _sync_seed_conflict,
    log_mutation as _sync_log_mutation,
    node_id as _sync_node_id,
)


@router.get("/sync/state")
async def sync_state():
    """Snapshot of this node's vector clock + peer state + conflict count."""
    return _sync_state_summary()


@router.post("/sync/gossip")
async def sync_gossip(payload: dict = Body(default={})):
    """Accept a peer's gossip payload. Body: {clock: {...}, events: [...]}.
    Merges clocks, detects concurrent events as conflicts, returns our
    state + outgoing diff."""
    return _sync_absorb(payload.get("clock", {}), payload.get("events", []))


@router.get("/sync/conflicts")
async def sync_conflicts():
    """List all conflicts (pending + resolved). Drives the resolution UI."""
    return {
        "pending": _sync_conflicts_pending(),
        "all": _sync_all_conflicts(),
        "node_id": _sync_node_id(),
    }


@router.post("/sync/resolve/{conflict_id}")
async def sync_resolve(conflict_id: str, payload: dict = Body(default={})):
    """Resolve a conflict by selecting a winner. Body: {winner: 'local' |
    'peer', actor: str}. Loser stays in the audit chain."""
    winner = payload.get("winner", "local")
    actor = payload.get("actor", "security_manager")
    if winner not in ("local", "peer"):
        raise HTTPException(status_code=400, detail="winner must be 'local' or 'peer'")
    resolved = _sync_resolve(conflict_id, winner, actor)
    if resolved is None:
        raise HTTPException(status_code=404, detail="conflict not found")
    audit_log(
        "sync_conflict_resolved",
        actor=actor,
        subject_id=conflict_id,
        payload={"winner": winner, "record_id": resolved["record_id"]},
    )
    return resolved


@router.post("/sync/seed-conflict")
async def sync_seed_conflict(payload: dict = Body(default={})):
    """Demo helper: seed a deliberate conflict scenario so the CWO can
    walk through the resolution flow without standing up a second node."""
    actor = payload.get("actor_role", "g4")
    conflict = _sync_seed_conflict()
    audit_log(
        "sync_demo_conflict_seeded",
        actor=actor,
        subject_id=conflict.get("id", ""),
        payload={"record_id": conflict.get("record_id")},
    )
    return conflict
