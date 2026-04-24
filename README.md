# SPIRE

**Sanitization, Prediction, Intelligence, Readiness Engine**
Contested Logistics. Local Intelligence.

One platform, three views of the same logistics data:

- **SENTRY** — classification-aware data sanitization (HawkStack cascade → human review queue)
- **PULSE** — predictive maintenance, cannibalization, readiness forecast
- **BASTION** — geospatial COP, correlated alerts, auto-generated response checklists

Built for the MARCORLOGCOM AI Forum & Hackathon at Modern Day Marine 2026 (27–30 April).

## Layout

- `docs/SPIRE_SPEC_FINAL.md` — product + UI + demo + Q&A spec (v4)
- `dataset/DESIGN.md` — synthetic logistics dataset generation engine (11-module Python sim)
- `dataset/` — generation engine source (to build)
- `shared/`, `sentry/`, `pulse/`, `bastion/` — frontend views (to build)
- `models/` — see `models/README.md` for weight locations
- `presentation/` — demo script, Q&A cheatsheet, slides
- `LICENSE.md` — IP notice (Thornveil pre-existing IP vs. hackathon products)

## Runtime

Localhost web app: React frontend served by a local Python/Go backend. Not Electron. Airgap-compatible; the settings panel exposes placeholder ingestion connectors (GCSS-MC, LOGAIS, DRRS-MC) that signal production-readiness without requiring a network.

## Status

Scaffolded 2026-04-23. See `../../C:\Users\jesse\.claude\projects\C--Users-jesse\memory\project_spire_mdm.md` for current dependency readiness, training plan, and known gaps.
