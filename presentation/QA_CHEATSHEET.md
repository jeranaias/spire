# SPIRE Q&A Cheat Sheet

One-page answers for the predictable judge questions. Match the spec §ANTICIPATED QUESTIONS verbatim where possible, add recent beats (Gemma 4, ENFORCE, CWRU).

---

## Data & integration

**Q: How does this connect to GCSS-MC in production?**
A: SPIRE ingests whatever format the data arrives in. In production it sits downstream of a GCSS-MC BI extract via automated feed. The architecture includes an API ingestion layer for GCSS-MC data services. The settings panel shows the connection points — currently manual upload, with GCSS-MC, LOGAIS, and DRRS-MC API slots ready for configuration on a DoD network.

**Q: What about bandwidth in disconnected environments?**
A: 500 maintenance records as CSV is about 2 MB. SPIRE supports USB/removable media ingestion — export from GCSS-MC to a USB drive, walk it to the SPIRE workstation. Designed for sneakernet.

**Q: Where does the 1 million parameters claim come from?**
A: SENTRY Tier-1 classifier is ~100K parameters. PULSE equipment-failure predictor is ~8K. ThermalHawk-Nano v2 is 1.77M. All three add to ~1.88M total ML parameters for the full SPIRE stack. Each trained with Thornveil training protocol, cross-validated across six published domains in the HawkStack technical report.

---

## Security & trust

**Q: Who validates the sanitization decisions?**
A: SPIRE never auto-releases. Every record passes through a human review queue. Auto-cleared records require one-click approval. Flagged records require individual review. Held records require full analysis. The system does 95% of the work. The human makes the call.

**Q: What if someone uploads actual classified data?**
A: Input screening runs before any processing. Files with classification markings above the operating level are rejected with a hard stop, logged, and the user is directed to their SSO. The system cannot be bypassed.

**Q: Is every LLM call audited?**
A: Yes. Every call routes through RigRun's classification-proxy on port 8095 which wraps Gemma 4 26B with the five-pillar ENFORCE stack: HMAC-chained audit, Argus spillage scanner, Tribunal cross-check for SECRET-plus, Action Gate, Hallucination probe. Nothing reaches the model without being logged; nothing leaves the model without being scanned.

**Q: What about aggregation risk?**
A: SENTRY runs a batch-level second pass after individual record processing. If the combined dataset reveals operationally sensitive information — for example 78 percent of a unit's weapons systems being NMC — it flags an aggregation risk for human review before any release.

**Q: What about audit trail tampering?**
A: Audit logs are append-only with SHA-256 hash chaining. Any modification breaks the chain and is immediately flagged. In production, audit logs would be replicated to a separate system controlled by the security manager.

**Q: What happens if someone steals the laptop?**
A: All data at rest is AES-256 encrypted with a passphrase required at startup. Session data is ephemeral by default. Secure Wipe function available for emergency data destruction. In production this layers on top of the device's own full-disk encryption.

---

## Accuracy & trust

**Q: What if the model is wrong?**
A: Every prediction includes a confidence score and contributing factors. PULSE doesn't say "this will fail." It says "risk score 84 based on these specific factors." The maintenance chief applies their judgment. Feedback buttons on every prediction enable continuous model improvement.

**Q: Why should I trust your numbers over DRRS-MC?**
A: SPIRE does not replace the system of record. When our calculated MC rate differs from DRRS-MC, that discrepancy is the insight — it means assets may be misreported. SPIRE audits the system of record, it doesn't compete with it.

**Q: How do we know the 8K-parameter PULSE model actually works?**
A: Same architecture family published on six domains (SentryHawk, ForgeHawk, DepthHawk, CellHawk, WildHawk, ECG). CWRU Bearing Fault benchmark — the PHM industry standard — we hit [TBD per J2 training run]% with the same 8K-parameter topology. That anchors the claim to a published benchmark before we show it working on synthetic USMC data.

