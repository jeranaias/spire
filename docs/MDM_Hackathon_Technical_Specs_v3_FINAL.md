# MDM 2026 AI Forum Hackathon — Technical Architecture Specifications
## Jesse Morgan | Thornveil LLC

---

# PROJECT 1: SENTRY
## Classification-Aware Logistics Data Sanitization & Cross-Domain Sharing

### Use Cases Covered
- Joint/Allied Interoperability (shared data w/ security)
- Contested Installations (cyber-resilient logistics/access control, IT segmentation)
- Near real-time Global Awareness (CLP, stocks, consumption visibility)
- Data Sanitization (explicitly called out in MARADMIN 3.b.3)

---

### Problem Statement

Marine Corps logistics data is trapped. Maintenance records, supply chain status, equipment readiness reports, and consumption data contain a mixture of UNCLASSIFIED and CUI information — often within the same record. A single maintenance remark might contain a routine fault description alongside an MGRS grid coordinate, a FOUO technical reference, and a maintainer's PII.

Today, there is no automated way to determine what is releasable and what is not. Most of this data simply never gets shared — not because someone reviewed it and said no, but because nobody has the tools or the time to figure out what's clean and what isn't. The result: logistics officers have maintenance data that could improve readiness visibility across the MEF, but it stays locked in the unit that generated it. Industry sustainment partners who need readiness data to pre-position parts cannot access it. Allied forces operating in coalition environments are cut off entirely.

In a contested logistics environment — the scenario DC I&L is explicitly planning for — this gap becomes a mission-critical vulnerability. If you can't share logistics data at the speed of operations, you lose decision advantage.

### Proposed Solution

SENTRY is a locally-hosted, air-gap-capable system that ingests logistics and maintenance data, automatically identifies and classifies controlled elements, sanitizes records for authorized sharing, and produces a clean UNCLASSIFIED output — all without any data leaving the local machine.

---

### HawkStack Integration: Two-Tier Cascade Classification

**The problem with LLM-only classification:** Running every maintenance record through a local LLM (even via RigRun) works on a Blackwell workstation but doesn't scale to a logistics officer's Toughbook at a FOB. A 200-record batch through a 122B model takes minutes. In a contested environment, you need seconds.

**The HawkStack solution: micro-classifier as Tier 1, LLM as Tier 2.**

SENTRY uses a two-tier cascade architecture — the same cascade routing concept already built into RigRun, but with a HawkStack-derived micro model as the first tier instead of a heuristic.

**Tier 1: HawkStack Sensitivity Classifier (~50–100K parameters)**

A sub-100K parameter text classifier trained using cyclic-restart SGDR to categorize maintenance record snippets into sensitivity classes:

```
Input: "Oil pressure below threshold. Replace oil pump assembly."
Output: CLEAN (confidence: 0.97) → Tier 1 handles it, no LLM needed.

Input: "Phased array calibration drift exceeding [REDACTED] threshold. 
        Grid: MGRS 18S UJ 23456 78901. POC: SSgt Martinez, J. / SSN: XXX-XX-3847"
Output: SENSITIVE_MULTI (confidence: 0.99) → Tier 1 flags PII + GEO + CLASSIFIED,
        routes to Tier 2 for contextual analysis.

Input: "Hydraulic line leak near ASP. Freq: TAD Net: 30.050 MHz"
Output: SENSITIVE_COMMS (confidence: 0.82) → Borderline confidence,
        routes to Tier 2 for verification.
```

**Classes:**
- CLEAN — no sensitive elements detected
- SENSITIVE_PII — contains personally identifiable information
- SENSITIVE_GEO — contains geospatial data (MGRS, lat/long, named locations)
- SENSITIVE_COMMS — contains communications parameters
- SENSITIVE_CLASSIFIED — contains classified technical references
- SENSITIVE_MULTI — contains multiple sensitive categories
- AMBIGUOUS — insufficient confidence, requires LLM review

**Confidence routing:**
- Confidence ≥ 0.90 and class = CLEAN → pass through, no LLM needed
- Confidence ≥ 0.90 and class = SENSITIVE_* → apply regex-based sanitization rules, no LLM needed
- Confidence < 0.90 OR class = AMBIGUOUS → route to Tier 2 (RigRun LLM) for contextual analysis

**Expected cascade efficiency:** Based on the synthetic dataset distribution (144/200 records = 72% UNCLASSIFIED), Tier 1 should handle ~80-90% of records without touching the LLM. This means SENTRY processes 200 records in seconds on a laptop CPU, not minutes on a GPU.

**Training approach:**
- Architecture: 1D text CNN or lightweight BiLSTM (same family as the MIT-BIH ECG classifier, adapted from 1D signal to 1D token sequences)
- Training protocol: Cyclic-restart SGDR, 10-cycle, matching HawkStack methodology
- Training data: Generate labeled training set from the synthetic logistics dataset + augmentation
- Target: sub-100K parameters, <10ms inference per record on CPU
- The gain sequence from SGDR training becomes part of the demo — show the judges that a 100K model trained with the right protocol matches what a naive approach would need 10M+ parameters to achieve

**Tier 2: RigRun LLM (Qwen3.5-122B via SGLang)**

Reserved for the 10-20% of records that Tier 1 can't classify with high confidence. These are the genuinely ambiguous cases — records where context matters. The LLM handles:
- Aggregation risk assessment (multiple CUI elements that collectively warrant higher classification)
- Contextual classification of named locations ("Camp Schwab" is an installation name, not PII)
- Disambiguating operational language from routine language
- Generating the natural language redaction explanations in the audit report

**The demo argument:**
"SENTRY's first classification layer is 100,000 parameters. It handles 90% of records in under 10 milliseconds each on a CPU. The LLM only activates for the 10% of records that require contextual judgment. This is not a frontier-model problem. This is a purpose-built micro-model problem — trained with the same methodology that produces 97.63% accuracy at 82K parameters on industrial defect detection."

---

### Architecture

#### Layer 1: Data Ingestion
**Purpose:** Accept logistics data in whatever format the user has.

**Supported inputs:**
- CSV / XLSX (structured maintenance records, readiness reports, supply chain data)
- JSON (API feeds from logistics systems, GCSS-MC exports)
- Free-text (unstructured maintenance remarks, SITREPs, logistics status reports)
- Drag-and-drop file upload via web UI
- Paste-in text for quick single-record processing

**Processing pipeline:**
1. File type detection and parsing
2. Schema normalization — map incoming columns to a canonical schema (record_id, date, unit, equipment, fault_description, classification_marking, etc.)
3. Character encoding normalization (handle UTF-8, ASCII, mixed encodings from legacy systems)
4. Deduplication check (hash-based, catch re-uploads)
5. Store raw records in local SQLite database for audit trail

**What you already have:**
- RigRun's ingestion pipeline handles file parsing
- SQLite is already in the RigRun stack
- The synthetic dataset (200 records) is ready for testing

**What you need to build:**
- Schema normalization layer for GCSS-MC / LOGAIS field mappings
- Drag-and-drop file upload component in React frontend
- Column auto-detection (fuzzy match incoming column headers to canonical schema)

---

#### Layer 2: Sensitive Element Detection Engine

**Purpose:** Identify every piece of controlled, classified, or sensitive information in each record.

