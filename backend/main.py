"""
SPIRE FastAPI backend.

Boots the canonical dataset into memory at startup, then serves the REST
endpoints defined in docs/API.md. Designed to run on localhost:8700 behind
the Vite frontend proxy at localhost:5173 -> /api.

Run:
    uvicorn backend.main:app --host 127.0.0.1 --port 8700 --reload
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .state import load_dataset
from .network_monitor import install as install_netmon
from .model_hooks import STATE as MODEL_STATE

from .auth import router as auth_router
from .routes.system import router as system_router
from .routes.pulse import router as pulse_router
from .routes.sentry import router as sentry_router
from .routes.bastion import router as bastion_router
from .routes.llm import router as llm_router
from .routes.copilot import router as copilot_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Install outbound-network monitor before anything else opens a socket
    install_netmon()
    print("[SPIRE] Network egress monitor armed.")

    # Generate the canonical dataset once at boot. ~30-60 seconds.
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
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router,   prefix="/api/auth",   tags=["auth"])
app.include_router(system_router, prefix="/api/system", tags=["system"])
app.include_router(pulse_router,  prefix="/api/pulse",  tags=["pulse"])
app.include_router(sentry_router, prefix="/api/sentry", tags=["sentry"])
app.include_router(bastion_router, prefix="/api/bastion", tags=["bastion"])
app.include_router(llm_router,    prefix="/api/llm",    tags=["llm"])
app.include_router(copilot_router, prefix="/api/copilot", tags=["copilot"])


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
