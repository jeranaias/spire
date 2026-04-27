# SPIRE

**Contested Logistics Operating System** — Marine Made.
Sanitization, Prediction, Intelligence, Readiness Engine.
Local Intelligence · No Cloud · IL5-Fit

> **Marine Made.** SPIRE itself — every surface, every workflow, every
> role-mapping — is designed and built by an active-duty Marine
> (SSgt Jesse Morgan, USMC) for the operators it's actually for.
> Built on duty time, by somebody who's been the Maint Chief filling out
> the spreadsheets — not by a contractor guessing what a Marine needs.

**Live demo**: <https://spire-mdm.fly.dev> (synthetic data, public during pilot)

---

## What this is

The Marine Corps rewrote its doctrine around **Force Design 2030** and
**Stand-in Forces**. Every credible version of that doctrine says
logistics under contested conditions is the central unresolved problem.
There is no program of record for it today. SPIRE is the operating
system for contested logistics.

One canonical dataset, role-shaped views, three operational regimes:
**steady-state garrison · pre-deployment planning · active incident
response.** The same data — surfaced through the right surface for who
you are and what's happening.

## The three views

- **SENTRY** — classification-aware data sanitization. Tier-1 regex +
  Tier-2 LLM gate clear ~70% automatically; aggregation-risk heatmap
  catches Secret-by-aggregation cases humans miss. Coalition release
  scoping for FVEY / JPN / AUS / PHL with redactions in real time.
- **PULSE** — fleet readiness + predictive risk. Real Monte Carlo
  forecast (200 forward paths, p10/p90 envelope, cross-probability),
  auto-replenishment recommendations (cannib / expedite / cross-level
  ranked by impact-per-dollar-per-day), GC-3 predicted failures with
  draftable requisitions.
- **BASTION** — Common Operating Picture. Real MapLibre vector tiles
  with MIL-STD-2525C-lite unit symbology, ECP gate glyphs, rally
  points, building polygons. ThermalHawk UAS sim with auto-correlated
  cordons + QRF dot animation. Multi-sensor threat fusion correlates
  PACS + ThermalHawk + SCADA + weather into composite threats.

## The 7 game-changers (all shipped in v1.0.0-rc1)

| # | Feature | Where to see it |
|---|---|---|
| GC-1 | Autonomous replenishment planning | PULSE → Forecast → Recommend Actions panel |
| GC-2 | Distributed consensus (CRDT) | TopBar → Node Status chip → conflict drawer |
| GC-3 | Predictive failure | PULSE → Risk Board → Predicted Failures panel |
| GC-4 | C-UAS / base-defense fusion | BASTION → alert sidebar → Fused Threats |
| GC-5 | Coalition interoperability | SENTRY → Coalition tab → partner picker |
| GC-6 | Training data flywheel | TopBar → Admin (Security Manager only) |
| GC-7 | Air-gap deployment mode | TopBar → AIR-GAP toggle |

## Five operator roles

The same data, role-shaped:

- **Maintenance Chief (CLB-6)** — motor-pool view. Their assets, their
  parts, their cannibalization options. Lands on `/pulse`.
- **G-4 (2d MLG)** — staff-level view. Three subordinate units (CLB-6,
  7th ESB, 3d Maint Bn). TMR submission, Forecast, Recommend Actions.
  Lands on `/bastion`.
- **MEF Commander** — fleet-wide COP. Air-gap toggle, classification
  banner with FPCON. Lands on `/bastion`.
- **Data Custodian** — SENTRY pipeline. Mark Draft, Export, Coalition
  release. Lands on `/sentry`.
- **Security Manager** — Admin telemetry, Audit chain, Node Status
  conflict resolution, Air-gap. Lands on `/bastion`.

Out-of-scope views render an "Out of Scope · Access Restricted" overlay
at both UI and API layers — not silent allow.

## Quick start

