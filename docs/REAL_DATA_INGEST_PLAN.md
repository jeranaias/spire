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

---

## Pipeline architecture — per source, end-to-end

The source register (above) says *what* each system carries. This
section says *how* SPIRE consumes it: code module path, canonical
schema, transform stages, persistence layer, refresh tracking,
failure modes. One section per source.

### General architecture

```
                     ┌─────────────────────────────────────┐
  source export ───▶ │  ingest adapter (per-source module) │
  (CSV/XLSX/JSON)    │  backend/integrations/<src>_adapter │
                     └────────────┬────────────────────────┘
                                  │  ↓ normalize + scrub
                     ┌────────────▼────────────────────────┐
                     │  schema mapper                       │
                     │    (a) known-shape → fast path       │
                     │    (b) unknown-shape → Gemma 4       │
                     │        + operator confirm + persist  │
                     └────────────┬────────────────────────┘
                                  │  ↓ canonical CanonicalDataset slice
                     ┌────────────▼────────────────────────┐
                     │  Tier-1 SENTRY scrub                 │
                     │  (PII / classification flag pass)    │
                     └────────────┬────────────────────────┘
                                  │
        ┌─────────────────────────┴─────────────────────────┐
        │                                                   │
   ┌────▼─────────┐                              ┌──────────▼──────────┐
   │ swap_dataset │  ── atomic in-mem replace ──▶│ in-memory singleton │
   │   (state.py) │                              │ all panels read here │
   └────┬─────────┘                              └─────────────────────┘
        │
   ┌────▼──────────────────────┐
   │ persistence layer          │
   │   sqlite + Fernet at rest  │
   │   audit chain entry per    │
   │   ingest action            │
   └────────────────────────────┘
```

Every source goes through this pipe. The differences are:
- **Adapter module** (parses the specific export format)
- **Canonical-schema mapping** (which source field becomes which
  CanonicalDataset attribute)
- **Refresh cadence** (event vs poll vs live)
- **Failure mode** (what SPIRE shows when the source is unreachable)

### Canonical schema (target shape every adapter produces)

Defined in `backend/state.py::CanonicalDataset`. Adapters MUST emit
a `CanonicalDataset` (or a partial slice that `swap_dataset()` can
splice into the singleton):

```python
@dataclass
class CanonicalDataset:
    units:           list[Unit]            # 10 USMC units (DRRS-MC)
    assets:          list[Asset]           # GCSS-MC asset master
    roster:          list[Person]          # MILES + DEERS
    srs:             list[ServiceRequest]  # GCSS-MC SRs
    snapshots:       list[Snapshot]        # daily MC% rollup
    reqs:            list[Requisition]     # GCSS-MC parts pipeline
    cannib_events:   list[CannibEvent]     # synthesized at ingest
    incidents:       list[Incident]        # PACS + SCADA + Wx fusion
    tmrs:            list[TMR]             # TPS-D
    dq_defects:      list[DQDefect]        # ingest QA findings
    violations:      list[Violation]       # consistency engine output
    generated_at:    str
    seed:            int
```

Field-level shape lives in `backend/state.py` — adapters pull the
dataclass schemas directly so canonical drift is impossible (a
schema change forces every adapter to compile or fail loudly).

### Per-source pipelines

#### 1. GCSS-MC (assets / SRs / requisitions) — **the load-bearing pipeline**

```
weekly export (CSV bundle) ─▶ backend/integrations/sentry_gcss_adapter.py
                                  │
                                  ├─▶ ingest_sr_header_csv(bytes)
                                  │     pandas read + column normalize
                                  │     → list[ParsedSrRow]
                                  │
                                  ├─▶ canonical mapping (per CanonicalDataset.assets / .srs / .reqs)
                                  │     stable column → field map
                                  │     drop rows missing asset_id
                                  │     coerce dates to ISO 8601
                                  │
                                  └─▶ Tier-1 SENTRY scrub
                                        backend/routes/sentry.py::tier1_classify
                                        flags PII / geo / comms / classified-TM
```

**Canonical mapping (GCSS column → SPIRE field):**

| GCSS-MC column | SPIRE canonical field | Transform |
|---|---|---|
| `Bumper Number` | `Asset.asset_id` | strip whitespace, uppercase |
| `TAMCN` | `Asset.equipment_type` | TAMCN→equipment-type lookup table |
| `NSN` | `Requisition.nsn` | 13-digit zero-pad |
| `SR Number` | `ServiceRequest.sr_number` | already canonical |
| `Open Date` | `ServiceRequest.open_date` | parse `MM/DD/YYYY` → ISO date |
| `Job Status` | `ServiceRequest.job_status` | enum coerce: OPEN/PENDING/CLOSED |
| `Condition` | `ServiceRequest.condition` | enum coerce: Operational/Deadlined/PMC |
| `Fault Component` | `ServiceRequest.fault_component` | strip + lowercase |
| `Maint Level` | `ServiceRequest.maintenance_level` | `1`/`2`/`3`/`4` |
| `Remark` | `ServiceRequest.remark_text` | preserve verbatim — Tier-1 reads this |
| `Org Code` | `ServiceRequest.unit_name` | UIC→unit-name lookup |
| `EDIPI` (in remark) | flagged + redacted | regex strip in remark; persist only the hash |

