"""
SPIRE FastAPI backend.

Boots the canonical dataset into memory at startup, then serves the REST
endpoints defined in docs/API.md. Designed to run on localhost:8700 behind
the Vite frontend proxy at localhost:5173 -> /api.

Run:
    uvicorn backend.main:app --host 127.0.0.1 --port 8700 --reload
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .state import init_empty_dataset, load_dataset
from .network_monitor import install as install_netmon
from .model_hooks import STATE as MODEL_STATE

from .auth import router as auth_router, session_middleware
from .routes.system import router as system_router
from .routes.pulse import router as pulse_router
from .routes.sentry import router as sentry_router
from .routes.bastion import router as bastion_router
from .routes.llm import router as llm_router
from .routes.copilot import router as copilot_router
from .routes.integrations import router as integrations_router
from .routes.gcss import router as gcss_router
from .routes.gcss_export import router as gcss_export_router
from .routes.joint import router as joint_router
from .routes.decision_bridge import router as decision_bridge_router
from .routes.stage_ingest import router as stage_ingest_router
from .routes.ingest import router as ingest_router
from .routes.uis import router as uis_router
from .routes.channels import router as uis_channels_router
from .scoping import (
    ALL_OPS_ROLES,
    BASTION_VIEW_ROLES,
    PULSE_VIEW_ROLES,
    require_view_scope,
)


def _truthy_env(name: str) -> bool:
    """Read a boolean-shaped env var. Treat 1 / true / yes / on as True."""
    raw = (os.environ.get(name) or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Install outbound-network monitor before anything else opens a socket
    install_netmon()
    print("[SPIRE] Network egress monitor armed.")

    # Task #183 — stage live-ingest mode. When SPIRE_BOOT_EMPTY=1 the
    # demo presenter wants a blank-slate boot: no synthetic seed-42
    # data, every dashboard renders the "awaiting GCSS-MC ingest" empty
    # state until the three-CSV sanitized export gets dropped on the
    # DECISION BRIDGE hero card. Default behaviour (no flag) is the
    # existing seed-42 boot — local dev and the SENTRY upload→batch
    # path stay untouched.
    if _truthy_env("SPIRE_BOOT_EMPTY"):
        init_empty_dataset()
        print("[SPIRE] Blank-slate boot — awaiting stage ingest.")
        print("[SPIRE]   POST /api/system/stage-ingest with the 3 GCSS-MC CSVs to hydrate.")
    else:
        print("[SPIRE] Generating canonical dataset under seed 42 ...")
        ds = load_dataset()
        print(f"[SPIRE]   {len(ds.units)} units, {len(ds.assets)} assets")
        print(f"[SPIRE]   {len(ds.srs):,} SRs, {len(ds.snapshots):,} snapshots, {len(ds.reqs):,} requisitions")
        print(f"[SPIRE]   {len(ds.incidents)} incidents, {len(ds.cannib_events)} cannib events")
        err = sum(1 for v in ds.violations if v.severity == "error")
        warn = len(ds.violations) - err
        print(f"[SPIRE]   consistency: {err} errors, {warn} warnings")

    ms = MODEL_STATE.status()
    print(f"[SPIRE] Models: sentry_loaded={ms['sentry_loaded']} pulse_loaded={ms['pulse_loaded']}")
    if ms["errors"]:
        for e in ms["errors"]:
            print(f"[SPIRE]   model load: {e}")

    # UIS-P6.6+ — opt-in scheduled backups. Stays dormant unless
    # SPIRE_BACKUP_SCHEDULE_HOURS is set in the environment, so
    # local dev and the demo presenter never see a surprise
    # backup task. Operators set the env var (and optionally
    # SPIRE_BACKUP_KEEP_COUNT / SPIRE_BACKUP_KEEP_DAYS) to enable.
    from .uis.dr_scheduler import start_scheduler, stop_scheduler
    scheduler_task = start_scheduler()
    if scheduler_task is not None:
        print("[SPIRE] DR scheduler armed.")

    # Warm the /status SWR cache in the background so the first page load
    # doesn't pay the LLM-probe + torch-import cost on its critical path.
    async def _warm_status() -> None:
        try:
            from .routes.system import _refresh_status
            await _refresh_status()
            print("[SPIRE] status cache warm.")
        except Exception as e:  # noqa: BLE001
            print(f"[SPIRE] status warm-up skipped: {e}")
    asyncio.create_task(_warm_status())

    # Warm the fleet-wide risk scoring in a worker thread. score_all() is
    # ~11M ops and feeds top_risk / recommend-actions / the risk board /
    # forecast; cold, the first page load pays it on the critical path and
    # — being synchronous — freezes the event loop for seconds on the cloud
    # box, cascading every other request. Compute it once off-loop at boot so
    # those endpoints are served from the score_all cache and never block.
    async def _warm_scoring() -> None:
        try:
            from .scoring import score_all
            from .state import get_dataset
            await asyncio.to_thread(score_all, get_dataset())
            print("[SPIRE] fleet scoring warm.")
        except Exception as e:  # noqa: BLE001
            print(f"[SPIRE] scoring warm-up skipped: {e}")
    asyncio.create_task(_warm_scoring())

    print("[SPIRE] Ready.")
    try:
        yield
    finally:
        await stop_scheduler()


app = FastAPI(
    title="SPIRE Backend",
    description="Sanitization, Prediction, Intelligence, Readiness Engine",
    version="0.1.0",
    lifespan=lifespan,
)

# Production serves the SPA same-origin (no CORS needed). Dev runs the Vite
# server on a separate port, so we allow an explicit dev-origin allowlist —
# never a wildcard. Override with SPIRE_CORS_ORIGINS (comma-separated).
_CORS_ORIGINS = [
    o.strip()
    for o in os.environ.get(
        "SPIRE_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session middleware — hydrates request.state.user from the signed cookie
# and rejects unauthenticated /api/* (except /api/auth/*) with 401.
# Registered before routers so it wraps every request.
app.middleware("http")(session_middleware)

# UIS-P6.2 — STIG-friendly security headers + FIPS-mode self-check.
# Self-check runs at import time so a misconfigured FIPS deployment
# fails before serving traffic. Headers middleware stamps every
# response with HSTS / X-Frame-Options / CSP / etc.
from . import security_posture  # noqa: E402
security_posture.assert_fips_safe_config()
_security_headers = security_posture.security_headers_middleware_factory()
if _security_headers is not None:
    app.middleware("http")(_security_headers)

app.include_router(auth_router,   prefix="/api/auth",   tags=["auth"])
app.include_router(system_router, prefix="/api/system", tags=["system"])
# Stage live-ingest mode (Task #183). Mounted under /api/system so the
# stage-ingest + dataset-status surfaces are siblings of the existing
# /api/system/admin/reset-demo failsafe used by Shift+F8.
app.include_router(stage_ingest_router, prefix="/api/system", tags=["stage-ingest"])

# View-level role gates (Task #77). Mounted at the router include so every
# route under the prefix is gated without per-handler edits. Mirrors
# `VIEW_SCOPE` in `frontend/src/state/store.ts`; drift is caught by
# `backend/tests/test_role_gates.py`. SENTRY-wide and Admin-wide gates
# are not applied as include-level deps because those routers carry
# routes whose role permissions vary by endpoint (per-route `require_role`
# already covers them); the broad PULSE / BASTION surfaces have uniform
# view-level role lists, so the cleanest enforcement is here.
app.include_router(
    pulse_router,
    prefix="/api/pulse",
    tags=["pulse"],
    dependencies=[Depends(require_view_scope("/pulse", PULSE_VIEW_ROLES))],
)
app.include_router(sentry_router, prefix="/api/sentry", tags=["sentry"])
app.include_router(
    bastion_router,
    prefix="/api/bastion",
    tags=["bastion"],
    dependencies=[Depends(require_view_scope("/bastion", BASTION_VIEW_ROLES))],
)
# Cross-cutting operator surfaces — default-deny at the include so an unknown /
# absent role is refused. Any signed-in operator role legitimately uses these
# (SPIRO/LLM, GCSS schema, the Decision Bridge home view); sensitive sub-routes
# (e.g. decision-bridge/audit) carry their own tighter per-route gate.
app.include_router(
    llm_router, prefix="/api/llm", tags=["llm"],
    dependencies=[Depends(require_view_scope("/llm", ALL_OPS_ROLES))],
)
app.include_router(
    copilot_router, prefix="/api/copilot", tags=["copilot"],
    dependencies=[Depends(require_view_scope("/copilot", ALL_OPS_ROLES))],
)
app.include_router(
    integrations_router, prefix="/api/integrations", tags=["integrations"],
    dependencies=[Depends(require_view_scope("/integrations", ALL_OPS_ROLES))],
)
app.include_router(
    gcss_router, prefix="/api/gcss", tags=["gcss"],
    dependencies=[Depends(require_view_scope("/gcss", ALL_OPS_ROLES))],
)
app.include_router(gcss_export_router, prefix="/api/gcss/export", tags=["gcss-export"])
app.include_router(gcss_export_router, prefix="/api/integrations/gcss-mc/export", tags=["gcss-export"])
app.include_router(joint_router,  prefix="/api/joint",  tags=["joint"])
app.include_router(
    decision_bridge_router, prefix="/api/decision-bridge", tags=["decision-bridge"],
    dependencies=[Depends(require_view_scope("/decision-bridge", ALL_OPS_ROLES))],
)
# RD-track real-data ingest (ECP / SR-header / utilization / …).
# Router itself ships dormant: every write endpoint returns 503 unless
# SPIRE_INGEST_ENABLED=1 in the environment. The /status probe is open
# so the frontend can render the right affordance without 503-ing.
app.include_router(ingest_router, prefix="/api/ingest", tags=["ingest"])
# UIS — generic Universal Ingest Service routes (adapters, upload,
# map proposal, mapping-profile CRUD). Same feature flag + RBAC as
# /api/ingest/*. The legacy adapter-specific routes stay live for
# backwards compat; new UI flows target /api/uis/*.
app.include_router(uis_router, prefix="/api/uis", tags=["uis"])
app.include_router(uis_channels_router, prefix="/api/uis/channels", tags=["uis-channels"])


# Serve the built frontend bundle at /. Assets land at /assets/*, index.html
# at /. Deep HashRouter links (/#/pulse etc) never hit the server so no SPA
# fallback is needed for client-side routing.
_FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _FRONTEND_DIST.exists():
    app.mount("/assets", StaticFiles(directory=_FRONTEND_DIST / "assets"), name="assets")

    @app.get("/")
    async def _serve_root():
        return FileResponse(_FRONTEND_DIST / "index.html")

    @app.get("/favicon.svg")
    async def _serve_favicon():
        favicon = _FRONTEND_DIST / "favicon.svg"
        if favicon.exists():
            return FileResponse(favicon)
        return JSONResponse({"error": "no favicon"}, status_code=404)


_log = logging.getLogger("spire")


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc: Exception):
    # Log the full detail server-side; return a generic body + a correlation id
    # so an operator can find the log line without leaking the exception text,
    # stack, or internal paths to the client.
    correlation_id = uuid.uuid4().hex[:12]
    _log.exception("unhandled exception [%s] on %s", correlation_id, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "error": "internal_error",
            "detail": "An unexpected error occurred.",
            "correlation_id": correlation_id,
        },
    )
