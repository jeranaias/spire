"""Channel CRUD + on-demand poll routes.

Mounted at ``/api/uis/channels`` (sibling of /api/uis/upload).
Operator manages pull-mode ingestion channels here.

Surfaces:
  GET    /api/uis/channels                   list configs
  POST   /api/uis/channels                   create
  GET    /api/uis/channels/{id}              fetch one
  PUT    /api/uis/channels/{id}              update
  DELETE /api/uis/channels/{id}              remove
  GET    /api/uis/channels/{id}/health       channel health snapshot
  POST   /api/uis/channels/{id}/poll         trigger a poll cycle now

All gated on SPIRE_INGEST_ENABLED + INGEST_ROLES (data_custodian /
security_manager) — same as the upload + map endpoints.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request

from ..persistence import log as audit_log
from ..scoping import require_user_role
from ..uis.adapters import ADAPTERS, get_adapter
from ..uis.channels import (
    PollResult,
    poll_channel,
    register_channel,
    set_audit_func,
    unregister_channel,
)
from ..uis.channels.store import (
    ChannelConfig,
    build_channel,
    create_channel_config,
    delete_channel_config,
    get_channel_config,
    list_channel_configs,
    update_channel_config,
)


log = logging.getLogger(__name__)

router = APIRouter()

INGEST_ROLES = frozenset({"data_custodian", "security_manager"})


# Wire the runner's audit hook to the persistence audit-chain at
# import time. Tests override via channels.set_audit_func.
set_audit_func(audit_log)


def _ingest_enabled() -> bool:
    return (os.environ.get("SPIRE_INGEST_ENABLED", "") or "").strip().lower() in {
        "1", "true", "yes", "on",
    }


def _require_ingest_enabled():
    if not _ingest_enabled():
        raise HTTPException(
            status_code=503,
            detail="UIS is disabled. Set SPIRE_INGEST_ENABLED=1 and restart.",
        )


def _config_to_dict(cfg: ChannelConfig) -> dict:
    return {
        "channel_id": cfg.channel_id,
        "channel_type": cfg.channel_type,
        "adapter_id": cfg.adapter_id,
        "config": dict(cfg.config),
        "enabled": cfg.enabled,
        "poll_interval_seconds": cfg.poll_interval_seconds,
        "created_at": cfg.created_at,
        "updated_at": cfg.updated_at,
    }


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


SUPPORTED_TYPES = {"filesystem", "sftp", "imap", "http_poll", "db_cdc", "kafka"}

# Required keys per channel type. Validation up front so a malformed
# config doesn't surface as an obscure crash three days later when
# the scheduler first hits it.
REQUIRED_CONFIG_KEYS = {
    "filesystem": {"root"},
    "sftp": {"host", "username", "base_path"},
    "imap": {"host", "username", "password_env"},
    "http_poll": {"url"},
    "db_cdc": {"dialect"},
    "kafka": {"bootstrap_servers", "topic", "group_id"},
}


def _validate_channel_payload(payload: dict) -> None:
    channel_id = (payload.get("channel_id") or "").strip()
    if not channel_id:
        raise HTTPException(status_code=400, detail="channel_id is required")
    channel_type = (payload.get("channel_type") or "").strip()
    if channel_type not in SUPPORTED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"channel_type must be one of {sorted(SUPPORTED_TYPES)}; got {channel_type!r}",
        )
    adapter_id = (payload.get("adapter_id") or "").strip()
    if not adapter_id:
        raise HTTPException(status_code=400, detail="adapter_id is required")
    try:
        get_adapter(adapter_id)
    except KeyError:
        raise HTTPException(
            status_code=400,
            detail=f"adapter_id {adapter_id!r} not registered. Known: {sorted(ADAPTERS.keys())}",
        )
    config = payload.get("config") or {}
    if not isinstance(config, dict):
        raise HTTPException(status_code=400, detail="config must be a dict")
    missing = REQUIRED_CONFIG_KEYS[channel_type] - set(config.keys())
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"config missing required keys for {channel_type}: {sorted(missing)}",
        )
    # Belt-and-suspenders secret check — reject if a literal password
    # field made it through (operator probably meant password_env).
    forbidden = {"password", "passphrase", "secret"}
    leaked = forbidden & set(config.keys())
    if leaked:
        raise HTTPException(
            status_code=400,
            detail=(
                f"config carries secret-shaped keys {sorted(leaked)} — "
                "use *_env keys (password_env, key_passphrase_env) so the "
                "actual secret stays out of the database."
            ),
        )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("")
async def list_channels_endpoint(request: Request):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action="uis.channels.list")
    cfgs = list_channel_configs()
    return {"channels": [_config_to_dict(c) for c in cfgs]}


@router.post("")
async def create_channel_endpoint(request: Request, payload: dict = Body(...)):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(user, INGEST_ROLES, action="uis.channels.create")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

    _validate_channel_payload(payload)

    cfg = ChannelConfig(
        channel_id=payload["channel_id"].strip(),
        channel_type=payload["channel_type"].strip(),
        adapter_id=payload["adapter_id"].strip(),
        config=dict(payload.get("config") or {}),
        enabled=bool(payload.get("enabled", True)),
        poll_interval_seconds=int(payload.get("poll_interval_seconds", 300)),
    )
    if cfg.poll_interval_seconds < 1:
        raise HTTPException(
            status_code=400, detail="poll_interval_seconds must be >= 1",
        )

    # Try to construct the channel before persisting — surfaces
    # config errors at create-time rather than at next poll.
    try:
        channel = build_channel(cfg)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(
            status_code=400,
            detail=f"channel construction failed: {e}",
        )

    try:
        create_channel_config(cfg)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=409, detail=f"could not save: {e}")

    # Register in the in-process channel registry so the runner can
    # find it without re-reading SQLite every poll.
    register_channel(channel)

    audit_log(
        kind="uis.channels.create",
        actor=actor_dodid or actor_role or "system",
        subject_id=cfg.channel_id,
        payload={
            "channel_type": cfg.channel_type,
            "adapter_id": cfg.adapter_id,
            "enabled": cfg.enabled,
            "poll_interval_seconds": cfg.poll_interval_seconds,
        },
    )
    return _config_to_dict(cfg)


@router.get("/{channel_id:path}/health")
async def channel_health_endpoint_alt(channel_id: str, request: Request):
    """Channel health snapshot. Route ordering note: registered
    before the generic GET /{channel_id:path} so the :path matcher
    doesn't swallow the /health suffix."""
    return await _channel_health_impl(channel_id, request)