**Persistence:** `swap_dataset()` atomically replaces the in-memory
singleton; ingest event written to audit chain with file hash + row
counts + DQ-defect counts.

**Refresh cadence:** event-driven on file drop. Decision Bridge's
`StageIngestHero` is the operator-facing trigger.

**Failure modes:**
| Failure | SPIRE behavior |
|---|---|
| Unknown column shape | 422; FE re-uploads to `/api/sentry/schema-map` for Gemma 4 mapping (Stage 2) |
| Required column missing (asset_id) | 422 + per-row error report; partial ingest aborted |
| Row-level PII bleed (EDIPI in Remark) | Tier-1 flags; redacted before SR lands in canonical; original NEVER persisted |
| Schema drift mid-ingest | Latest mapping profile applied; mismatched rows go to DQ-defects with reason |

#### 2. DRRS-MC (unit C-rating + MET scores)

```
weekly DRRS-MC JSON export ─▶ backend/integrations/drrs_adapter.py (NEW)
                                  │
                                  ├─▶ parse_drrs_export(json)
                                  │     validate JSON Schema (per Service A&S directive)
                                  │     → list[ParsedUnitReadiness]
                                  │
                                  ├─▶ canonical mapping
                                  │     readiness.unit_uic → Unit.uic match
                                  │     c_rating → Unit.c_rating
                                  │     met_scores → Unit.met_scores
                                  │     reporting_period → Snapshot.date
                                  │
                                  └─▶ swap into singleton
                                        units left untouched if their UIC isn't in this drop
```

**Canonical mapping:**

| DRRS field | SPIRE field |
|---|---|
| `unitId` (UIC) | `Unit.uic` (join key) |
| `cRatingOverall` | `Unit.c_rating` |
| `pRating` (personnel) | `Unit.p_rating` |
| `sRating` (supply) | `Unit.s_rating` |
| `rRating` (training) | `Unit.r_rating` |
| `metRatings[]` | `Unit.met_scores: dict[met_id, score]` |
| `reportingPeriodEnd` | `Snapshot.date` |
| `narrative` | `Unit.readiness_narrative` |

**Classification ceiling:** CUI (DRRS-MC C-ratings are CUI by
default). Adapter writes the dataset with a `_max_classification`
flag so SENTRY's release engine knows the slice can't go below CUI
without redaction.

**Failure modes:**
| Failure | SPIRE behavior |
|---|---|
| DRRS JSON unreachable | Decision Bridge MC tile shows last-good + staleness chip |
| UIC mismatch (DRRS unit absent from GCSS-MC dataset) | Logged to DQ; UI shows "DRRS reporting for unaligned UIC X" |
| Schema version drift | Validator flags + ingest aborted; Security Mgr notified via FeedbackDrawer wire |

#### 3. DEERS / RAPIDS (CAC PKI + EDIPI lookup)

```
sign-in (CAC card insert) ─▶ frontend cert picker
                                  │
                                  ├─▶ /api/auth/login (cert serial + PIN)
                                  │
                                  └─▶ backend/auth.py::session_middleware
                                        DEERS_PROXY (on-prem) for cert validation
                                        on miss: reject with 401
                                        on hit: hydrate session.user{ dodid, role, clearance }
```

**Canonical mapping:** None — DEERS is a sign-in dependency, not a
data domain. The session payload is the only persisted artifact:
`session.user.dodid` (hashed for audit), `session.user.role` (used
for scoping).

**Failure modes:**
| Failure | SPIRE behavior |
|---|---|
| DEERS proxy unreachable | Air-gap fallback: signed local roster (CAC verified offline by cert chain) |
| Cert revoked / expired | 401, refuse session |
| Insufficient role | view shows InsufficientPrivilege panel |

#### 4. MILES (personnel-equipment matrix)

```
weekly S-1 CSV export ─▶ backend/integrations/miles_adapter.py (NEW)
                              │
                              ├─▶ parse_miles_csv(bytes)
                              │     pandas read; expected columns:
                              │     EDIPI · Last4 · Unit · Billet · TAMCN · Bumper#
                              │
                              ├─▶ Tier-1 PII scrub (EDIPI never persisted plaintext)
                              │     EDIPI → SHA-256(salt + edipi)
                              │
                              └─▶ canonical mapping
                                    Person.edipi_hash · .unit · .billet
                                    Asset.assigned_to_edipi_hash (back-reference)
```

