# Changelog

All notable changes to SPIRE go here. Format: keep-a-changelog. Date
format: YYYY-MM-DD.

## [Unreleased]

## [1.0.0-rc1] · 2026-04-25 · MDM 2026 RC

### Added
- **GC-1 Autonomous replenishment planning.** New `/pulse/recommend-actions`
  endpoint ranks cannibalize / expedite / cross-level options per asset by
  impact-per-dollar-per-day. RecommendPanel UI mounted on the PULSE
  Forecast tab. Approve buttons create downstream artifacts (cannib
  proposal, expedite request, cross-level request) and write to the
  audit chain.
- **GC-5 Coalition Interoperability.** New `/sentry/coalition/*` endpoints
  apply per-partner release profiles (FVEY_BASE, FVEY_LOG, JPN_COALITION,
  AUS_COALITION, PHL_COALITION) to the canonical dataset in real time.
  CoalitionTab UI shows live partner-scoped preview + Generate Release
  Package button that logs to the audit chain.
- **GC-7 Air-gap deployment mode.** New `/system/comms/*` endpoints expose
  comms-state timeline (CONNECTED / DEGRADED / DISCONNECTED) and the
  air-gap toggle that queues mutations locally. StatusFooter pulses
  green/amber/red; TopBar AirGapToggle (security_manager + mef_commander
  only) engages/releases. Queue replays on release with sync resolution
  log written to the audit chain.
- **Real map basemap.** MapLibre GL JS replaces the hand-drawn SVG
  schematic. CartoDB Dark Matter GL vector tiles + custom marker overlay
  + GeoJSON building polygons. Lat/lon baked into installation_data.json
  via flat-earth projection from the installation center.
- **Dataset extensions.** `dataset/replenishment.py` (GC-1 cost + lead-time
  + convoy-feasibility primitives), `dataset/coalition.py` (GC-5 release
  profiles + redaction engine), `dataset/comms.py` (GC-7 comms-state
  timeline + queued-op + sync-resolution dataclasses).
- **Pilot packaging.** Dockerfile (multi-stage backend), frontend
  Dockerfile + nginx.conf (static + API proxy), docker-compose.yml
  (volume-backed runtime). SPIRE_INSTALL.md walks through the 5-step
  install. CONTRIBUTING.md + SECURITY.md establish the pilot cohort
  contribution path.

### Changed
- TopBar role-aware home-view routing: ops roles land on /bastion;
  Maintenance Chief on /pulse; Data Custodian on /sentry.
- BASTION schematic retired in favour of MapCanvas (real map).
- Forecast endpoint output: 30-day history (was 365), real Monte Carlo
  paths (200), p10/p50/p90 percentiles, cross_probability per day.
- Cannibalization impact strings: 14-pattern pool keyed off donor
  status / fault component / days-deadlined (was 2-template ternary).
- Alert timestamps hash-jittered over the last 12 hours of last_day
  (was synchronized at 17:00).
- Active-sim TTL on `_ACTIVE_SIMS` (30 min) — replaces the duplicate-
  UAS-row pile-up.
- G-4 scoping: 7th ESB and 3d Maint Bn reparented under 2d MLG so the
  scoped query returns 3 units (was 1).

### Fixed
- BASTION schematic zoom-in walked viewport off-screen (cursor-anchored
  zoom via re-solved tx/ty).
- /alerts sims bypassed role scoping (sim prepend moved AFTER filter).
- SENTRY batch context wiped on role switch (hoisted to Zustand).
- Review Queue approve/reject was fire-and-forget (now optimistic + toast
  with undo).
- "Approve all" / "Approve remaining" were inert (now wired with
  chunked POST + progress toast).
- Forecast confidence band rendered with paint-over-with-bg hack (now
  explicit p10/p90 envelope lines).

### Security
- Role-based access enforced at UI (ScopeGuard) and API (allowed_units)
  layers. Out-of-scope view renders an overlay rather than silent allow.
- Mark Draft + Export gated to data_custodian + security_manager via
  InsufficientPrivilege overlay.
- Air-gap mode adds explicit comms_airgap_engaged / _released audit
  entries; every queued op replays through comms_queued_op_replay.

## [1.0.0-mvp] · 2026-04-24 · Pre-game-changer baseline
Initial commit + dataset engine + FastAPI backend + three-view UI +
e2e hardening + persistence + role scoping + multi-stream BASTION.
Tag: `v1.0.0-mvp`.
