# SPIRE — Replit Environment

SPIRE (Sanitization, Prediction, Intelligence, Readiness Engine) is a
contested-logistics operating system originally built for USMC pilots. This
file documents how the project is wired to run inside Replit.

## Stack

- **Backend** — FastAPI (Python 3.12) under `backend/`. Generates a synthetic
  canonical dataset at boot using the `dataset/` engine. Serves the REST API
  under `/api/*`. Listens on `127.0.0.1:8000` in the Replit dev environment.
- **Frontend** — React 19 + Vite 8 + TypeScript under `frontend/`. Tailwind 4,
  MapLibre, Recharts, Zustand, React Router. Vite dev server listens on
  `0.0.0.0:5000` and proxies `/api/*` to the backend.

## Workflows

- **Backend** — `python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000`
  (console output). Dataset generation takes ~30–60 seconds on cold start.
- **Frontend** — `cd frontend && npm run dev` (webview, port 5000).

## Replit-specific changes vs upstream

- `frontend/vite.config.ts` — bound to `0.0.0.0:5000`, `allowedHosts: true`
  so the Replit iframe proxy can reach it, and the dev proxy targets
  `http://localhost:8000` instead of the upstream `:8700` (port 8700 isn't
  in Replit's allowed dev port set).
- `backend/main.py` — CORS widened (`allow_origin_regex=".*"`,
  `allow_credentials=False`) so the proxied iframe origin works. The
  upstream still ships locked-down origins for the air-gap deploy.

The upstream Docker / Fly path (`Dockerfile`, `Dockerfile.web`,
`docker-compose.yml`, `fly.toml`, `deploy/`) is left alone — those still
target the original `:8700` backend / `:8080` nginx layout.

## Deployment

Replit deployment serves the built React bundle from FastAPI on port 5000.
See `frontend/dist/` (built on deploy) and the static-mount block in
`backend/main.py`.