@router.post("/{channel_id:path}/poll")
async def poll_channel_endpoint_alt(channel_id: str, request: Request):
    """On-demand poll. Same ordering note."""
    return await _poll_channel_impl(channel_id, request)


@router.post("/{channel_id:path}/circuit/reset")
async def channel_circuit_reset_endpoint(channel_id: str, request: Request):
    """Manually reset a tripped circuit breaker. Operator action
    after verifying the upstream issue is resolved."""
    return await _channel_circuit_reset_impl(channel_id, request)


@router.get("/{channel_id:path}/dlq")
async def channel_dlq_list_endpoint(channel_id: str, request: Request):
    """List quarantined files for a channel."""
    return await _channel_dlq_list_impl(channel_id, request)


@router.post("/{channel_id:path}/dlq/{filename:path}/replay")
async def channel_dlq_replay_endpoint(
    channel_id: str, filename: str, request: Request,
):
    """Move a quarantined file back into incoming/ for re-processing."""
    return await _channel_dlq_replay_impl(channel_id, filename, request)


@router.post("/{channel_id:path}/dlq/{filename:path}/discard")
async def channel_dlq_discard_endpoint(
    channel_id: str, filename: str, request: Request,
):
    """Permanently delete a quarantined file. Audit chain captures."""
    return await _channel_dlq_discard_impl(channel_id, filename, request)


@router.get("/{channel_id:path}")
async def get_channel_endpoint(channel_id: str, request: Request):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action=f"uis.channels.get:{channel_id}")
    cfg = get_channel_config(channel_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"channel {channel_id!r} not found")
    return _config_to_dict(cfg)


@router.put("/{channel_id:path}")
async def update_channel_endpoint(
    channel_id: str, request: Request, payload: dict = Body(...),
):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(user, INGEST_ROLES, action=f"uis.channels.update:{channel_id}")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

    existing = get_channel_config(channel_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"channel {channel_id!r} not found")

    # PUT replaces; require the full shape.
    payload.setdefault("channel_id", channel_id)
    _validate_channel_payload(payload)

    cfg = ChannelConfig(
        channel_id=payload["channel_id"].strip(),
        channel_type=payload["channel_type"].strip(),
        adapter_id=payload["adapter_id"].strip(),
        config=dict(payload.get("config") or {}),
        enabled=bool(payload.get("enabled", True)),
        poll_interval_seconds=int(payload.get("poll_interval_seconds", existing.poll_interval_seconds)),
        created_at=existing.created_at,
    )
    if cfg.poll_interval_seconds < 1:
        raise HTTPException(
            status_code=400, detail="poll_interval_seconds must be >= 1",
        )
    try:
        channel = build_channel(cfg)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"channel construction failed: {e}")

    update_channel_config(cfg)
    register_channel(channel)  # replace in the live registry

    audit_log(
        kind="uis.channels.update",
        actor=actor_dodid or actor_role or "system",
        subject_id=cfg.channel_id,
        payload={"enabled": cfg.enabled, "channel_type": cfg.channel_type},
    )
    return _config_to_dict(cfg)


