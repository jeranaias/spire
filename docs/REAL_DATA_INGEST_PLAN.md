// CLASSIFICATION: UNCLASSIFIED // FOUO //

# SPIRE Real-Data Ingest Plan

## Why this doc exists

The MDM 2026 panel asked the right question: *"How will this handle real
data?"* Today every SPIRE field comes from a synthetic dataset
(`seed=42`, 352 assets, 6,320 SRs). To turn pilot-of-concept into
pilot-of-record, every panel needs a documented real-world data
source — by name, system-of-record, ingest path, refresh cadence,
and classification ceiling.

This document is that map. One row per data domain. If a SPIRE
panel doesn't appear here it has no real-data path yet and should
be marked `synthetic-only` until one is wired.

## Source-system register

Every USMC logistics + readiness data source SPIRE could plausibly
ingest, with the realistic ingest mode (operator export vs API vs
file drop) and the panel(s) that consume it.

| # | Source system | What it carries | Ingest mode (today) | Refresh | SPIRE panels consuming |
|---|---|---|---|---|---|
| 1 | **GCSS-MC** Global Combat Support System – Marine Corps | Asset master, SR records, requisitions, parts, work orders, NSN catalog | **CSV/XLSX export from a GCSS terminal**, no API | weekly (typical), nightly (some units) | PULSE Risk Board · PULSE Forecast · SENTRY Mark Draft (SR remarks) · Decision Bridge MC tile |
| 2 | **DRRS-MC** Defense Readiness Reporting System – Marine Corps | Unit C-rating, mission-essential tasks, MET scores, T-ratings | **Authoritative DRRS-MC JSON export** (per Service A&S directive) | weekly, plus event-driven on T-rating change | Decision Bridge Mission tile · BASTION COP unit-readiness drawer |
| 3 | **GCSS-Army (or Sister-Service equivalents)** | Joint partner unit readiness for joint task force ops | Boundary-crossing pull via DDS / J6 broker | event-driven (during JTF activation) | SENTRY Coalition · BASTION Joint COP |
| 4 | **DEERS / RAPIDS** Defense Eligibility Enrollment Reporting | EDIPI → name → role mapping; CAC cert validation | **Live PKI lookup** at sign-in via on-prem DEERS proxy | live (auth time only) | Auth · TopBar identity pill · audit chain actor field |
| 5 | **MILES** Marine Corps Information for Logistics, Equipment, Supply | Personnel-equipment assignment matrix; T/E billet codes | CSV export, S-1 produces weekly | weekly | PULSE per-unit asset roster · 3M cards |
| 6 | **TPS-D / TC-AIMS-II** Transportation Coordinator – Automated Information for Movements | TMR (Transportation Movement Request) records, lift status, route clearance | **PDF + JSON dual-format export** (per JCS deconfliction) | event-driven (per TMR submission) | PULSE TMR submission · Decision Bridge Forecasted Shortages |
| 7 | **MIPR** Military Interdepartmental Purchase Request system | Cross-Service funding lines, accounting, expedite-funding for parts | Manual entry (no system-of-record export today) | per-action | PULSE Cannibalization Propose (cost line attribution) |
| 8 | **ADAMS / OOMA / TAMS** | Aviation maintenance tracking (per platform) | XML + manual reconciliation | nightly | PULSE Risk Board (aviation assets only) · MALS-31 / MWSS-271 panels |
| 9 | **SAMS-E / SMS-Q** | Ground equipment maintenance (legacy data) | XLSX with embedded macros (yes, really) | weekly | PULSE Risk Board (ground assets) |
| 10 | **CAS / ZACS** Convoy / Air Movement Synchronizer | Live convoy status, ingress/egress times | Sister-system query (DTS broker) | every 15 min during active mvmt | BASTION COP convoy overlay (future) |
| 11 | **PACS** Physical Access Control System | Camp gate ingress/egress events | NetEvents push (read-only subscription) | live | BASTION fused-threat panel · ECP gate alerts |
| 12 | **SCADA** (utility / fuel / HVAC at the camp) | Tank-level, fuel pump status, generator-load percent | Modbus/TCP poll, custom data lake | every 60s | BASTION fused-threat panel (POL anomaly) |
| 13 | **Weather** (METOC J7 brief, NSWC weather feed) | TAFs, METARs, severe-wx warnings | XML pull from on-prem METOC server | hourly | BASTION fused-threat panel · PULSE Forecast wx-derate |
| 14 | **Coalition release profiles** (FVEY / JPN / AUS / PHL liaison data) | Partner-specific release ceilings + redactions | Static profile JSON, updated by Security Mgr | quarterly | SENTRY Coalition tab |
| 15 | **Audit chain** (SPIRE-internal SoR) | Hash-chained record of every SPIRE decision | n/a — SPIRE is the system of record | continuous | Admin Audit · per-record drawer |

