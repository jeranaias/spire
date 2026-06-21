# SPIRE
## A Contested-Logistics Operating System

SPIRE collapses the data layer underneath military logistics into one
role-shaped view. It runs offline on a backpack-portable AI device (NVIDIA GB10, 128GB unified memory, ~$4K, 2.6 lbs), with on-board
AI, tamper-evident audit, and one-click coalition release. Built by
serving Marines for joint and partnered force employment in degraded,
disconnected, intermittent, and limited (DDIL) communications.

**TRL 4. 1st place at Modern Day Marine 2026.**

---

## Four operator surfaces

### Decision Bridge — the home view
The first screen a Marine sees when they sign in. Five live signals on
one non-scrolling pane, none of them deeper than two clicks: the
mission clock and current force-protection condition; the top three
alerts by severity drawn from every active feed; the next forecasted
shortages across Class I, V, VIII, and IX with hours-to-impact
projected from the readiness model; the mission-capable rate by unit
with a seven-day sparkline showing trend direction; and the health of
the audit chain itself — entries per minute, last hash, integrity
status. Auto-refresh runs at five to sixty seconds depending on the
tile. An air-gap-degraded indicator fades the live tiles when SATCOM
drops so the operator immediately sees their picture is no longer
fresh.

### PULSE — readiness and risk
Mission-capable rate by unit by equipment type rendered as a heatmap
so a maintenance chief sees at a glance which combination is bleeding.
Monte Carlo demand forecasting projects 200 stochastic paths across
the next fourteen days, surfacing the p10 / p50 / p90 envelope on
Class IX requisitions. When a shortage forecasts past the readiness
threshold, PULSE auto-drafts ranked options for the planner —
cannibalize from a low-mission unit, expedite from depot, cross-level
from a peer — sorted by impact-per-day. Predicted equipment failures
use a mean-time-between-failures model per equipment type to project
component failures days ahead and draft the requisition before the
asset breaks. Every action is signed and chained to the audit log;
the decision the S-4 made at H+0 is verifiable against the public key
at H+30 days.

### BASTION — common operating picture
Real geographic map tiles with standard military symbols, not
hand-drawn icons. Multi-sensor threat fusion correlates access-control
gate events, drone detections, base-utility (SCADA) anomalies, and
weather advisories into single fused-threat records with confidence
scores and visual correlation chains an operator can scrub through.
QRF cordons render dynamically when an incident triggers; threat
rings overlay at configurable ranges; unit symbols update from the
live roster. A natural-language copilot accepts queries like "fly to
MCAS Iwakuni" or "show 3d MLR units in scope" and translates them
into map operations. The operator never has to learn a coordinate
system or a map-control vocabulary.

### SENTRY — classification and release
A six-stage pipeline with operator override at every step: Upload,
Processing, Review Queue, Mark Draft, Export, and Coalition. Tier-1
rule-based classification runs synchronously and deterministically
against a configurable rule set — every input gets the same answer.
Tier-2 explanations are opt-in: an operator clicks "explain" and an
on-board AI model writes a paragraph anchored on the Tier-1 evidence
spans, naming the rules that fired and proposing redacted phrasing
the operator can paste back. Bulk uploads route through a sanitization
gate that rejects clear PII before it enters the canonical store.
Sanitized exports build a ZIP with the manifest hash, the bundle
hash, and a snapshot of the audit chain entries that wrote the
records.

---

## The platform underneath

### Universal Ingest — any file, any source
Reads CSV, tab-separated values, Excel workbooks, JSON, JSON-Lines,
XML, fixed-width legacy exports, and EDI X12 supply transactions out
of the box. Each format gets the right parser without operator
configuration — the system infers what it's reading from the first
kilobyte. Six source channels cover every common DoD ingest pattern:
drag a file in directly, watch a local directory for new arrivals,
pull from a remote SFTP share on a schedule, watch an inbox for
attachments matching configured filters, poll a REST or SOAP web
service with ETag-aware caching, replay change-data-capture events
from an Oracle / PostgreSQL / SQL Server source database, or
subscribe to a Kafka streaming topic with offset persistence. Every
channel carries retry-with-backoff, circuit breakers, byte-bounded
fetch caps, and a dead-letter queue so one bad payload doesn't
poison the rest of the pipeline.