**Canonical mapping:**

| MILES column | SPIRE field | Transform |
|---|---|---|
| `EDIPI` | `Person.edipi_hash` | SHA-256(salt + edipi) |
| `Last 4` | `Person.last_4` | preserved (low PII risk) |
| `Unit` | `Person.unit_name` | UIC→unit-name lookup |
| `Billet Code` | `Person.billet` | enum |
| `TAMCN` | `Person.assigned_tamcn` | TAMCN→equipment lookup |
| `Bumper#` | `Asset.assigned_to_edipi_hash` | back-reference into Asset |

**Persistence:** Person records land in `roster`; Asset back-references
update via `swap_dataset` partial slice.

#### 5. TPS-D / TC-AIMS-II (TMR submission)

```
operator-typed TMR ─▶ backend/routes/pulse.py::parse_tmr_text_llm
                          │
                          ├─▶ Gemma 4 extracts {origin, dest, qty, hazmat, lift_class}
                          │
                          ├─▶ canonical mapping
                          │     extracted → TMR(...)
                          │
                          ├─▶ POST to TPS-D API (Stage 3 wiring; Stage 1+2 store locally)
                          │     TC-AIMS-II XML envelope
                          │
                          └─▶ audit chain (TMR.tmr_id, hash of extracted struct)
```

**Canonical mapping (extracted JSON → TPS-D XML):**

| Gemma extraction | TPS-D field | Required |
|---|---|---|
| `origin` | `<DepartureLocation>` | yes |
| `dest` | `<DestinationLocation>` | yes |
| `qty` | `<UnitsRequested>` | yes |
| `equipment_class` | `<EquipmentClass>` | yes |
| `hazmat_class` | `<HazmatClass>` | required if any hazmat |
| `route_clearance_id` | `<RouteClearanceId>` | conditional |
| `requested_pickup` | `<RequestedPickupDateTime>` | yes |

#### 6. PACS (gate ingress/egress events)

```
PACS event push (NetEvents subscription) ─▶ backend/routes/streams.py
                                                 │
                                                 ├─▶ event normalize (per-make adapter)
                                                 │     LenelOnGuard / Maxxess / etc.
                                                 │
                                                 └─▶ live correlator (fusion.py)
                                                       drives BASTION fused-threat panel
```

**Canonical event:**

```python
@dataclass
class PacsEvent:
    ts:               datetime
    gate_id:          str
    direction:        Literal["ingress", "egress"]
    actor_dodid_hash: Optional[str]   # absent for unauthorized
    cred_status:      Literal["valid", "expired", "denied"]
    site:             str
```

**Refresh cadence:** live (push subscription). Buffer at 1s.

**Failure modes:** if PACS push stops, BASTION fused-threat panel
shows stale-warning chip (`PACS · 14m stale`).

#### 7. SCADA (utility / fuel / HVAC)

```
SCADA Modbus poll (60s cycle) ─▶ backend/routes/streams.py
                                       │
                                       ├─▶ tag-map (per site config)
                                       │     coil → SpireMetric{site, kind, value, unit}
                                       │
                                       └─▶ fusion.py
                                             POL anomaly trigger / generator alarm
```

**Canonical event:**

```python
@dataclass
class ScadaSample:
    ts:    datetime
    site:  str
    kind:  Literal["pol_tank_pct", "generator_load", "hvac_setpoint", "flow_rate"]
    value: float
    unit:  str
```

#### 8. Threat-rings / S-2 product

```
weekly S-2 KML drop ─▶ backend/integrations/s2_adapter.py (NEW)
                            │
                            ├─▶ parse KML
                            │
                            └─▶ canonical mapping
                                  ThreatRing(system, range_km, center_lat_lng, valid_until)
```

**Classification:** SECRET in real life. Out of scope for current
build (CUI ceiling). Placeholder synthetic in BASTION will swap
to real source under a separate-domain SPIRE deployment with the
right ATO.

#### 9. METOC (weather)

```
hourly METOC XML pull ─▶ backend/integrations/metoc_adapter.py (NEW)
                              │
                              ├─▶ parse TAF / METAR
                              │
                              └─▶ canonical
                                    WxWindow(site, valid_from, valid_to,
                                             vis_km, ceiling_ft, wind_kt, sig_wx)
```

**Refresh:** hourly poll. Cached in-memory; staleness chip on
BASTION when last successful fetch > 90 min ago.

### Persistence layer

Two layers, distinct purposes:

1. **In-memory singleton** (`backend/state.py::_DATASET`):
   - Every panel reads here
   - Replaced atomically via `swap_dataset()`
   - Pickled to `.cache/dataset/` for boot-time hydration (F1)