@router.delete("/{channel_id:path}")
async def delete_channel_endpoint(channel_id: str, request: Request):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(user, INGEST_ROLES, action=f"uis.channels.delete:{channel_id}")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None
    if not delete_channel_config(channel_id):
        raise HTTPException(status_code=404, detail=f"channel {channel_id!r} not found")
    unregister_channel(channel_id)
    audit_log(
        kind="uis.channels.delete",
        actor=actor_dodid or actor_role or "system",
        subject_id=channel_id,
    )
    return {"deleted": True, "channel_id": channel_id}


async def _channel_circuit_reset_impl(channel_id: str, request: Request):
    """Operator-driven manual reset of a tripped circuit breaker.

    After verifying the upstream issue is resolved (e.g. the SFTP
    server is back online, the IMAP credentials were rotated), the
    operator hits this to clear failure counts and re-enable
    polling. Without this, the breaker would re-trial after its
    cooldown automatically; manual reset is for cases where the
    operator knows the upstream is fixed and doesn't want to wait.
    """
    from ..uis.channels.resilience import reset_breaker, get_breaker
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(
        user, INGEST_ROLES, action=f"uis.channels.circuit.reset:{channel_id}",
    )
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None
    cfg = get_channel_config(channel_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"channel {channel_id!r} not found")
    reset_breaker(channel_id)
    audit_log(
        kind="uis.channels.circuit.reset",
        actor=actor_dodid or actor_role or "system",
        subject_id=channel_id,
        payload={"snapshot_after_reset": get_breaker(channel_id).snapshot()},
    )
    return {"channel_id": channel_id, "circuit": get_breaker(channel_id).snapshot()}