### Pre-mapped Marine logistics on day one
The four systems a Marine logistics shop touches every day arrive
ready to ingest — GCSS-MC asset roster (ECP), GCSS-MC utilization
extract (UTIL), GCSS-MC service-request header (SR-Header), and
DRRS-MC unit readiness ratings (C-Rating). Each adapter declares its
column types, sensitivity flags, primary keys, fallback keys, and
cross-field constraints in a single declarative spec. No buried
logic, no contractor-only knowledge. Extending the catalog to
GCSS-Army, DLA EBS, TC-AIMS, or any other tabular system is a
one-day engineering task per adapter.

### On-board AI for unfamiliar files
When an operator drops a non-canonical file — a unit-specific
spreadsheet, a partner-provided extract, a one-off report from a
contractor — a language model running entirely on the same compact device
reads the headers and proposes how each column should map to the
canonical schema. Sample data is scrubbed of PII before the model
sees it; no row leaves the box. The operator confirms the proposal
once; the mapping saves as a per-unit reusable profile. The unit
doesn't redo the work next time the same shape arrives.

### Tamper-evident audit chain
Every change to canonical state — every record applied, every
classification mark, every coalition release, every operator
approval — gets a hash entry chained to the previous entry.
High-value entries are also signed with an Ed25519 key so they
verify offline against a published public key, even if the
underlying database file is rewritten by an attacker with disk
access. Compliant with NIST 800-53 AU-9(5). The audit log forwards
in Common Event Format over UDP or TCP to whatever security
operations center the host installation runs — Splunk, ArcSight,
QRadar, or a downstream syslog collector. No proprietary format,
no vendor lock.

### Coalition release — five partners ship pre-built
Five-Eyes, Japan, Australia, the Philippines, and a NATO-base
profile. Each profile carries its own field-level redaction rules,
classification ceiling, embargo windows, and authorized unit set.
The redaction engine applies live to every record at release time.
The operator sees the diff — what each partner will see versus
what's in the canonical store — before the bundle leaves the box.
The receiving partner verifies the bundle hash on receipt against
the signature stamped to the SPIRE audit chain. Generating a
partner-scoped release is one click after the operator picks the
profile.

### Identity hardening
CAC/PIV certificate-based authentication is built to production
shape in mock-PIN mode by default; a single environment-variable
flip moves the system to require real DoD certificate forwarding
from the TLS-terminating proxy. The EDIPI extracts from the
certificate's subject Common Name; the chain validates against
trust anchors loaded from a configurable directory; revocation
modes for OCSP and CRL are wired in as scaffolds awaiting
deployment-time configuration. Hierarchical role-based access maps
to the joint logistics command chain: a G-4 at CLR sees every CLB
beneath, a SSgt at CLB doesn't see peer CLB data, write access is
locked to the operator's home unit. Records retention is DoD
5015.02-compliant with hard-delete capability for spillage cleanup,
and every retention deletion gets its own audit chain entry — kind,
filename, hash, age, reason — so an investigator can reconstruct
what was deleted without recovering the file. Secrets (channel
credentials, signing keys, partner API tokens) reference HashiCorp
Vault via URL; the Vault adapter fetches at process start and
never persists resolved secrets to disk.

### Local-first, no cloud, ever
The whole stack — backend, frontend, database, on-board AI model,
audit chain — runs on a single backpack-portable device (NVIDIA GB10, 2.6 lbs) with no outbound
network connectivity required. When a forward node and a rear node
both write during a SATCOM blackout, vector-clock reconciliation
merges their state on link restore: writes that don't conflict apply
automatically; writes that do conflict surface to a Security Manager
for resolution, with the audit chain preserving both the winner and
the loser of every conflict. Forward nodes are first-class, not
read-only replicas.

---

## What this lets a force do

A forward operator sees the unit's posture across Class I, V, VIII,
and IX on one screen instead of three browser tabs and a phone call.
A planner gets ranked options before the asset breaks, not after the
work order opens. A G-4, J-4, or S-4 sees the same canonical shape
regardless of which service's data flows through the pipe. A coalition
partner gets exactly what their release authority allows, signed and
verifiable. An inspector walks the audit chain offline against a
public key. The whole thing runs without satellite, without cloud, on
a single backpack-portable device. From a clean laptop with Docker installed,
`docker-compose up` brings the whole stack live in under five
minutes — no registration, no license server, no cloud dependency.

Built to IL5 standards (tamper-evident audit, role-based access,
smartcard authentication, no cloud egress). Not formally accredited.

---

**SSgt Jesse C. Morgan, USMC** · Marine Corps Detachment Monterey · jesse.c.morgan14.mil@army.mil
**Repo:** github.com/jeranaias/spire (public) · `docker-compose up` — clean laptop to live demo in under 5 minutes