```
git clone https://github.com/jeranaias/spire.git
cd spire
docker compose up -d --build
open http://localhost:8080
```

Five minutes from clone to running on a laptop. See
[`SPIRE_INSTALL.md`](SPIRE_INSTALL.md) for the step-by-step + air-gap
deploy path.

## Layout

```
backend/         FastAPI + canonical dataset engine + audit chain
  routes/        SENTRY · PULSE · BASTION · System (admin/feedback/sync/comms)
  fusion.py      GC-4 multi-sensor correlation
  sync.py        GC-2 vector-clock primitives
  persistence.py SQLite + SHA-256 hash-chained audit log
  scoping.py     Role-based access control
dataset/         Synthetic dataset engine (10 units, 350 assets, 6,332 SRs)
  data/          MTBF table, replenishment rates, coalition profiles, installation map
  *.py           Engine modules (lifecycle, supply, faults, consistency, etc.)
frontend/
  src/views/     SENTRY · PULSE · BASTION · Admin
  src/components/
    MapCanvas.tsx          MapLibre BASTION map
    RecommendPanel.tsx     GC-1 ranked actions
    PredictedFailurePanel  GC-3 failure surface
    FusedThreatsPanel.tsx  GC-4 correlation chains
    CoalitionTab.tsx       GC-5 partner-scoped view (in views/sentry/)
    NodeStatus.tsx         GC-2 sync state + conflict drawer
    FeedbackDrawer.tsx     Pilot in-app issue filing
    HelpOverlay.tsx        ? key keyboard shortcut reference
    ClassificationBand.tsx FPCON-aware banner
    StatusFooter.tsx       Live telemetry ticker
docs/            ARCHITECTURE, USER_GUIDE, RUNBOOK, BUG_BASH (pilot first-week checklist)
scripts/         Playwright screenshot harness, MGRS lat/lon baker, smoke tests
.github/         Issue templates, PR template, CI workflow
Dockerfile       Backend image
docker-compose.yml  Stack definition
SPIRE_INSTALL.md    Pilot install guide
CONTRIBUTING.md     Pilot contribution path + IP scope rules
SECURITY.md         Vulnerability disclosure
CHANGELOG.md        keep-a-changelog
LICENSE.md          USMC vs Thornveil IP split
```

## IP scope (per LICENSE.md)

- **The SPIRE application** (this repository) is government work
  product, built during MDM 2026 by uniformed USMC personnel on duty
  time. Iteration with the pilot cohort (CWO + 2 SSgts initially)
  occurs on duty time.
- **Pre-existing Thornveil LLC IP** (RigRun routing, HawkStack
  architecture, ThermalHawk-Nano weights, Harakat) remains Thornveil
  property, licensed to the USG under the LICENSE terms.
- **Synthetic data** ships with the repo and contains zero real
  government data.

## Status

- v1.0.0-mvp · 2026-04-24 · pre-game-changer baseline (tagged)
- v1.0.0-rc1 · 2026-04-25 · all 7 game-changers shipped, pilot-ready
- Repo: https://github.com/jeranaias/spire (private during pilot)

## Filing issues

In-app: **Shift+F** opens the feedback drawer. Pre-fills role + view +
severity + drops a screenshot. POSTs to `/api/system/feedback` which
both audits locally AND creates a GitHub issue when `SPIRE_GITHUB_TOKEN`
is set.

GitHub: https://github.com/jeranaias/spire/issues/new/choose
(bug / feature / incident templates).

For security vulnerabilities: see [`SECURITY.md`](SECURITY.md).

## Pilot first-week walkthrough

See [`docs/BUG_BASH.md`](docs/BUG_BASH.md) — 10 scenarios designed to
expose every part of SPIRE in ~3 hours, with explicit "try to break it"
notes per scenario.

## Built for

Modern Day Marine 2026 AI Forum Hackathon · MARCORLOGCOM CDAO
Washington DC · 27-30 April 2026.