**Detection categories and methods:**

**Category 1: PII (Personally Identifiable Information)**
- Full names (pattern: rank + last, first / last, first MI)
- SSN (pattern: XXX-XX-XXXX, even partial)
- EDIPI / DoD ID (pattern: 10-digit numeric)
- Phone numbers (pattern: DSN, commercial, international)
- Email addresses
- Home addresses
- Method: Regex + NER (Named Entity Recognition)
- Confidence scoring: HIGH (exact pattern match), MEDIUM (contextual match), LOW (possible match)

**Category 2: Geospatial Data**
- MGRS coordinates (pattern: grid zone + 100km square + numeric)
- Lat/Long (decimal degrees, DMS)
- Named locations with operational significance (FOB names, LZ designators, MSR names)
- Building numbers on installations
- Method: Regex for formatted coords + NLP for named locations
- Cross-reference: check against known installation facility databases

**Category 3: Communications Parameters**
- Radio frequencies (pattern: XXX.XXX MHz, any band)
- Callsigns
- COMSEC key references (KGV, KG, KIV series)
- SATCOM channel assignments
- Net IDs
- Method: Regex + keyword matching + contextual analysis

**Category 4: Equipment-Specific Classified Data**
- Classified TM/TI references (pattern: TM XX-XXXX-XXX-XX with classification markings)
- System performance parameters with [REDACTED] placeholders
- Fire control system specifics
- Electronic warfare parameters
- Sensor capabilities/limitations
- Weapons system bus specifications
- Method: Keyword matching + classification guide cross-reference + LLM contextual analysis

**Category 5: Operational Data**
- Unit movement/deployment information
- Force composition details
- Operational timelines
- Threat assessments
- Intelligence references
- Method: NLP contextual analysis via local LLM

**Category 6: Supply Chain Sensitive Data**
- Controlled item serial numbers (weapons, COMSEC, NVGs)
- NSN for controlled/classified items
- Quantities of controlled items at specific locations
- Ammunition lot numbers
- Method: Regex + controlled item database cross-reference

**What you already have:**
- RigRun's classification engine handles the routing logic
- RigRun's safety proxy does content filtering
- 5-layer safety proxy architecture (input validation, content filtering, output filtering, PII detection, classification enforcement)
- Adversarial attack detection (53/53 blocked)

**What you need to build:**
- Military-specific regex library (MGRS, frequencies, COMSEC refs, TM numbers, SSN, EDIPI)
- Controlled item NSN database (subset)
- Confidence scoring system per detection
- Detection audit log (every flag with reason, confidence, and source)

---

#### Layer 3: Classification Engine

**Purpose:** Determine the minimum classification level required for each record based on detected elements.

**Classification logic:**

```
IF contains classified TM reference → SECRET (minimum)
IF contains COMSEC key material reference → SECRET
IF contains EW parameters → SECRET
IF contains fire control system specifics → SECRET (minimum, possibly TS)
IF contains weapons system bus specs → CONFIDENTIAL (minimum)
IF contains operational unit movements → CONFIDENTIAL
IF contains MGRS grid coordinates → CUI (minimum, context-dependent)
IF contains radio frequencies → CUI (minimum, context-dependent)
IF contains PII → CUI
IF contains controlled serial numbers → CUI
IF none of the above → UNCLASSIFIED
```

**Contextual elevation:**
- Aggregation risk: Multiple CUI elements in one record may collectively warrant higher classification
- Temporal sensitivity: Operational data may be downgradable after time threshold
- Combination rules: Grid + frequency + unit = potential SECRET (reveals operational disposition)

**Validation:**
- Compare system-assigned classification against source marking
- Flag discrepancies (record marked UNCLASSIFIED but system detects SECRET content)
- This catches marking errors — a real problem in operational units

**What you already have:**
- RigRun's classification routing engine (UNCLASSIFIED → TS)
- 100% accuracy on 1,000+ classification tests
- 909/909 brute force attacks blocked
- 53/53 adversarial attacks blocked

**What you need to build:**
- Logistics-specific classification rules (the rule table above)
- Aggregation risk scoring
- Discrepancy flagging between source marking and detected classification
- Classification confidence scoring (HIGH/MEDIUM/LOW)

---

#### Layer 4: Sanitization Engine

**Purpose:** Transform controlled records into releasable UNCLASSIFIED versions while preserving analytical utility.

**Sanitization methods (by category):**

| Data Type | Method | Example |
|-----------|--------|---------|
| PII names | Replace with role/rank generic | "SSgt Martinez, J." → "[MAINTAINER]" |
| SSN/EDIPI | Full redaction | "SSN: XXX-XX-3847" → "[PII REDACTED]" |
| MGRS coords | Generalize to area | "MGRS 18S UJ 23456 78901" → "[LOCATION: CONUS EAST]" |
| Frequencies | Full redaction | "243.0 MHz" → "[COMM REDACTED]" |
| COMSEC refs | Full redaction | "KGV-72" → "[COMSEC REDACTED]" |
| Classified TMs | Replace with generic | "TM [CLASSIFIED]" → "[MAINTENANCE REF]" |
| Serial numbers | Replace with equipment type | "Serial: USMC-4827-31" → "[SERIAL REDACTED - JLTV]" |
| EW parameters | Full redaction | "[REDACTED] band" → "[CAPABILITY REDACTED]" |
| Unit locations | Generalize | "Camp Pendleton Bldg 2374" → "[I MEF AOR]" |

**Preservation rules:**
- Equipment type and TAMCN: ALWAYS preserve (needed for maintenance analytics)
- Fault code: ALWAYS preserve (needed for failure analysis)
- Maintenance level: ALWAYS preserve
- Readiness code: ALWAYS preserve
- Hours/miles operated: ALWAYS preserve
- Parts cost: ALWAYS preserve (generalized if specific part reveals capability)
- Labor hours: ALWAYS preserve
- Date: Preserve month/year, redact day if operationally sensitive

**Output formats:**
- Sanitized CSV/XLSX (same schema, controlled elements replaced)
- Redaction report (every change logged with original, replacement, reason, and confidence)
- Summary statistics (X records processed, Y elements redacted, Z classification discrepancies found)
- Side-by-side comparison view in UI

**What you already have:**
- RigRun's output filtering layer
- PII detection in safety proxy

**What you need to build:**
- Sanitization rule engine (the transformation table above)
- Redaction report generator
- Side-by-side comparison React component
- Generalization logic (MGRS → region, name → role)

---

#### Layer 5: Analytics Engine (Post-Sanitization)

**Purpose:** Provide AI-powered logistics insights on the SANITIZED dataset — proving the data retains analytical value after sanitization.

**Analytics capabilities:**

**5a. Readiness Dashboard**
- MC/PMC/NMC rates by unit, equipment type, and time period
- Trend lines showing readiness trajectory
- Drill-down: click a unit → see equipment breakdown → click equipment → see maintenance history

**5b. Predictive Maintenance Scoring**
- Failure risk index (0-100) per equipment based on:
  - Operating hours since last maintenance
  - Fault code frequency and severity
  - Days since last NMC event
  - Historical mean time between failures for that equipment type
  - Maintenance level escalation patterns (org → intermediate → depot trends)
