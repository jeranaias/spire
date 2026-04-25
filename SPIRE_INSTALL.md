# SPIRE — Install Guide

You are five steps from a running SPIRE instance on a laptop. This is the
guide a CWO + 2 SSgts can follow without help. If a step fails, file a bug
via `Report Issue` in-app or open one in the SPIRE GitHub repo.

## What you'll need
- A laptop with **Docker Desktop** (Windows / macOS) or **Docker Engine**
  (Linux). 8 GB RAM, 5 GB free disk.
- A web browser (Edge, Chrome, Firefox).
- Network access for the first build (~600 MB of base images). After that,
  SPIRE runs fully offline.

## Step 1 — Clone (or copy) the repo
```
git clone https://github.com/jeranaias/spire.git
cd spire
```
Or unzip the source bundle from a USB if you're on an air-gap network.

## Step 2 — Build + start the system
```
docker compose up -d --build
```
First build takes ~3 minutes. Subsequent starts are instant.

You'll see two containers come up: `spire-backend` (FastAPI + canonical
dataset engine) and `spire-frontend` (nginx serving the React UI).

## Step 3 — Open the app
Browse to **http://localhost:8080**.

You should see the SPIRE TopBar with the obelisk mark, three tabs
(SENTRY · PULSE · BASTION), and the classification banner pinned at the
top reading `UNCLASSIFIED // SYNTHETIC DATA // FOR DEMONSTRATION ONLY`.

## Step 4 — Pick your operator role
Click the operator chip in the top right. Choose:
- **Maintenance Chief (CLB-6)** — start here if you run a motor pool.
- **G-4 (2d MLG)** — start here if you're at staff level.
- **MEF Commander** — start here if you want the COP overview.
- **Data Custodian** — start here if you handle classification + release.
- **Security Manager** — start here if you handle FPCON, ECPs, audit.

Each role lands on its appropriate home view automatically. SPIRE
enforces role-based access at the UI and API layers — when you switch
roles, views you can't see render an "Out of Scope" overlay.

## Step 5 — Try the demo paths
Three demo arcs we recommend the first time:

1. **PULSE Forecast → Recommend Action** (G-4 perspective)
   Open PULSE → Forecast. Note the Monte Carlo projection with TODAY
   reference line + p10/p90 envelope + cross-probability readout. Below
   the chart is the Recommend Actions panel: top at-risk assets with
   ranked options (cannibalize / expedite / cross-level). Click Approve
   on one — it lands a downstream artifact and writes to the audit chain.

2. **SENTRY Coalition → Generate Release Package** (Data Custodian)
   Open SENTRY → Coalition. Pick a partner (FVEY, JPN, AUS, PHL). Watch
   the live preview re-scope: which units are in/out, sample SR records
   redacted in real time. Click Generate Release Package to log a
   release event to the audit chain.

3. **BASTION → Simulate ThermalHawk** (MEF Commander or Security Manager)
   Open BASTION. Click "Simulate ThermalHawk" in the alert sidebar.
   Watch the map fly to CLB-6 motor pool, cordon rings drop, target
   reticle spin, QRF dot animate from TOC-MAIN. The classification
   banner FPCON indicator escalates BRAVO → CHARLIE for the duration.
   Open the response checklist on the right and walk through it; the
   tasks shown are filtered by your operator role.

## Verify install
With everything up, run:
```
curl http://localhost:8080/api/system/status | jq .dataset
```
You should see something like:
```
{
  "seed": 42,
  "units": 10,
  "assets": 350,
  "srs": 6332,
  "...": "..."
}
```
That's the canonical synthetic dataset — deterministic, regenerated from
seed 42 on every start. Reset it any time with:
```
docker compose down -v && docker compose up -d
```
(`-v` wipes the named volume so you start clean.)

## Where state lives
- **App data**: a Docker named volume (`spire-runtime`) holds the SQLite
  audit chain + operator feedback + air-gap queue. Persists across
  restarts.
- **Logs**: `docker compose logs -f` streams both containers.
- **No cloud**: SPIRE is local-first. The status footer ticker shows
  `NETWORK 0 egress` continuously — that's a deliberate trust signal.

## Updating
```
git pull
docker compose up -d --build
```

## Air-gap deployment
1. On an internet-connected machine: `docker compose build` then
   `docker save spire-backend:latest spire-frontend:latest -o spire.tar`.
2. Move `spire.tar` + `docker-compose.yml` to the destination via your
   approved transfer path.
3. On the receive side: `docker load -i spire.tar` then
   `docker compose up -d` (use `compose.yml` with `image:` directives
   instead of `build:` — see the example in `docs/AIR_GAP_DEPLOY.md`).

## Reporting bugs
Click the floating **Report Issue** button (bottom-right corner) inside
the app. The form pre-fills your role + view + screenshot, and submits
to GitHub via the `/api/feedback` endpoint. Your CWO can review what
the team has filed at https://github.com/jeranaias/spire/issues.

## Getting help
- `?` key opens the keyboard shortcut overlay anywhere in the app.
- `docs/USER_GUIDE.md` walks through every role's daily flow.
- `docs/RUNBOOK.md` covers troubleshooting (logs location, reset, etc.).
- Open a GitHub Discussion at https://github.com/jeranaias/spire/discussions
  for "is this thing supposed to do X?" questions.
