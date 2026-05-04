<div align="center">

**UNCLASSIFIED**

# SPIRE
### A Contested-Logistics Decision Engine for the Stand-in Force

</div>

---

**BLUF.** A 3d MLR S-4 forward in the First Island Chain today cannot see Class
I, V, and VIII in a single pane — those classes live in three incompatible
systems while GCSS-MC focuses on Class IX requisitioning. SPIRE collapses
GCSS-MC, DRRS-MC, and forward sensor feeds into one role-shaped view that
runs offline on a 2U box in a CONEX, with tamper-evident audit and one-click
coalition release. **TRL 4, validated at Modern Day Marine 2026 (1st place,
30 APR 2026). Operational pilot is the next step.**

---

### The Operator's Problem

Today, a forward unit taking a Class VIII demand spike under degraded SATCOM
has three systems open and a phone call. The planner has minutes — not hours —
to choose between cross-level, expedite, or emergency requisition. The
decision is unauditable; the artifact is a spreadsheet.

### Capability Gap

> "GCSS-MC now primarily focuses on requisitioning Class IX repair parts."
> Classes I, V, and VIII are managed by *"three separate incompatible
> systems."* "Conventional sustainment remain[s] the SIF concept's greatest
> vulnerability."
>
> — *Sustainment of the Stand-in Force*, War on the Rocks (Sept 2022).
> The same fragmentation is acknowledged in the *Marine Corps Concept for
> Logistics* (Dec 2024).

### Approach

- **Universal Ingest.** Eight formats (CSV / TSV / XLSX / JSON / JSONL / XML /
  fixed-width / EDI X12) across six channel types (drop, SFTP, IMAP, HTTP poll,
  DB CDC, Kafka). Four pre-built adapters: GCSS-MC ECP, GCSS-MC UTIL,
  GCSS-MC SR-Header, DRRS-MC C-Rating. A local Gemma 4 26B model performs
  schema mapping for non-canonical sources; mappings are reusable per unit.
- **Tamper-evident audit chain.** Every state change is SHA-256 hash-chained
  and Ed25519-signed. Exports as Common Event Format (CEF) for Splunk /
  ArcSight / QRadar. Inspector verification is offline, against a published
  public key.
- **Local-first deployment.** Runs offline on a 2U CONEX box. Vector-clock
  conflict resolution reconciles forward-node writes when SATCOM restores.
  No cloud egress.
- **Coalition-ready.** Live partner-scoped redaction profiles (FVEY, JPN,
  AUS, PHL). One-click ZIP with manifest hash and release ID; the partner
  verifies the bundle hash on receipt.

### Operational Impact

- **One pane across Class I / V / VIII / IX.** Eliminates the cross-system
  reconciliation step that today consumes the forward planner's first ten
  minutes of every Class VIII / V surge.
- **Forward decisions are auditable.** Every cross-level / expedite /
  requisition action commits to the hash-chained audit log; the decision
  the S-4 made at H+0 is verifiable against the public key at H+30 days.
- **Reduced rear-echelon footprint** — no SATCOM dependency for forward
  planning aligns with the SIF requirement that sustainment be *"light,
  flexible, responsive, resilient, and redundant"* (HQMC, *A Concept for
  Stand-in Forces*, Dec 2021).

### Maturity & Risk

**TRL 4.** System prototype validated against synthetic GCSS-MC ECP / UTIL /
SR-Header data at MDM 2026; hash-chained audit verified offline against the
published Ed25519 public key. **TRL 5 requires** a sanitized real GCSS-MC
pull-through in a relevant environment from a sponsoring MEF G-4 or MLR
S-4. ATO is not yet established; the architecture is designed-in for IL5
(audit chain, hierarchical RBAC, CAC/PIV scaffolding, no cloud egress) but
unaccredited.

### Why Now

The 39th Commandant has named logistics the **pacing function**. The *Marine
Corps Concept for Logistics* (Dec 2024) calls for resilience through
redundancy, dispersion, and innovation. The data-fragmentation gap is named
in published doctrine. SPIRE is the bridge — and the window to put it in
operator hands is the FY27 POM cycle.

### Path Forward — Ask

1. **A 90-day operational pilot** with one MEF G-4 or MLR S-4 willing to
   point a sanitized GCSS-MC export at the ingest path.
2. **A Marine Corps Warfighting Lab evaluator** to red-team SENTRY against
   operator-malpractice patterns.
3. **A POC at MCSC PM-MC2I or DC I&L** to translate operator-side
   requirements into a contract vehicle (SBIR Phase II ceiling-eligible
   scope; OTA also fits).

---

<div align="center">

**POC:** Jesse Morgan · Thornveil · jesse@thornveil.ai
**Repo:** `jeranaias/spire` (private; access on request)
**Pilot install:** `docker-compose up` — under 5 min, clean laptop to live demo

v1.1 · 04 MAY 2026 · Distribution unrestricted by author

**UNCLASSIFIED**

</div>