## Per-panel data-source map

For every SPIRE panel, the source(s) it would read from in pilot
deployment. If a panel reads from `dataset/seed-42`, that row is the
synthetic source — replace with the listed real source for pilot.

### PULSE

| Panel | Synthetic field today | Real source | Ingest cadence |
|---|---|---|---|
| Risk Board (per-asset row) | `dataset.assets[].asset_id` | GCSS-MC asset master | weekly (full); event-driven on dispatch |
| Risk Board (deadlined indicator) | `dataset.snapshots[-1].readiness_code` | GCSS-MC SR header status | nightly (typical) |
| Predicted Failures | `dataset/faults.py` MTBF table | Per-platform PM-tracking systems (ADAMS / SAMS-E) | weekly |
| Forecast (Monte Carlo) | `dataset/lifecycle.run_simulation` 365-day history | GCSS-MC SR + SMS-Q daily snapshots, last 90d | nightly |
| Cannibalization Matcher | `dataset.srs[].requisitions` open NSN catalog | GCSS-MC requisition status (with received-date) | nightly |
| Recommend Actions | `dataset/replenishment.py` cost rates | GCSS-MC + MIPR funding lines | quarterly (rates), per-call (current SR state) |
| TMR Submission | LLM parser, no real I/O | TPS-D / TC-AIMS-II API (JTF dest) | per-action |
| Fleet Overview MC% | `dataset.snapshots[-1]` end-of-day rollup | DRRS-MC C-rating + GCSS-MC end-of-day SR snapshot | daily 0001Z |

### SENTRY

| Panel | Synthetic field today | Real source | Ingest cadence |
|---|---|---|---|
| Mark Draft input | typed paragraph | Operator's draft (not from SoR) | per-action |
| Mark Draft engine | Tier-1 regex + Tier-2 Gemma | Same; no external data dependency | n/a |
| Bulk Mark CSV | uploaded CSV | Unit S-4 spreadsheet (any format) | per-upload |
| Review Queue | `_BATCHES[batch_id].records` after engine run | GCSS-MC SR remarks, post-Tier-1 | per-batch |
| Aggregation Risk Matrix | `_BATCHES.records` grouped by unit×equipment | Same as Review Queue input | per-batch |
| Coalition release profile | `dataset/data/coalition_profiles.json` | Static profile JSON, security-mgr-curated | quarterly |
| Coalition release ZIP contents | scoped + redacted SR records | GCSS-MC SR records, post-redaction | per-action |
| Audit chain entry | every SENTRY decision | SPIRE-internal SHA-256 chain | continuous |

### BASTION

| Panel | Synthetic field today | Real source | Ingest cadence |
|---|---|---|---|
| Map markers (10 PULSE units) | `okinawa-scenario.ts` static array | DRRS-MC unit roster + S-3 force lay-down (KML/GeoJSON) | weekly + event-driven on relocation |
| Marker readiness drawer | `bastion.cop()` synthetic MC% | GCSS-MC + DRRS-MC live unit-readiness | hourly |
| Threat rings (DF-21D / YJ-12) | static JSON | OSI / theater intel feed (S-2 product) | weekly + event-driven |
| ThermalHawk alert | scenario sim | ThermalHawk-Nano on-prem inference (Thornveil HawkStack) | live |
| Fused threats (PACS+SCADA+Wx) | scenario script | Live correlator: PACS push + SCADA poll + METOC pull | live |
| Joint COP | scoped subset | Coalition partner liaison feed (per profile) | per-release |

### Decision Bridge

| Tile | Synthetic field today | Real source | Refresh cadence |
|---|---|---|---|
| FPCON · Mission Clock | `dataset/data/installation_data.json` static | DRRS-MC + camp commander's posture (polled from S-3) | event-driven on FPCON change |
| Top Alerts (10s) | `bastion.alerts` synthetic | BASTION live alerts (PACS + ThermalHawk + SCADA) | live |
| Forecasted Shortages | `dataset/replenishment` rate model | GCSS-MC requisition status × forecasted demand | nightly |
| MC% by Unit | `pulse.fleetOverview` snapshot | DRRS-MC + GCSS-MC end-of-day rollup | daily 0001Z |
| Audit Health | SPIRE audit chain | SPIRE-internal | continuous |

## Pilot ingest path — the realistic one

Real Marine units don't get clean APIs. They get:

1. **A person with a GCSS terminal** who exports an Excel file weekly (the readiness chief or 3M chief)
2. **A spreadsheet with 50 sheets**, half of them empty, columns named whatever the SSgt who created the file felt like
3. **PII bleed everywhere** — EDIPIs, full names, contact info dropped into "Notes"
4. **No single source of truth** — half the units use SAMS-E, half use the unit's own Access database