- Risk threshold alerting: "3 JLTVs at CLB-6 are above 80 risk score"

**5c. Supply Chain Anomaly Detection**
- Parts cost outlier detection (flag records where cost is >2 standard deviations from mean for that equipment/fault combo)
- Lead time analysis: time from fault report to corrective action
- Common failure pattern identification across fleet

**5d. Natural Language Query Interface**
- Ask questions about the sanitized data in plain English
- "What's the MC rate for JLTVs across I MEF?"
- "Which units have the most NMCS events this quarter?"
- "Show me all emergency maintenance actions for MV-22Bs"
- Powered by local LLM (RigRun) with RAG over the sanitized dataset
- Responses are guaranteed UNCLASSIFIED because they're generated from sanitized data

**What you already have:**
- RigRun as the local LLM backbone for NL queries
- Cascade routing for query complexity management
- React frontend architecture

**What you need to build:**
- Readiness dashboard components (recharts or d3)
- Failure risk scoring algorithm (scikit-learn or rule-based)
- RAG pipeline over sanitized logistics data
- NL query interface connected to RigRun

---

#### Layer 6: Security & Audit

**Purpose:** Ensure the system itself doesn't leak controlled data and maintain a full audit trail.

**Security measures:**
- All processing runs locally — zero network calls, zero telemetry
- No data persisted outside local encrypted SQLite database
- Full audit log: every record processed, every detection, every sanitization action, every query
- Session isolation: each processing run is independent
- Input validation: prompt injection detection on NL queries (use RigRun's existing adversarial detection)
- Output validation: final check that no controlled patterns remain in sanitized output
- Demo mode: "air gap verify" button that shows all network interfaces are disabled

**What you already have:**
- RigRun's 5-layer safety proxy
- Adversarial attack detection
- Input validation pipeline

---

#### Layer 7: Frontend UI

**Purpose:** Make all of the above usable by a logistics officer who is not a data scientist.

**Screens:**

**7a. Upload Screen**
- Drag-and-drop zone for CSV/XLSX/JSON
- Paste-in text box for quick single records
- File preview showing first 10 rows with auto-detected schema
- "Process" button

**7b. Processing View (the money shot)**
- Split screen: raw data left, sanitized data right
- Real-time processing animation — records scroll through with sensitive elements highlighting in red as they're detected
- Running counter: records processed, elements detected, by category
- Progress bar with estimated time remaining

**7c. Redaction Report**
- Sortable/filterable table of every redaction
- Columns: Record ID, Field, Original Value, Sanitized Value, Category, Confidence, Classification Impact
- Export as PDF for audit trail

**7d. Classification Discrepancy Report**
- Records where system-detected classification differs from source marking
- This is an immediate value-add for any classification management officer

**7e. Analytics Dashboard**
- Readiness heatmap (units × equipment types, color-coded MC/NMC)
- Failure risk leaderboard (top 20 assets by risk score)
- Trend charts (readiness over time, fault frequency, cost trends)
- NL query bar at top: "Ask about this data..."

**7f. Export**
- Download sanitized dataset (CSV/XLSX)
- Download redaction report (PDF)
- Download analytics summary (PDF)
- One-click "share package" — zips sanitized data + redaction report + analytics summary

**Tech stack:**
- React (you already have this in RigRun)
- Tailwind CSS
- Recharts or D3 for visualizations
- Leaflet for any map views (unit locations)
- Local API calls to RigRun backend

---

#### Infrastructure

**Runtime requirements:**
- Runs on a single laptop
- No internet connection required
- No API keys required
- No Docker required for demo (optional for deployment)
- Python backend + React frontend
- Local LLM via SGLang/RigRun (for NL queries and contextual classification)
- SQLite for data storage and audit trail

**Demo hardware:**
- Your personal laptop with RTX PRO 6000 Blackwell 96GB (if portable) OR
- A laptop with the lightweight version (regex + rule-based classification only, no LLM needed for core sanitization)
- Two versions: FULL (with local LLM for NL queries) and LITE (rule-based only, runs on any laptop)

---

### Demo Script (5 minutes)

**Minute 0-1: The Problem**
"Right now, a logistics officer has maintenance data that could improve readiness visibility across the MEF. But that data never leaves the unit because every record might contain PII, grid coordinates, CUI technical references, or communications parameters mixed in with routine maintenance data. There's no automated way to figure out what's clean and what isn't. So it just doesn't get shared."

**Minute 1-3: The Demo**
- Open SENTRY on laptop (wifi visibly off)
- Drag in synthetic_logistics_data.xlsx (200 records)
- Watch processing screen: records scroll, red highlights appear on PII, MGRS, frequencies
- Point to processing stats: "Tier 1 — a 100,000-parameter HawkStack model — just classified 180 of 200 records in under 2 seconds on the CPU. Only 20 ambiguous records went to the LLM."
- Show split screen: raw vs sanitized side-by-side
- Click into redaction report: "Here's every change, with confidence scores and classification impact"
- Show classification discrepancy: "This record was marked UNCLASSIFIED but contains an MGRS coordinate and a COMSEC reference — SENTRY caught it"

**Minute 3-4: The Analytics**
- Switch to analytics dashboard on sanitized data
- "Now that the data is clean, we can actually use it"
- Show readiness heatmap, failure risk scores
- Type NL query: "Which units will drop below 75% MC rate in the next 30 days?"
- System responds with prediction

**Minute 4-5: The So What**
- "SENTRY processed 200 records in [X] seconds, flagged 56 classified/CUI records, caught 3 marking discrepancies, and produced a releasable dataset with full audit trail"
- "The first classification layer is 100,000 parameters — trained with the same cyclic-restart SGDR protocol that achieves 97.63% on industrial defect detection at 82K parameters. This is not a frontier-model problem."
- "This runs on a laptop with no network connection. It works in garrison, it works on a ship, it works at a FOB with no comms"
- "The sanitized output can be shared with industry sustainment partners, allied forces, or adjacent commands — immediately, not in weeks"

---
---

# PROJECT 2: PULSE
## Predictive Maintenance & Readiness Forecasting

### Use Cases Covered
- Expeditionary Sustainment & Maintenance (forward maintenance, smart cannibalization, expeditionary repair)
- Predictive Maintenance (explicitly called out in MARADMIN 3.b.2)
- Near real-time Global Awareness (readiness visibility)

---

### Problem Statement

Marine Corps equipment readiness is managed reactively. Units track MC/NMC rates in spreadsheets and GCSS-MC, but there is no automated system that predicts which equipment will fail next, which units are trending toward readiness shortfalls, or which parts should be pre-positioned based on failure patterns. Maintenance decisions are made based on experience and gut feel rather than data.

The result: equipment fails unexpectedly, driving down readiness rates. Parts aren't pre-positioned where they're needed, creating supply chain delays. Maintainers spend time on routine inspections instead of focusing on the assets most likely to fail. In an expeditionary environment with limited maintenance capacity, this reactive approach is unsustainable.

Smart cannibalization — identifying which NMC assets have parts needed by higher-priority assets — is done manually by maintenance chiefs walking the motor pool. There is no system that automatically surfaces these matches across units.

### Proposed Solution

PULSE is a predictive maintenance engine that scores equipment failure risk, forecasts unit readiness trends, and recommends smart cannibalization matches — all from existing maintenance data.

---

### Architecture

#### Layer 1: Data Model

**Equipment Profile (per serial number):**
```
{
  equipment_type: "JLTV",
  tamcn: "D1196",
  nsn: "2320-01-658-3894",
  serial_number: "USMC-1234-56",
  assigned_unit: "CLB-6",
  location: "Camp Lejeune, NC",
  current_readiness: "MC",
  hours_operated: 3456.7,
  miles_operated: 12450,
  last_maintenance_date: "2025-09-15",
  last_maintenance_level: "Organizational",
  fault_history: [...],
  parts_replaced: [...],
  days_nmc_last_12mo: 47,
  nmc_events_last_12mo: 3,
  risk_score: 78.4,
  predicted_next_failure: "2025-11-20",
  predicted_failure_type: "TRANS-003"
}
```

**Unit Readiness Profile:**
```
{
  unit: "CLB-6",
  location: "Camp Lejeune, NC",
  total_equipment: 45,
  mc_count: 34,
  pmc_count: 4,
  nmcm_count: 5,
  nmcs_count: 2,
  mc_rate: 75.6%,
  trend_7d: -2.3%,
  trend_30d: -5.1%,
  projected_mc_rate_14d: 71.2%,
  critical_assets: ["USMC-1234-56", "USMC-7890-12"],
  cannibalization_candidates: [...]
}
```

---

#### Layer 2: Failure Risk Scoring

**Risk Score Algorithm (0-100):**

Each equipment gets a composite risk score based on weighted factors:

**Factor 1: Operating Hours Since Last Service (weight: 0.25)**
- Calculate ratio: current_hours / mean_hours_between_service for this equipment type
- Score: 0 at 0% of interval, 100 at 150%+ of interval
- Source data: hours_operated, last_maintenance_date

**Factor 2: Fault Frequency (weight: 0.25)**
- Count fault events in last 90/180/365 days
- Compare to fleet average for this equipment type
- Score: 0 at 0 faults, scales to 100 at 3x fleet average

**Factor 3: Fault Severity Trend (weight: 0.20)**
- Track maintenance level escalation: Org → Intermediate → Depot
- If recent faults are escalating in level, score increases
- Track fault code progression: related fault codes appearing in sequence suggest cascading failure

**Factor 4: Days NMC History (weight: 0.15)**
- Ratio of days NMC to total days in last 12 months
- Equipment with high NMC rates has higher probability of future NMC events
- Score: 0 at 0% NMC, 100 at 30%+ NMC

**Factor 5: Age and Usage (weight: 0.10)**
- Total lifetime hours/miles operated
- Compare to fleet average and known lifecycle curves
- Older, higher-usage equipment scores higher

**Factor 6: Parts Cost Trend (weight: 0.05)**
- Increasing maintenance cost trend suggests deteriorating condition
- Compare rolling 6-month cost to historical average

**Risk thresholds:**
- 0-25: LOW (green) — routine maintenance schedule
- 26-50: MODERATE (yellow) — monitor closely
- 51-75: HIGH (orange) — prioritize for maintenance
- 76-100: CRITICAL (red) — immediate attention required

**Model options:**
- V1 (hackathon speed): Rule-based weighted scoring (no ML needed, explainable, fast to build)
- V2 (HawkStack integration — target for demo): Sub-10K parameter 1D temporal CNN trained with cyclic-restart SGDR on equipment fault sequences. This is the MIT-BIH ECG methodology applied to mechanical health telemetry.

### HawkStack Integration: ECG-to-Equipment Failure Prediction

**The architectural analogy is direct:**

```
ECG arrhythmia detection (HawkStack validated):
  Input: 1D time series of electrical signals (heartbeats)
  Task: Detect abnormal patterns predicting cardiac events
  Model: HawkStack <10K params, SGDR-trained
  Result: 94% accuracy on N/S/V classes

Equipment failure prediction (same methodology, new domain):
  Input: 1D time series of operating data (maintenance events over time)
  Task: Detect abnormal patterns predicting mechanical failure
  Model: HawkStack <10K params, SGDR-trained (same architecture family)
  Target: failure-in-next-30-days binary classifier
```

**Input features per time step (rolling 30-day windows):**
- Operating hours delta
- Fault event count
- Fault severity (org=1, intermediate=2, depot=3)
- Days since last maintenance
- Parts cost (normalized)
- Readiness state (MC=0, PMC=0.33, NMCM=0.66, NMCS=1.0)

**Architecture:** 1D CNN with 3 parallel temporal convolution branches (kernel sizes 3, 7, 15 — covering short-term spikes, weekly patterns, and monthly trends). This is the WEM concept applied to 1D temporal data instead of 2D spatial data. Same multi-receptive-field principle: the kernel sizes span the discriminative temporal frequency range of equipment degradation patterns, just as WEM RF branches span the discriminative spatial frequency range of infrared targets.

**Three-parameter topology prediction (before training):**
- Feature quality (Q): kernel sizes 3/7/15 should cover the relevant degradation frequency range (acute faults, weekly wear patterns, monthly trends)
- Coupling tightness (T): 3 branches = 3 pairwise interactions, expect moderate C2 gain (+5-10%)
- Pathway count (P): 3 parallel branches + no pyramid = expect 3-5 productive basins
- Predicted signature: synergistic (if combined with any temporal hierarchy) or spectral (if flat)

**Training:** 10-cycle SGDR on synthetic fault sequences generated from the logistics dataset. Record the gain sequence — this becomes part of the demo. Show judges that the same training protocol that recovers 47.9pp on sonar detection and 55.3pp on infrared detection also recovers hidden capacity in temporal maintenance prediction.

**The sparse late-cycle signature from MIT-BIH may reappear.** The ECG work showed productive gains at cycles 1, 2, then again at 7, 8, 10, 11, 14 — a pattern not seen in 2D detection domains. If equipment fault sequences produce the same sparse late-cycle pattern, that's a second independent 1D domain exhibiting this topology, strengthening the case for a domain-specific loss surface geometry in sequential data.

**Demo line:** "This predictive maintenance model is 8,000 parameters. The same methodology that detects cardiac arrhythmias in an ECG detects mechanical failure patterns in a JLTV transmission. Both are 1D time-series anomaly detection. Both run on hardware already in the supply chain."

- V3 (post-hackathon): LSTM sequence model on fault code time series, also SGDR-trained

**What you already have:**
- Synthetic dataset with all required fields
- PyTorch + SGDR training pipeline from HawkStack
- MIT-BIH ECG 1D classifier architecture (adapt to maintenance domain)
- hawkstack-ladder CLI for architecture generation
- Gain sequence analysis tooling

**What you need to build:**
- 1D fault sequence feature extractor (convert maintenance records → temporal feature vectors)
- Adapt MIT-BIH 1D CNN architecture to maintenance input features
- Train with SGDR and record gain sequence
- Risk scoring function (V1 rule-based as fallback)
- Fleet average calculation by equipment type
- Trend analysis functions (rolling windows)
- Risk score API endpoint

---

#### Layer 3: Readiness Forecasting

**Purpose:** Predict unit MC rates 7/14/30 days into the future.

**Method:**
1. Calculate current MC rate per unit
2. Identify all equipment at that unit with risk scores above 50
3. Estimate probability each high-risk asset transitions to NMC within forecast window
4. Simulate MC rate under those conditions
5. Generate alert if projected MC rate drops below threshold (e.g., 75%)

**Forecast model:**
```
For each unit:
  current_mc_rate = mc_count / total_equipment
  for each asset with risk_score > 50:
    p_failure = sigmoid(risk_score - 50) * time_factor
    expected_nmc_additions += p_failure
  projected_mc_rate = (mc_count - expected_nmc_additions) / total_equipment
  if projected_mc_rate < threshold:
    generate_alert(unit, projected_mc_rate, contributing_assets)
```

**Alert format:**
"CLB-6 is projected to drop below 75% MC rate within 14 days. Contributing factors: JLTV USMC-1234-56 (risk: 84, predicted failure: TRANS-003), MTVR USMC-5678-90 (risk: 72, predicted failure: ENGINE-001). Recommended actions: prioritize organizational maintenance on these assets."

---

#### Layer 4: Smart Cannibalization Engine

**Purpose:** When an asset is NMC for supply (NMCS), automatically search for the needed part on other NMC assets that are lower priority or deadline.

**Logic:**
```
For each NMCS asset:
  identify needed_part (from fault code → part mapping)
  search all assets in same MEF/region:
    where readiness_code IN (NMCM, deadline) 
    AND equipment_type matches OR part is cross-compatible
    AND has needed_part installed
  rank candidates by:
    1. Lowest priority (deadline > NMCM with longer repair timeline)
    2. Closest physical proximity (same unit > same base > same region)
    3. Lowest impact on donor unit's readiness
  output: cannibalization recommendation with impact analysis
```

**Output:**
"JLTV USMC-1234-56 at CLB-6 needs transmission seal assembly (NSN: 2520-01-XXX-XXXX). Recommended donor: JLTV USMC-9876-54 at CLB-6 (currently deadline, awaiting depot repair estimated 90+ days). Cannibalization impact: no change to CLB-6 MC rate (donor already NMC)."

**What you need to build:**
- Fault code → part mapping table (synthetic but realistic)
- Cross-unit search function
- Cannibalization impact calculator
- Recommendation formatting

---

#### Layer 5: Frontend Dashboard

**5a. Fleet Overview**
- Heatmap: rows = units, columns = equipment types, cells = MC rate (color: green/yellow/red)
- Click any cell to drill down
- Top-level stats: total fleet MC rate, trend arrows, active alerts count

**5b. Risk Leaderboard**
- Top 20 assets by risk score
- Columns: equipment, unit, risk score (color bar), primary risk factor, recommended action
- Sortable by score, unit, equipment type, risk factor

**5c. Unit Deep Dive**
- Select a unit → see all equipment with individual risk scores
- Readiness trend chart (line graph, last 12 months)
- Forecast overlay: projected readiness at 7/14/30 days (dashed line)
- Active alerts and recommendations

**5d. Equipment Deep Dive**
- Select an asset → full maintenance history timeline
- Fault code frequency chart
- Risk score trend over time
- Parts cost cumulative chart
- Predicted next failure: type, estimated date, confidence

**5e. Smart Cannibalization Board**
- Active NMCS assets on the left
- Matched donor candidates on the right with impact analysis
- One-click "generate cannibalization order" (outputs formatted document)

**5f. Alerts Feed**
- Chronological list of system-generated alerts
- Filter by unit, severity, type (readiness threshold, risk spike, cannibalization match)
- Each alert expandable with full analysis and recommended actions

**Tech stack:**
- React + Tailwind
- Recharts for charts/heatmaps
- Local Python API backend
- SQLite for data storage

---

### Demo Script (3 minutes, if presenting alongside SENTRY)

**Minute 0-1: The Problem**
"CLB-6's motor T chief knows his JLTVs are hurting, but he's tracking it in a spreadsheet. He doesn't know that three of his vehicles have the same transmission fault pattern that historically leads to catastrophic failure within 30 days. He also doesn't know that 2d MLG has a deadline JLTV with the exact part he needs."

**Minute 1-2: The Demo**
- Open PULSE dashboard
- Show fleet heatmap: CLB-6 row is yellow, trending red
- Click into CLB-6: three JLTVs flagged critical (risk scores 78, 84, 91)
- "These risk scores come from an 8,000-parameter model — the same architecture family that detects cardiac arrhythmias in ECG data. It's time-series anomaly detection applied to equipment health."
- Show forecast: "CLB-6 will drop to 68% MC rate in 14 days without intervention"
- Click into top risk asset: show maintenance timeline, fault frequency chart, predicted failure
- Show gain sequence chart from SGDR training: "This is the training curve — same cyclic-restart protocol, same multi-basin topology as the six domains in the technical report"
- Switch to cannibalization board: "Here's the part match at 2d MLG, zero impact on their readiness"

**Minute 2-3: The So What**
"PULSE takes the data you're already collecting and turns it into action. The failure prediction model is 8,000 parameters — it runs on a Toughbook, it runs on a tablet, it runs on the same hardware maintainers already carry. No GPU, no cloud, no reach-back. This is the difference between reactive maintenance and predictive sustainment."

---
---

# PROJECT 3: BASTION
## Contested Installation Incident Response

### Use Cases Covered
- Contested Installations (continuity, rapid response, cyber-resilient access control, degraded operations)
- Installation Incident Response (explicitly called out in MARADMIN 3.b.4)
- Integration of AI with autonomous systems (if ThermalHawk tie-in included)

---

### Problem Statement

Marine Corps installations have Emergency Action Plans (EAPs), but executing them under duress is difficult. The watch officer has a binder. The Provost Marshal has a radio. The base commander has a phone tree. When an incident occurs — active shooter, drone sighting, CBRN alarm, cyberattack, infrastructure failure — the response depends on human memory, paper procedures, and voice communication.

DC I&L has explicitly identified contested installations as a planning priority. The threat set is evolving — commercial drone incursions on military installations are already happening, cyber threats to logistics networks are documented (NotPetya's impact on Maersk demonstrated what a single incident does to a logistics enterprise), and the force is being asked to operate from installations that may face direct or indirect threats in ways they haven't before. Today's EAP binder works for a peacetime fire alarm. It was not designed for a scenario where multiple incident types occur simultaneously, communications are degraded, and the watch officer needs to coordinate across functional areas in real time.

There is no digital system that provides the watch officer with instant situational awareness and response guidance for these scenarios — let alone one that works when the network is down.

### Proposed Solution

BASTION is a locally-hosted incident response decision support system that provides real-time situational awareness, AI-generated response checklists, and a natural language query interface for installation-level incidents — all running on a single machine with no network dependency.

---

### Architecture

#### Layer 1: Installation Knowledge Base

**Purpose:** Pre-load all installation data so the system works with zero network connectivity.

**Data components (all synthetic for demo):**

**1a. Facility Database**
```
{
  building_id: "3220",
  name: "1st CEB Headquarters",
  type: "administrative",
  grid: "11S NT 12345 67890",
  occupancy_capacity: 250,
  current_occupancy: 180,
  floors: 3,
  hazmat_present: false,
  critical_infrastructure: false,
  nearest_rally_point: "RP-ALPHA",
  evacuation_routes: ["Route 1: East exit → Basilone Rd", "Route 2: West exit → Vandegrift Blvd"],
  utilities: {power: "Grid A", water: "Main 3", comms: "Node 7"},
  pov_lot_capacity: 120,
  ada_exits: 2
}
```

**1b. Response Force Database**
```
{
  team_id: "PMO-PATROL-3",
  type: "Provost Marshal patrol",
  callsign: "WATCHDOG-3",
  current_sector: "SECTOR-NORTH",
  personnel_count: 2,
  armed: true,
  vehicle: "PATROL-307",
  ert_qualified: true,
  cbrn_qualified: false,
  status: "available"
}
```

**1c. Emergency Action Plans (EAPs)**
Structured templates for each incident type:
- Active Threat (active shooter, insider threat)
- UAS Incursion (single drone, swarm, unknown intent)
- CBRN Event (chemical detection, biological alarm, radiological, nuclear)
- Cyber Incident (network compromise, SCADA attack, data exfiltration)
- Infrastructure Failure (power loss, water contamination, structural collapse)
- Natural Disaster (earthquake, flood, wildfire, severe weather)
- Force Protection Condition (FPCON) changes

Each EAP contains:
- Immediate actions (first 5 minutes)
- Notification sequence (who gets called, in what order)
- Response force posture (who goes where)
- Shelter/evacuation procedures (by building, by area)
- Casualty collection points
- Media/public affairs guidance
- Escalation criteria
- Recovery procedures

**1d. Installation Map Data**
- Building footprints with IDs
- Road network
- Perimeter fence line with entry control points
- Rally points
- Casualty collection points
- Helicopter landing zones
- Ammunition supply points
- Motor pool locations
- Medical facilities
- Communication nodes

**What you need to build:**
- Synthetic installation database (model after a generic Camp Pendleton / Camp Lejeune layout)
- EAP templates for each incident type (use real MCO 3302.1 / MCO 5500.6 structure as reference)
- JSON schema for all data components
- Leaflet-compatible GeoJSON for map features

---

#### Layer 2: Incident Detection & Classification

**Purpose:** Accept an incident report and automatically classify it for appropriate response.

**Input methods:**
- Manual entry: watch officer selects incident type, location, severity from dropdown
- Free text: "Unidentified drone spotted over the ammo supply point, heading east, altitude approximately 200 feet"
- Sensor feed (conceptual/demo): ThermalHawk detection alert triggers automatic UAS incursion report

**Incident classification:**
```
Input: "Unidentified drone spotted over the ammo supply point"

AI Classification:
  Type: UAS_INCURSION
  Subtype: SINGLE_UAS_UNKNOWN_INTENT
  Location: Ammunition Supply Point (Building ASP-1)
  Severity: HIGH (proximity to critical infrastructure)
  Threat Level: ELEVATED (unknown intent over restricted area)
  FPCON Recommendation: CHARLIE
  Applicable EAP: UAS_RESPONSE_PLAN
```

**Severity scoring:**
- CRITICAL: active threat to life, CBRN release, ongoing attack
- HIGH: potential threat to life, critical infrastructure affected, unknown threat near sensitive area
- MODERATE: non-life-threatening incident, minor infrastructure impact
- LOW: suspicious activity, potential false alarm, administrative incident

**What you already have:**
- RigRun's intent classification for NL input
- ThermalHawk detection pipeline (conceptual tie-in)

**What you need to build:**
- Incident classification model (can be rule-based with keyword matching for hackathon)
- Severity scoring algorithm
- EAP matching logic

---

#### Layer 3: Response Generation Engine

**Purpose:** Given an incident classification, generate a tailored, actionable response plan.

**Output components:**

**3a. Immediate Action Checklist**
Auto-generated based on incident type + location + severity:
```
UAS INCURSION — AMMUNITION SUPPLY POINT
Severity: HIGH | Time: 0342L | FPCON: CHARLIE RECOMMENDED

IMMEDIATE ACTIONS (0-5 MIN):
☐ Sound Giant Voice: "DRONE ALERT, DRONE ALERT. TAKE COVER INDOORS. THIS IS NOT A DRILL."
☐ Notify: Installation CO (DSN: XXX-XXXX)
☐ Notify: Regional C-UAS Coordinator
☐ Dispatch: PMO PATROL nearest to ASP-1 for visual confirmation
☐ Dispatch: C-UAS response team (if available)
☐ Restrict: Close ECP-3 and ECP-4 (nearest to ASP)
☐ Evacuate: ASP-1 personnel to Rally Point BRAVO
☐ Activate: CCTV feeds for ASP sector
☐ Log: Incident start time, initial report details

FOLLOW-ON ACTIONS (5-30 MIN):
☐ Establish incident command post at [location]
☐ Request: EOD standby if UAS lands/crashes near ASP
☐ Request: QRF activation if hostile intent confirmed
☐ Coordinate: Airspace deconfliction with tower
☐ Document: UAS description, heading, altitude, behavior
```

**3b. Force Disposition Recommendation**
- Map overlay showing optimal positioning of response forces based on incident location
- Color-coded sectors: red (incident area), orange (cordon), yellow (standoff), green (safe)
- Response force routes from current positions to assigned posts

**3c. Notification Matrix**
- Auto-populated call roster based on incident type and time of day
- Primary and alternate contacts
- Script for each notification: "Sir/Ma'am, this is [watch officer]. We have a [incident type] at [location]. Current status is [status]. Requesting [action]."

**What you need to build:**
- EAP template engine (incident type → checklist)
- Notification matrix generator
- Map overlay logic (incident location → cordon zones → force positioning)
- Checklist interactivity (check items, add notes, timestamp)

---

#### Layer 4: AI Decision Support (Natural Language Interface)

**Purpose:** Let the watch officer ask questions in real time during an incident.

**Example queries and responses:**

Q: "What's the evacuation route for Building 3220?"
A: "Building 3220 has two evacuation routes: Route 1 exits east to Basilone Rd (ADA accessible), Route 2 exits west to Vandegrift Blvd. Nearest rally point is RP-ALPHA, 400m northeast. Current occupancy is approximately 180 personnel."

Q: "Who is the on-call EOD team?"
A: "EOD Team IRONHORSE-2 is on-call. Primary contact: [callsign]. They are currently staged at Building 1100. Estimated response time to ASP-1: 8 minutes."

Q: "If the drone crashes near the ASP, what's the UXO procedure?"
A: "Per the installation EAP, establish a 300m cordon around the crash site. EOD has authority for approach and render safe. Do not attempt recovery. Notify regional EOD coordinator and NCIS for evidence collection. If the drone carried a payload, escalate to CBRN protocol and expand cordon to 500m."

Q: "Show me all buildings within 500m of the ASP"
A: [Map view highlights buildings in radius with occupancy data]

**What you already have:**
- RigRun as local LLM backbone
- RAG pipeline architecture
- NL query interface experience

**What you need to build:**
- RAG index over installation knowledge base
- Query routing: map queries vs. text queries vs. procedure queries
- Response formatting for different query types
- Map integration for spatial queries

---

#### Layer 5: Common Operating Picture

**Purpose:** Real-time map-based visualization of the incident.

**Map features:**
- Installation basemap (buildings, roads, perimeter)
- Incident marker (type-specific icon) at incident location
- Cordon zones (concentric circles/polygons)
- Response force positions (real-time if GPS, manual update if not)
- Rally points (highlighted based on incident location)
- Casualty collection points
- ECPs (color-coded: green=open, red=closed)
- Evacuation route overlays
- Sector assignments for response teams

**Real-time updates:**
- Incident log sidebar (timestamped entries)
- Checklist completion status
- Notification status (sent/acknowledged/no response)
- FPCON indicator

**Tech stack:**
- Leaflet.js with offline tiles (can use OpenStreetMap tiles cached locally, or a synthetic installation map)
- GeoJSON for all installation features
- WebSocket for real-time updates between map and incident log (local only)

**What you already have:**
- TAK integration experience (conceptual familiarity with COP displays)
- React frontend experience

**What you need to build:**
- Leaflet map component with installation data
- Offline tile set (or synthetic SVG map for demo)
- Incident marker system
- Cordon zone generator
- Real-time incident log component

---

#### Layer 6: ThermalHawk Integration — HawkStack in Action (Stretch Goal / Conceptual Demo)

**Purpose:** Show the vision of automated sensor-to-response pipeline AND demonstrate HawkStack methodology producing a real deployed model.

### HawkStack Integration: ThermalHawk-Nano IS a HawkStack Model

ThermalHawk-Nano v2 is the most concrete proof that HawkStack works. It's a ~1.73M parameter thermal drone detection model built using the WEM-Diamond architecture family and trained with cyclic-restart SGDR — the same methodology validated across six domains in the HawkStack technical report. This is not a theoretical connection. The model exists because the methodology exists.

**The HawkStack lineage:**
- Architecture: WEM-Diamond family (same family as the 82K DeepPCB model that hits 97.63% mAP, the 127K sonar model, and the 923K histopathology model)
- Training protocol: Cyclic-restart SGDR (same protocol that recovers 14-55pp across six domains)
- Domain: AntiUAV-410 thermal drone tracking — one of the six validated domains in the paper
- Result: 82.12% mAP at 1.13M params, beating 60M+ tracker baselines
- Target deployment: Hailo-8 edge accelerator ($80 hardware)

**Connection to HawkStack policy argument:**
This is the policy brief made physical. The brief argues "sub-1M-parameter specialized models deploy at fleet scale on commodity silicon, without cloud dependency." ThermalHawk-Nano IS that argument. A 1.73M model on an $80 accelerator detects drones in real time — no cloud, no GPU server, no reach-back required. The same capability using a frontier model would require a GPU that costs 100x more and a network connection that won't exist in a contested environment.

**Flow:**
1. ThermalHawk (thermal camera + Hailo-8 edge accelerator) detects airborne object
2. WEM-Diamond model classifies: drone vs bird vs aircraft at 1.73M params
3. If drone detected with confidence > 0.85:
   - Auto-generate incident report in BASTION
   - Type: UAS_INCURSION
   - Location: derived from camera position + bearing + elevation
   - Include thermal image snapshot
4. BASTION auto-generates response checklist
5. Watch officer sees alert + pre-populated response plan within seconds of detection

**Demo approach:**
- Show a recorded thermal video clip of a drone
- Click "simulate detection" — BASTION auto-populates the incident
- Response plan appears in <3 seconds
- Show the model architecture diagram: "This is 1.73 million parameters. WEM-Diamond backbone, SGDR-trained, running on an $80 edge chip."
- Point: "From detection to actionable response plan in under 5 seconds, no cloud, no frontier model, no network required"

**What you already have:**
- ThermalHawk-Nano v2 model weights (1.73M params, WEM-Diamond, SGDR-trained)
- Trained model weights with gain sequence data
- HawkStack technical report documenting the methodology
- AntiUAV-410 benchmark results (82.12% mAP)

**What you need to build:**
- Mock sensor feed → BASTION API bridge
- "Simulate detection" button for demo
- Auto-population of incident fields from detection data
- Model architecture visualization for demo slide

---

### Demo Script (3 minutes, if presenting alongside SENTRY)

**Minute 0-0:30: The Problem**
"The watch officer has a binder and a radio. When a drone appears over the ammo supply point at 0342, they're flipping pages while the clock is ticking. There is no digital system that gives them instant, AI-powered response guidance — let alone one that works when the network is down."

**Minute 0:30-2:00: The Demo**
- Open BASTION showing installation map
- Click "simulate detection" — ThermalHawk detects drone over ASP
- Flash the model info: "Detection by ThermalHawk-Nano — 1.73 million parameters, WEM-Diamond architecture, running on an $80 Hailo-8 accelerator"
- Incident auto-classifies: UAS INCURSION, HIGH severity
- Response checklist auto-generates in <3 seconds
- Show map: cordon zones appear, nearby response forces highlighted, ECPs flagged for closure
- Type query: "What buildings are within 500m of the ASP?" — map highlights buildings with occupancy counts
- Type query: "What's the UXO procedure if it crashes?" — instant procedure from EAP

**Minute 2:00-3:00: The So What**
"From drone detection to actionable response plan in under 5 seconds. The detection model is 1.73 million parameters — trained with cyclic-restart SGDR, the same protocol that recovers 14 to 55 percentage points of hidden capacity across six validated domains. It runs on an $80 edge chip. No network required. No binder required. No frontier model required. The watch officer gets a tailored checklist, a common operating picture, and an AI assistant that knows every procedure in the EAP — all on hardware that fits in a cargo pocket."

---
---

# INTEGRATION NARRATIVE: THE CONTESTED LOGISTICS OPERATING SYSTEM
# Powered by HawkStack Methodology

Don't present these as three separate tools. Present them as one integrated vision — and the thread that ties them together is HawkStack.

**SENTRY** solves the data sharing problem — logistics data can now flow across security boundaries.
- HawkStack component: ~100K parameter text classifier (Tier 1 cascade) handles 90% of classification on CPU

**PULSE** solves the prediction problem — maintenance decisions are now proactive, not reactive.
- HawkStack component: ~8K parameter 1D temporal CNN (ECG methodology → equipment failure prediction)

**BASTION** solves the response problem — installation incidents are now managed with AI-powered speed.
- HawkStack component: 1.73M parameter ThermalHawk-Nano (WEM-Diamond, SGDR-trained drone detection)

All three share the same underlying infrastructure:
- Same local LLM backbone (RigRun) for complex queries
- Same HawkStack methodology for edge-deployable micro models
- Same air-gap capability (zero network dependency)
- Same security model (local processing, full audit trail, no data exfiltration)
- Same frontend framework (React)
- Same philosophy: build for the disconnected, contested, expeditionary environment — not the garrison network

---

## THE HAWKSTACK ARGUMENT (weave throughout the presentation)

**Opening:** "Every AI model in these three systems was built using HawkStack — a methodology for producing sub-million-parameter models that deploy on edge hardware without cloud dependency."

**During SENTRY demo:** "The first classification layer is 100,000 parameters. It handles 90% of records in under 10 milliseconds each on a CPU. This is not a frontier-model problem."

**During PULSE demo:** "This predictive maintenance model is 8,000 parameters. The same methodology that detects cardiac arrhythmias in an ECG detects mechanical failure patterns in a JLTV transmission. Both are 1D time-series anomaly detection."

**During BASTION demo:** "The model that just detected that drone is 1.73 million parameters. It runs on an $80 edge accelerator. It was trained using the same SGDR protocol that recovers 14 to 55 percentage points of hidden model capacity across six validated domains."

**Closing:** "The Marine Corps doesn't need to choose between frontier AI and edge AI. It needs both. These three systems prove that sub-million-parameter models solve real logistics problems today, on hardware we already own, in environments where cloud AI cannot operate. The methodology is documented, the models are trained, and the evidence spans six domains."

*Hand them the policy brief.*

---

## PARAMETER COUNT SUMMARY (for the final slide)

| System | Component | Parameters | Hardware | Function |
|--------|-----------|-----------|----------|----------|
| SENTRY | Text classifier (Tier 1) | ~100K | CPU (any laptop) | Sensitivity classification |
| SENTRY | RigRun LLM (Tier 2) | 122B (MoE, 10B active) | GPU (RTX PRO 6000) | Contextual analysis |
| PULSE | Failure predictor | ~8K | CPU (any laptop) | Equipment risk scoring |
| PULSE | RigRun LLM (NL queries) | 122B (MoE, 10B active) | GPU | Natural language interface |
| BASTION | ThermalHawk-Nano v2 | 1.73M | Hailo-8 ($80) | Drone detection |
| BASTION | RigRun LLM (NL queries) | 122B (MoE, 10B active) | GPU | Decision support |

**The pattern:** Every detection/classification/prediction task uses a HawkStack micro model. The LLM is reserved for natural language interaction and ambiguous edge cases. This is the cascade architecture — right-size the model to the task, don't default to the biggest thing available.

**The cost argument:** Three HawkStack models (100K + 8K + 1.73M = ~1.84M total parameters) handle the core ML workload across all three systems. Total training compute: hours on a single GPU. Total inference hardware: a laptop CPU + an $80 edge accelerator. A single frontier model training run costs more than the entire HawkStack development portfolio.

---

**The closing line:**
"The Marine Corps doesn't need more cloud dashboards that require a CAC reader and a VPN. It needs AI that works when the network is down, the power is intermittent, and the threat is real. That's what we built. And the methodology that built it is open, reproducible, and documented across six domains."

---

# CROSS-REFERENCE CHECKLIST: WHAT DO I ALREADY HAVE?

Use this to map against your existing codebase:

## RigRun Components Needed
- [ ] Classification routing engine (UNCLASSIFIED → TS)
- [ ] 5-layer safety proxy
- [ ] Cascade router (Tier 1 micro model → Tier 2 LLM pattern)
- [ ] Adversarial attack detection
- [ ] Local LLM inference (SGLang, Qwen3.5-122B)
- [ ] Go backend API structure (231K LOC, 80+ endpoints)
- [ ] React frontend architecture
- [ ] SQLite data storage
- [ ] RAG pipeline (if built)
- [ ] Input validation pipeline
- [ ] Output filtering layer

## HawkStack Components Needed
- [ ] hawkstack-ladder CLI (recipe generator)
- [ ] SGDR training pipeline (cyclic-restart, Fresh + Std variants)
- [ ] WEM-Diamond architecture family code
- [ ] WEM-Pyramid architecture family code
- [ ] 1D CNN architecture from MIT-BIH ECG work
- [ ] Gain sequence analysis and visualization tooling
- [ ] 15 validated reference checkpoints (model zoo)
- [ ] 72-test automated test suite
- [ ] Power-law scaling fit code
- [ ] Three-parameter topology analysis code
- [ ] HawkStack policy brief (2-page PDF, print copies for MDM)
- [ ] HawkStack technical report (33-page PDF, digital distribution)

## ThermalHawk Components Needed
- [ ] ThermalHawk-Nano v2 model weights (1.73M params, WEM-Diamond)
- [ ] Inference pipeline (thermal image → detection → classification)
- [ ] AntiUAV-410 benchmark results
- [ ] Sample thermal footage for demo

## DroneBane Components Needed
- [ ] Counter-UAS domain knowledge (for BASTION context)
- [ ] MAVLink familiarity (for autonomous systems integration narrative)

## Harakat / Arabic NLP
- [ ] Not directly needed, but demonstrates shipping production ML at extreme efficiency (6.7MB, 99.997% Quran accuracy) — same philosophy as HawkStack

## New Components to Build

### SENTRY-specific
- [ ] HawkStack text sensitivity classifier (~100K params, 1D text CNN or BiLSTM)
- [ ] Training data generation pipeline (synthetic logistics records → labeled sensitivity classes)
- [ ] SGDR training run with gain sequence recording
- [ ] Cascade routing logic (Tier 1 confidence → Tier 2 LLM fallback)
- [ ] Military-specific regex library (PII, MGRS, frequencies, COMSEC, TM refs)
- [ ] Sanitization rule engine
- [ ] Logistics data schema normalizer
- [ ] Redaction report generator
- [ ] Side-by-side comparison React component
- [ ] Processing view with real-time highlighting

### PULSE-specific
- [ ] 1D fault sequence feature extractor (maintenance records → temporal feature vectors)
- [ ] HawkStack 1D temporal CNN (~8K params, 3-branch WEM-style, kernel 3/7/15)
- [ ] SGDR training run with gain sequence recording
- [ ] Comparison to MIT-BIH gain sequence (same architecture family, different domain)
- [ ] Smart cannibalization matching engine
- [ ] Readiness dashboard (React + Recharts)
- [ ] Fleet heatmap component
- [ ] Risk leaderboard component
- [ ] Readiness forecast visualization

### BASTION-specific
- [ ] Installation knowledge base (synthetic JSON)
- [ ] EAP template engine (incident type → checklist)
- [ ] Incident classification model (rule-based for hackathon, HawkStack upgrade post)
- [ ] Installation map (Leaflet + GeoJSON / offline tiles / synthetic SVG)
- [ ] Incident COP display
- [ ] NL query interface connected to RigRun
- [ ] Mock sensor feed → BASTION API bridge
- [ ] "Simulate detection" button for demo
- [ ] Cordon zone generator
- [ ] Response force positioning logic

### Shared
- [ ] NL query interfaces (3x — one per project, same underlying RAG via RigRun)
- [ ] Model architecture visualization for demo slides (show WEM-Diamond, 1D CNN, text classifier)
- [ ] Gain sequence comparison chart (show SGDR curves across domains for the presentation)
- [ ] Parameter count summary slide

## Data Assets to Prepare
- [x] Synthetic logistics dataset (200 records, built)
- [ ] SGDR-trained text classifier for SENTRY (training data + model weights)
- [ ] SGDR-trained 1D temporal CNN for PULSE (training data + model weights)
- [ ] Synthetic installation database (buildings, response forces, ECPs)
- [ ] EAP templates (structured JSON)
- [ ] Fault code → part mapping table
- [ ] Fault sequence temporal dataset (derived from synthetic logistics data)
- [ ] Controlled item NSN subset
- [ ] Sample thermal footage clip
- [ ] Offline map tiles or synthetic installation SVG
- [ ] HawkStack policy brief printed copies (bring 20+)
- [ ] Thornveil business cards