2. **SQLite + Fernet** (`backend/persistence.py`):
   - Audit chain (every ingest, every decision)
   - Saved review-queue decisions
   - Per-pilot mapping profiles (Stage 2 schema-mapper)
   - Encrypted at rest with `SPIRE_DB_PASSPHRASE`
   - Files: `runtime/spire.db.enc`

### Refresh / staleness tracking

Every adapter writes a `LastIngest` record:

```python
@dataclass
class LastIngest:
    source:        str              # "GCSS-MC" / "DRRS-MC" / etc.
    ingested_at:   datetime
    ingested_by:   str              # actor (dodid hash + role)
    file_hash:     Optional[str]    # SHA-256 of the source file
    row_count:     int
    dq_defects:    int
    canonical_at:  datetime         # when swap_dataset landed
```

Surface chip on every panel: `PULSE · GCSS-MC: 6h ago` / `DRRS-MC:
2d ago`. When > 2× expected cadence, chip turns amber. > 4×, red.

### Failure modes (cross-cutting)

| Class | Behavior |
|---|---|
| Source unreachable | Last-good in-memory singleton stays; staleness chip surfaces; FeedbackDrawer auto-fires alert to Security Manager |
| Schema unknown | 422 → schema-mapper fallback (Stage 2) → mapping profile persists |
| Required field missing | Per-row reject with reason; partial ingest with DQ-defect log |
| Classification ceiling exceeded | Hard 403; audit row tagged `release_blocked`; never enters canonical |
| File hash matches last ingest | No-op; no re-ingest, no audit row spam |
| Mid-ingest crash | Atomic-swap means partial state never lands; canonical stays at previous good |
| Schema drift on a known source | Adapter loud-fail; Security Mgr is the gate |

### Stage-3 ingest scheduler (the watcher)

```
                  ┌─────────────────────────────────────┐
                  │ scripts/spire_ingest_watcher.py     │
                  │ (Windows Task Scheduler / cron)     │
                  └─────────────────┬───────────────────┘
                                    │
            ┌───────────────────────┼─────────────────────┐
            │                       │                     │
       ┌────▼────────┐    ┌─────────▼────────┐   ┌────────▼────────┐
       │ \\share\... │    │ S3 / blob bucket │   │ on-prem HTTPS    │
       │ SharePoint  │    │ (per site)        │   │ pull endpoint    │
       └─────────────┘    └──────────────────┘   └──────────────────┘
                                    │
                                    ▼
                  ┌──────────────────────────────────┐
                  │ /api/system/stage-ingest         │
                  │ (existing endpoint, multi-source) │
                  └──────────────────────────────────┘
```

The watcher is dumb: tail folders + post bytes. Every smart decision
(schema map, scrub, swap, audit) happens server-side in the
adapters that already exist.

## Outstanding work (revised, ranked)

| # | Effort | Item | Unblocks |
|---|---|---|---|
| RD-1 | 3 days | Gemma 4 schema-mapper endpoint + UI | Drop-any-spreadsheet pilot day-1 |
| RD-2 | 2 days | Mapping-profile persistence (`mapping_profiles` table) | Unit-specific mappings stable across drops |
| RD-3 | 2 days | DRRS-MC adapter (`drrs_adapter.py` + JSON Schema) | Real C-rating in MC tile |
| RD-4 | 4 days | TPS-D / TC-AIMS-II TMR adapter | Real TMR submission, replaces LLM-parsed mock |
| RD-5 | 3 days | MILES adapter | Real personnel ↔ asset linkage |
| RD-6 | 5 days | Stage-3 watcher + scheduler | Continuous ingest from network share |
| RD-7 | 2 days | LastIngest staleness chips on every panel | Operator sees data freshness at a glance |
| RD-8 | 3 days | METOC + SCADA + PACS live adapters | BASTION fused-threat from real sensors |
| RD-9 | 2 days | Audit-chain → unit S-4 weekly report export (the inverse) | SPIRE feeds back to GCSS |
| RD-10 | 1 day | Per-pilot configuration UI (sources, cadences, profiles) | Pilot self-service |

**Total: ~27 working days** for full pilot ingest. RD-1+RD-2 (5
days) is the critical path for "day-1 spreadsheet drop works."

## What this gets us

Once Stage 2 (LLM schema-mapper) lands, a Marine S-4 can drop their
own weekly readiness Excel — *no matter how it's shaped* — and
SPIRE classifies it, redacts it, predicts failures, recommends
actions, and ships sanitized coalition releases. Once Stage 3
(watcher) lands, the SPIRE host polls a designated network share
and ingests automatically. The synthetic dataset becomes an offline
test fixture; pilot operators run on their own data within minutes
of a fresh drop.

That's the path from "won the hackathon" to "running in a unit."

// CLASSIFICATION: UNCLASSIFIED // FOUO //
