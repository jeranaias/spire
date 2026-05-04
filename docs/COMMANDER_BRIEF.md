# SPIRE — Contested Logistics Operating System

**Sanitization · Prediction · Intelligence · Readiness Engine**
*Local Intelligence · No Cloud · IL5-Fit · Marine Made*

> **Commander brief — 04 MAY 2026**

---

## What it is

SPIRE is an operating system for contested logistics — the central
unresolved problem in Force Design 2030 doctrine. It collapses GCSS-MC,
DRRS-MC, sensor feeds, and partner intelligence into a single role-shaped
view a Marine can act from while disconnected, degraded, or behind a
compromised network. **Built by active-duty Marines, on duty time, for the
operators it's actually for.**

## What it does

| View                | Operator action it enables                                                            |
|---------------------|---------------------------------------------------------------------------------------|
| **Decision Bridge** | Five live signals at-a-glance — readiness, alerts, shortages, audit chain, FPCON.     |
| **BASTION**         | Okinawa COP on real MapLibre tiles. Multi-sensor threat fusion, QRF cordons, MIL-STD. |
| **PULSE**           | Monte Carlo readiness forecast (200 paths). Auto-drafts cannibalization + requisition.|
| **SENTRY**          | CUI auto-tagging, sanitized export, FVEY/JPN/AUS/PHL coalition release in one click.  |

## Differentiators

- **Local-first.** Runs offline on a 2U box in a CONEX. Queues writes during SATCOM blackout, syncs on restore. No cloud egress.
- **Audit-chained.** Every record state change is SHA-256 hash-chained, Ed25519-signed, SIEM CEF-exported. Tamper-evident by design.
- **Universal Ingest.** Eight formats (CSV / TSV / XLSX / JSON / JSONL / XML / fixed-width / EDI X12), six channel types (Drop / SFTP / IMAP / HTTP / DB-CDC / Kafka), four pre-built adapters (GCSS-MC ECP / UTIL / SR-Header / DRRS-MC), LLM-assisted column mapping for the rest.
- **Coalition-ready.** Live partner-scoped redaction. JSDF, ADF, AFP each see only what their release authority allows — verified before the bundle leaves the box.
- **Compliance scaffold-ready.** CAC/PIV cert-based auth (mock today, env-flag flip to production), hierarchical RBAC mapped to MARFOR → MEF → MLG → CLR → CLB, DoD 5015.02 records retention with auditable spillage cleanup, HashiCorp Vault adapter for secrets.

## Use cases

1. **EABO inside the First Island Chain.** SSgt forward-deployed to Miyako loses SATCOM. SPIRE keeps writing locally, reconciles when comms restore, with vector-clock conflict resolution.
2. **Mass-casualty Class VIII surge under contested logistics.** PULSE forecasts the 72-hour shortage envelope, auto-drafts cross-level requisitions ranked by impact-per-dollar-per-day. G-4 approves; audit chain captures the decision.
3. **Coalition release in 30 seconds.** III MEF needs to share Class IX status with JGSDF 1st Logistics Brigade. Operator picks the JPN profile, sees redactions applied live, generates a ZIP with manifest hash + release ID. No spreadsheet sanitization race.
4. **Inspector / red-team event.** Auditor opens `/admin/audit`, walks the hash chain, verifies Ed25519 signatures offline against the published public key. No "trust me" required.

## Current state (TRL 3)

- **What's real:** Algorithms (Monte Carlo, classification rules, redaction engine), four-view UI, audit-chain implementation, SIEM CEF wire format, CAC/PIV scaffolding (production-shape), 7 of 7 game-changers shipped, 526 backend tests passing.
- **What's not yet:** Live GCSS-MC pull-through (synthetic dataset today), ATO, MCSC engagement. No cloud dependencies — air-gap deployment is the design point.
- **Won 1st place at Modern Day Marine 2026 (30 APR).** Backers pushing it up the chain.

## What we need from a sponsoring command

1. **A unit willing to point a sanitized GCSS-MC export** at the ingest path for a 30-day evaluation. Path to TRL 4.
2. **A Marine Corps Warfighting Lab evaluator** to red-team SENTRY against operator-malpractice patterns.
3. **An MCSC POC** to translate operator requirements into a contract vehicle (SBIR Phase I → Phase II → MTA-Rapid Prototyping or POR handoff via MCSC LCES PMO).

---

**SPIRE github:** `jeranaias/spire` (private; collaborator access on request)
**Pilot install:** `docker-compose up` — under 5 minutes from clean laptop to live demo.
**Point of contact:** Jesse Morgan · Thornveil
