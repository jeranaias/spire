# SPIRE — Session Handoff
_Reconstructed from the prior working session (816f64db…, last worked 2026-06-22). Point a fresh session here: "Read SESSION_HANDOFF.md and continue."_

## What SPIRE is
A locally-served, **no-cloud contested-logistics operating system** (FastAPI + React). It collapses GCSS-MC / DRRS-MC and forward sensor feeds into one **role-shaped** view, runs **offline on a backpack-portable AI device**, and has three surfaces:
- **SENTRY** — classification / sanitization + coalition release marking (CUI//FOUO//LES, DoDM 5200.01)
- **PULSE** — readiness + predictive risk forecasting (Monte Carlo, 200 paths / 14 days, p10/p50/p90)
- **BASTION** — MapLibre common operating picture (MIL-STD-2525D markers)

TRL 4 prototype; **1st place, Modern Day Marine 2026** (validated on synthetic GCSS-MC ECP/UTIL/SR-Header data). Audit log is SHA-256 hash-chained w/ Ed25519 signatures (NIST 800-53 AU-9(5)). **SPIRO** = the operator assistant that wraps **Gemma 4 E2B (quantized)** with 16 grounded tools.

## Stack / layout (`D:\projects\spire`)
- **backend/** — FastAPI. Hot files: `routes/system.py`, `routes/sentry.py`, `routes/bastion.py`, `persistence.py`, `uis/dr.py`
- **frontend/** — React + TS + Vite. Hot files: `src/views/DecisionBridge.tsx`, `src/components/OkinawaMapCanvas.tsx`, `src/views/admin/AuditView.tsx`, `src/main.tsx`, `src/App.tsx`, `src/api.ts`, `src/components/TopBar.tsx`, `src/views/pulse/FleetOverviewTab.tsx`, `src/views/sentry/ReviewQueueTab.tsx`, `src/components/HelpOverlay.tsx`, `src/index.css`
- **dataset/** — synthetic data engine (`lifecycle.py`, `data/unit_structure.json`): 10 units, 352 assets, 6,320 SRs, 128k snapshots
- **tests/**, **backend/tests/** — e.g. `test_release_compatibility.py`, `uis/test_channels_routes.py`

## Deploy / run targets
- **Live demo:** https://spire-mdm.fly.dev — a SPIRE app already exists on fly.io; update via `fly deploy`. **This is the demo surface** (online version).
- **Local showcase:** NVIDIA **Orin Nano** — the localized offline showcase. SSH `vanguard@192.168.55.1` (USB-net gadget; **drops ICMP so `ping` fails but SSH is open**; `spire_orin` key installed). Goal was "get the full baby running smooth on the Orin."
- **Model:** **Gemma 4 E2B**, quantized variant — *not* gemma 2/3.

## Where it left off (2026-06-22)
Mid **tab-by-tab polish + retheme** (theme = subtle **green glow on text/symbols**, not a green ring). Last completed fix: **SENTRY Mark Draft** top "RECOMMENDED MARKING" banner was clipping to 2px — fixed with `shrink-0`, committed + deployed.

### Open items in flight
- **Admin page 503 errors** across tabs — needs fixing
- **Audit / SOC tab** — disorganized, CUI presentation rough
- **Review Queue** (3-column sentry page) — layout cleanup
- **BASTION** — green/yellow/red status **glows around icons not showing** when clicking straight to Bastion
- **SENTRY / Sentry Mark** — needs solid example paragraphs that showcase automated classification
- **Deletions:** About + Transition pages marked to scrap

### Next
Continue tab-by-tab polish; kill the admin 503s; finish Audit-SOC + CUI cleanup; verify Bastion status glows; complete the full local Orin run. North star: a hyper-efficient, AI-assisted, universally-ingesting **one-stop shop for any role**.

## Resume the ORIGINAL session instead (full history)
```
cd /d D:\projects\spire
claude --resume 816f64db-d759-400c-8812-85749f912c18
```
