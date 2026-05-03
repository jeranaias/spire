"""
SPIRE FastAPI backend.

Boots the canonical dataset into memory at startup, then serves the REST
endpoints defined in docs/API.md. Designed to run on localhost:8700 behind
the Vite frontend proxy at localhost:5173 -> /api.

Run:
    uvicorn backend.main:app --host 127.0.0.1 --port 8700 --reload
"""
from __future__ import annotations

import os
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
from .scoping import (
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

    print("[SPIRE] Ready.")
    yield


app = FastAPI(
    title="SPIRE Backend",
    description="Sanitization, Prediction, Intelligence, Readiness Engine",
    version="0.1.0",
    lifespan=lifespan,
)

# Vite dev server + static serve in production both live on same origin in
# prod, but in dev we CORS them separately.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=".*",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session middleware — hydrates request.state.user from the signed cookie
# and rejects unauthenticated /api/* (except /api/auth/*) with 401.
# Registered before routers so it wraps every request.
app.middleware("http")(session_middleware)

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
app.include_router(llm_router,    prefix="/api/llm",    tags=["llm"])
app.include_router(copilot_router, prefix="/api/copilot", tags=["copilot"])
app.include_router(integrations_router, prefix="/api/integrations", tags=["integrations"])
app.include_router(gcss_router, prefix="/api/gcss", tags=["gcss"])
app.include_router(gcss_export_router, prefix="/api/gcss/export", tags=["gcss-export"])
app.include_router(gcss_export_router, prefix="/api/integrations/gcss-mc/export", tags=["gcss-export"])
app.include_router(joint_router,  prefix="/api/joint",  tags=["joint"])
app.include_router(decision_bridge_router, prefix="/api/decision-bridge", tags=["decision-bridge"])
# RD-track real-data ingest (ECP / SR-header / utilization / …).
# Router itself ships dormant: every write endpoint returns 503 unless
# SPIRE_INGEST_ENABLED=1 in the environment. The /status probe is open
# so the frontend can render the right affordance without 503-ing.
app.include_router(ingest_router, prefix="/api/ingest", tags=["ingest"])


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


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={
            "error": "unhandled_exception",
            "detail": str(exc),
            "path": str(request.url.path),
        },
    )
