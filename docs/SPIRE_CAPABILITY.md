# SPIRE
## A Contested-Logistics Operating System

SPIRE collapses the data layer underneath military logistics into one
role-shaped view. It runs offline on a 2U box in a CONEX, with on-board
AI, tamper-evident audit, and one-click coalition release. Built by
serving Marines for joint and partnered force employment in degraded,
disconnected, intermittent, and limited (DDIL) communications.

**TRL 4. 1st place at Modern Day Marine 2026.**

---

## Four operator surfaces

**Decision Bridge** is the home view. Five live signals on one
non-scrolling screen — mission clock and force-protection condition,
top alerts, forecasted shortages across Class I/V/VIII/IX,
mission-capable rate by unit with seven-day trends, and the health of
the audit log itself. A forward operator signs in and reads the unit's
posture in three seconds.

**PULSE** is readiness and risk. Forecasts where shortages will hit
and when. Drafts ranked options for the planner — cannibalize,
expedite, or cross-level — sorted by which gets readiness back
fastest. Predicts equipment failures days ahead and drafts the
requisition before the asset breaks. Every action is signed and
chained to the audit log.

**BASTION** is the common operating picture. Real geographic map tiles
with standard military symbols. Fuses access-control, drone,
base-utility, and weather sensor feeds into one threat picture.
Multi-sensor incidents correlate automatically. The operator drives
the map by typing what they want to see — natural language drives
fly-to, filter, query, and overlay.

**SENTRY** is automated classification. Every record that flows
through the system gets a recommended marking with operator override
at every step. Sanitized exports for downstream partners. One-click
release scoped per partner — FVEY, Japan, Australia, the Philippines —
with a unique signature the partner verifies on receipt. The bundle
hash is stamped to the audit chain before it leaves the box.

---

## The platform underneath

**Universal Ingest.** Reads any common file type — CSV, spreadsheets,
JSON, XML, fixed-width legacy exports, EDI X12 — from any common
source: file drops, secure transfer, email attachments, polled web
services, polled databases, streaming feeds. The four core Marine
logistics systems are pre-mapped on day one (GCSS-MC asset roster,
utilization, service requests; DRRS-MC unit readiness). Extending to
another service's system — GCSS-Army, GCSS-Navy/Marine Corps, DLA EBS,
TC-AIMS — is a one-day engineering task per adapter. When an
unfamiliar file arrives, an on-board AI model proposes how to read it;
the operator confirms once; the mapping saves so the work isn't
redone.

**Tamper-evident audit.** Every change is cryptographically chained at
the moment of write. An inspector verifies the chain offline against a
published key — no access to the running system required. Feeds
existing security monitoring tools (Splunk, ArcSight, QRadar) in
standard format.

**Local-first, no cloud.** Fits on a 2U box in a CONEX. Decisions made
forward during a SATCOM blackout reconcile automatically when comms
restore. Vector-clock sync resolves conflicts without losing forward
writes. The on-board AI model lives on the same box as the database.

**Identity hardening.** CAC/PIV authentication scaffolding in place —
a single environment-variable flip moves the system from mock auth to
production certificate-based auth. Hierarchical role-based access maps
to the joint logistics command chain. Records retention compliant with
DoD 5015.02. HashiCorp Vault adapter for secrets.

**Coalition-ready.** Five partner release profiles ship pre-built.
The redaction engine applies live to every record at release time.
The receiving partner verifies the bundle they got matches the
signature stamped to the SPIRE audit chain.

---

## What this lets a force do

A forward operator sees the unit's posture across Class I, V, VIII,
and IX on one screen — instead of three browser tabs and a phone call.

A planner gets ranked options before the asset breaks, not after the
work order opens.

A G-4, J-4, or S-4 sees the same canonical shape regardless of which
service's data flows through the pipe.

A coalition partner gets exactly what their release authority allows,
signed and verifiable.

An inspector walks the audit chain offline against a public key — no
access to the running system, no cooperation from the operator
required.

The whole thing runs without satellite, without cloud, on a single
2U box.

---

## What's in the box

- Four operator surfaces (Decision Bridge, PULSE, BASTION, SENTRY)
- Eight ingest file types × six source channels
- Four pre-mapped Marine logistics systems
- On-board AI for unfamiliar file shapes
- Cryptographically chained audit trail with offline verification
- Common Event Format / syslog export to existing security monitoring
- Five coalition release profiles
- CAC/PIV authentication scaffold
- Hierarchical role-based access control
- DoD 5015.02 records retention
- HashiCorp Vault secrets integration
- Air-gap deployment with vector-clock sync on SATCOM restore
- Multi-sensor threat fusion (access-control, drone, base-utility,
  weather)
- Natural-language operator copilot
- Predictive equipment-failure auto-drafted requisitions
- Monte Carlo demand forecasting (200-path)
- Coalition release pipeline with manifest-hash verification
- Five-minute install from a clean laptop

Built to IL5 standards (tamper-evident audit, role-based access,
smartcard authentication, no cloud egress). Not formally accredited.

---

**SSgt Jesse C. Morgan, USMC** · Marine Corps Detachment Monterey · jesse.c.morgan14.mil@army.mil
**Repo:** github.com/jeranaias/spire (public) · `docker-compose up` — clean laptop to live demo in under five minutes