async def _channel_dlq_list_impl(channel_id: str, request: Request):
    """List quarantined files for a channel.

    Filesystem channel: read quarantine/ directory. Other channels
    return an empty list for now (SFTP quarantine state lives on
    the remote server; IMAP quarantine state lives in a labeled
    folder — both queryable from their respective health endpoints).
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action=f"uis.channels.dlq.list:{channel_id}")
    cfg = get_channel_config(channel_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"channel {channel_id!r} not found")
    items = _list_dlq_items(cfg)
    return {"channel_id": channel_id, "items": items}


async def _channel_dlq_replay_impl(channel_id: str, filename: str, request: Request):
    """Move a quarantined file back into incoming/ so the next
    poll cycle picks it up. Operator presumably fixed the upstream
    issue (re-extracted the file, deduped headers, etc.).

    Filesystem channel only — SFTP/IMAP replay requires server-side
    move which is channel-type specific (deferred).
    """
    from ..uis.channels.filesystem import FilesystemChannel
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(
        user, INGEST_ROLES, action=f"uis.channels.dlq.replay:{channel_id}",
    )
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None
    cfg = get_channel_config(channel_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"channel {channel_id!r} not found")
    if cfg.channel_type != "filesystem":
        raise HTTPException(
            status_code=501,
            detail=(
                f"DLQ replay not yet supported for channel_type={cfg.channel_type!r}. "
                "Filesystem channel only at this revision."
            ),
        )
    from pathlib import Path
    root = Path(cfg.config["root"])
    src = root / "quarantine" / filename
    if not src.is_file():
        raise HTTPException(status_code=404, detail=f"quarantined file {filename!r} not found")
    incoming = root / "incoming"
    incoming.mkdir(parents=True, exist_ok=True)
    target = incoming / filename
    if target.exists():
        raise HTTPException(
            status_code=409,
            detail=f"a file named {filename!r} is already in incoming/; rename or delete first",
        )
    src.rename(target)
    # Also remove the sidecar reason file if present
    sidecar = src.with_suffix(src.suffix + ".reason.txt")
    if sidecar.exists():
        sidecar.unlink()
    audit_log(
        kind="uis.channels.dlq.replay",
        actor=actor_dodid or actor_role or "system",
        subject_id=channel_id,
        payload={"filename": filename},
    )
    return {"channel_id": channel_id, "replayed": filename}


async def _channel_dlq_discard_impl(channel_id: str, filename: str, request: Request):
    """Permanently delete a quarantined file. Audit chain
    captures the discard so an operator review can reconstruct
    why a file was removed."""
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(
        user, INGEST_ROLES, action=f"uis.channels.dlq.discard:{channel_id}",
    )
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None
    cfg = get_channel_config(channel_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"channel {channel_id!r} not found")
    if cfg.channel_type != "filesystem":
        raise HTTPException(
            status_code=501,
            detail=(
                f"DLQ discard not yet supported for channel_type={cfg.channel_type!r}. "
                "Filesystem channel only at this revision."
            ),
        )
    from pathlib import Path
    root = Path(cfg.config["root"])
    src = root / "quarantine" / filename
    if not src.is_file():
        raise HTTPException(status_code=404, detail=f"quarantined file {filename!r} not found")
    sidecar = src.with_suffix(src.suffix + ".reason.txt")
    src.unlink()
    if sidecar.exists():
        sidecar.unlink()
    audit_log(
        kind="uis.channels.dlq.discard",
        actor=actor_dodid or actor_role or "system",
        subject_id=channel_id,
        payload={"filename": filename},
    )
    return {"channel_id": channel_id, "discarded": filename}


def _list_dlq_items(cfg: ChannelConfig):
    if cfg.channel_type != "filesystem":
        return []
    from pathlib import Path
    root = Path(cfg.config.get("root", ""))
    qdir = root / "quarantine"
    if not qdir.exists():
        return []
    items = []
    for p in sorted(qdir.iterdir()):
        if not p.is_file():
            continue
        if p.suffix == ".txt" and p.name.endswith(".reason.txt"):
            continue
        sidecar = p.with_suffix(p.suffix + ".reason.txt")
        reason = ""
        if sidecar.exists():
            try:
                reason = sidecar.read_text(encoding="utf-8").strip()
            except OSError:
                reason = "<sidecar unreadable>"
        try:
            stat = p.stat()
        except OSError:
            continue
        items.append({
            "filename": p.name,
            "size_bytes": stat.st_size,
            "quarantined_at": datetime.fromtimestamp(
                stat.st_mtime, tz=timezone.utc,
            ).isoformat(),
            "reason": reason,
        })
    return items


async def _channel_health_impl(channel_id: str, request: Request):
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    require_user_role(user, INGEST_ROLES, action=f"uis.channels.health:{channel_id}")
    cfg = get_channel_config(channel_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"channel {channel_id!r} not found")
    try:
        channel = build_channel(cfg)
        h = channel.health()
        return {
            "channel_id": h.channel_id,
            "channel_type": h.channel_type,
            "reachable": h.reachable,
            "pending_count": h.pending_count,
            "last_polled_at": h.last_polled_at,
            "last_success_at": h.last_success_at,
            "last_error": h.last_error,
            "consecutive_failures": h.consecutive_failures,
            "circuit_open": h.circuit_open,
            "extra": h.extra,
        }
    except Exception as e:  # noqa: BLE001
        return {
            "channel_id": channel_id,
            "channel_type": cfg.channel_type,
            "reachable": False,
            "last_error": f"channel_construction_failed: {e}",
        }


async def _poll_channel_impl(channel_id: str, request: Request):
    """Trigger an immediate poll cycle on a channel.

    Synchronous — caller waits for the cycle to complete. For long
    backlogs, the response carries the per-file outcomes so the
    operator can see exactly what landed where.
    """
    _require_ingest_enabled()
    user = getattr(request.state, "user", None)
    actor_role = require_user_role(user, INGEST_ROLES, action=f"uis.channels.poll:{channel_id}")
    actor_dodid = (user or {}).get("dodid") if isinstance(user, dict) else None

    cfg = get_channel_config(channel_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"channel {channel_id!r} not found")
    if not cfg.enabled:
        raise HTTPException(status_code=409, detail=f"channel {channel_id!r} is disabled")

    try:
        channel = build_channel(cfg)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"channel construction failed: {e}")

    actor = actor_dodid or actor_role or "manual-poll"
    result: PollResult = poll_channel(channel, actor=actor)

    return {
        "channel_id": result.channel_id,
        "started_at": result.started_at,
        "finished_at": result.finished_at,
        "duration_ms": result.duration_ms,
        "pending_count": result.pending_count,
        "counts": result.counts(),
        "files": [
            {
                "filename": fr.filename,
                "status": fr.status,
                "rows_total": fr.rows_total,
                "rows_kept": fr.rows_kept,
                "bytes_read": fr.bytes_read,
                "sha256": fr.file_sha256,
                "diff_counts": dict(fr.diff_counts),
                "error": fr.error,
                "duration_ms": fr.duration_ms,
            }
            for fr in result.file_results
        ],
    }