**Q: What about data quality issues in the input?**
A: SENTRY runs data integrity checks before sanitization: impossible values (hours decreasing), schema mismatches (serial number doesn't match TAMCN), invalid defect codes. A Data Quality Score is generated for each batch. Flagged records can be excluded before analysis.

---

## Scale & deployment

**Q: 500 records is a demo. What about MEF-scale data?**
A: Tier 1 processes records in under 10 ms each on CPU — 360,000 records per hour without touching the LLM. PULSE's risk scoring model is 8K parameters and processes an entire fleet in seconds. Architecture scales linearly.

**Q: What hardware does a unit need?**
A: Lite Mode (no LLM) runs on any government laptop — the HawkStack micro models are CPU-only. Full Mode requires a GPU workstation comparable to what already exists at MLGs for engineering applications. 90% of the value is in Lite Mode.

**Q: What about ATO?**
A: SPIRE operates at UNCLASSIFIED as a standalone system, simplifying the RMF process. Architecture aligns with NIST 800-171 and DoD 8500.01. The ENFORCE safety proxy provides audit primitives already, which is the part of ATO packaging that usually takes the longest.

---

## Strategic

**Q: How is this different from what MARCORLOGCOM is already building?**
A: MARCORLOGCOM's enterprise analytics require garrison network connectivity. SPIRE fills the gap for the disconnected, forward-deployed environment where enterprise tools can't reach. When the network is up, SPIRE feeds the enterprise. When it's down, SPIRE operates independently. Complementary, not competitive.

**Q: Who owns this after the hackathon?**
A: Hackathon products — frontends, integration layer, synthetic datasets, and any models trained during the event — are government-owned per LICENSE.md. Thornveil's pre-existing IP (RigRun, HawkStack methodology, ThermalHawk-Nano v2 weights) is available under a limited government license for evaluation and prototyping. Continued operational use requires a separate agreement. Thornveil is an active defense tech company with 26 patents in portfolio and active SBIR proposals — this doesn't disappear on April 30th.

**Q: What about model updates and maintainability?**
A: Detection rules, equipment profiles, and classification rules are configuration files, not hardcoded. New TAMCNs, defect codes, and sanitization rules are JSON updates. HawkStack models retrain via the same SGDR pipeline. The LLM backend is model-agnostic via an OpenAI-compatible API layer — swap models with zero application code changes.

**Q: Have you red-teamed the sanitization?**
A: Tier 1 catches standard-format sensitive data via pattern matching. Tier 2 Gemma 4 at 512K context catches obfuscated or non-standard representations — RigRun's adversarial detection blocked 53 out of 53 tested attacks. But no system is adversary-proof, which is precisely why every record goes through human review. The system recommends. The human approves.

**Q: Can you show me what happens when it fails?**
A: Yes. [Kill LLM backend.] SENTRY continues processing in Tier 1 only mode. Yellow banner appears: "LLM unavailable — operating in pattern-match mode." 90% of records still process normally. Ambiguous records queue for review when the backend reconnects. PULSE risk scoring continues — it's a CPU-only HawkStack model, independent of the LLM. BASTION map and alerts continue. The system degrades gracefully instead of crashing.

---

## Adoption

**Q: My Marines can barely use GCSS-MC. What makes you think they'll adopt another tool?**
A: Each role has one primary screen. The maintenance chief sees a readiness heatmap — red means bad, green means good, click for details. The data custodian sees a drag-and-drop zone and a review queue — drag file, review results, approve or reject. The commander sees a map with colored dots. Every workflow completes in two clicks or fewer. If a Marine has to read a manual to figure out what to do, we've failed. [Have Adrian demo this — an operator who didn't build the system walking through it cold.]

**Q: What does deployment actually cost per unit?**
A: Lite Mode runs on any existing government laptop — zero additional hardware cost. Full Mode requires a GPU workstation ($15-20K) comparable to what already exists at MLGs for engineering applications. 90% of the platform's value is in Lite Mode.

---

## Use-case coverage

**Q: Which of the published use cases does SPIRE address?**
A: Thirteen of them, with one product:

1. Joint / Allied Interoperability — SENTRY release-authority cascade
2. Data Sanitization (MARADMIN 3.b.3) — SENTRY processing + review queue
3. **DoDM 5200.01 upstream marking** — SENTRY Mark Draft
4. Predictive Maintenance (3.b.2) — PULSE risk board
5. **Class IX consumption forecasting** — PULSE demand aggregation by NSN
6. **AI scheduling / induction sequencing** — PULSE risk board as priority queue
7. Expeditionary Sustainment — PULSE smart cannibalization
8. Installation Incident Response (3.b.4) — BASTION COP + response
9. **Proactive installation monitoring** — BASTION multi-stream feed
10. Contested Installations — air-gap + graceful degradation
11. Global Awareness — BASTION MEF-wide map
12. Integration of AI with autonomous systems — ThermalHawk on edge
13. **NL TMR submission** — BASTION NL bar

---

## Gemma 4 specifics (if asked)

**Q: What's the Gemma 4 context window?**
A: 524,288 tokens today — a half-million-token context. Target 1 million once our 500K needle-in-haystack test validates. At 512K we can hold the full MEF's 500 maintenance records, the full installation knowledge base, every response procedure, and PULSE's risk summaries in a single prompt without a RAG pipeline. Half a million tokens of context.

**Q: What's Gemma 4 doing that a smaller model couldn't?**
A: Three things. First — disambiguating the 10 percent of records Tier-1 flags as low-confidence. Second — answering cross-module questions ("what's the relationship between data quality issues and readiness drops") against the whole dataset in one call. Third — explaining PULSE predictions in natural language on demand. Anything a deterministic classifier can handle on CPU, HawkStack Tier-1 handles on CPU. Gemma 4 handles what only a large-context model can.

**Q: Why not put Gemma 4 on a cloud GPU for scale?**
A: Because Marines operate where the cloud doesn't reach. The whole pitch is edge-deployable, air-gap-capable intelligence. Our demo runs entirely on local hardware. Pushing Gemma 4 to cloud breaks the "contested environment" story we just spent 10 minutes selling you.