That's the pilot's actual day-1 input. The architecture has to assume:
- Schema drift is the default
- Column names are not stable
- Files have hundreds of rows of comments + headers + merged cells
- "Real data" arrives in weekly drops, not real-time streams

## Pilot ingest architecture

### Stage 1 — Decision Bridge (file drop)

Already built. Operator drags an XLSX/CSV/folder onto the
`StageIngestHero` card; backend's `_records_from_gcss_ingest`
reads it. Today this expects a known GCSS-MC SR header schema.

### Stage 2 — LLM-driven schema mapper (next pilot feature)

When the dropped file isn't a known GCSS-MC export:

1. Backend detects unknown shape, returns a "schema unknown" 422.
2. Frontend re-uploads to `/api/sentry/schema-map` with the file's
   first 10 rows + headers.
3. Backend asks Gemma 4 (Tier-2): "Here are 10 rows from a USMC
   logistics export. Map each column to one of `asset_id /
   equipment_type / unit_name / mc_rate / fault_class / open_date
   / nsn / serial_number / remark / hours_current` or `null` if no
   match."
4. Gemma returns a column-mapping JSON.
5. Frontend renders the mapping for operator confirmation:
   "We think `Bumper#` → `asset_id`, `TAMCN` → `equipment_type`,
   `Hrs` → `hours_current`. Confirm or reassign."
6. Operator accepts (or fixes) and submits. Backend stores the
   mapping under a unit-specific profile so next week's drop from
   the same unit applies the saved mapping automatically.

This is the unlock that turns "demo on synthetic" into
"pilot on a real S-4's real spreadsheet."

### Stage 3 — Continuous ingest (future)

Once a pilot unit has a stable mapping, SPIRE polls a designated
SharePoint / network-share folder for fresh drops:

1. New file appears.
2. Hash-check against last-ingested file.
3. Apply saved mapping.
4. Run the same Tier-1 + Tier-2 SENTRY pass.
5. Diff against last snapshot, raise alerts on new deadlined assets.
6. Audit chain records the file source + hash + ingest timestamp.

This requires:
- A network-share watcher (Python `watchdog` library on the SPIRE
  host)
- Scheduled job (cron / Windows Task Scheduler)
- The same mapping profile from Stage 2

## Classification ceiling per source

Pilot deployment will operate under specific classification
constraints. Per source:

| Source | Highest plausible classification | SPIRE handling |
|---|---|---|
| GCSS-MC SR remarks | UNCLASSIFIED // FOUO (most), occasional CUI//PII | Tier-1 SENTRY scrub; PII redaction at ingest |
| DRRS-MC C-rating | CUI (always) | mef_commander + g4 only; SENTRY redacts to UNCLASS for partner release |
| DEERS / RAPIDS | CUI//PII (EDIPI is Privacy Act-protected) | Hash before audit-log write; never persist plaintext |
| Threat rings (S-2 product) | SECRET (in real life) | Out of scope for current build (CUI ceiling); placeholder synthetic in BASTION |
| Coalition release | UNCLASSIFIED with REL TO caveats | Profile-driven redaction; manifest SHA-256 audit |
| Audit chain | UNCLASSIFIED // FOUO | Always — system metadata, not a classification carrier |

The current build caps at CUI everywhere. Sources that real-world
hit SECRET would gate at the SPIRE boundary with the `release_blocked`
hard 403 we already ship.

## Outstanding work (post-MDM 2026)

| # | Effort | Item |
|---|---|---|
| RD-1 | 3 days | LLM schema-mapper endpoint + UI (Stage 2) |
| RD-2 | 2 days | Mapping-profile persistence (per unit/format) |
| RD-3 | 5 days | Network-share watcher + scheduled-ingest scaffolding (Stage 3) |
| RD-4 | 3 days | DRRS-MC JSON ingest path (replaces synthetic MC% tile) |
| RD-5 | 4 days | TPS-D / TC-AIMS-II TMR submission integration (replaces LLM-parsed mock) |
| RD-6 | 2 days | Audit-chain → unit-S-4 weekly snapshot export (the inverse — SPIRE feeds back to GCSS) |
| RD-7 | 1 day | Per-pilot-unit configuration UI (which sources, which cadence) |

## What this gets us

Once Stage 2 (LLM schema-mapper) lands, a Marine S-4 can drop their
own weekly readiness Excel — *no matter how it's shaped* — and
SPIRE classifies it, redacts it, predicts failures, recommends
actions, and ships sanitized coalition releases. The synthetic
dataset becomes an offline test fixture; pilot operators run on
their own data within minutes of a fresh drop.

That's the path from "won the hackathon" to "running in a unit."

// CLASSIFICATION: UNCLASSIFIED // FOUO //
