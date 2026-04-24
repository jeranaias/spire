# LICENSE AND INTELLECTUAL PROPERTY NOTICE

## Modern Day Marine 2026 AI Forum Hackathon
### MARCORLOGCOM CDAO — Washington, D.C. — 27–30 April 2026

**Participant:** SSgt Jesse Morgan, USMC  
**Affiliated Entity:** Thornveil LLC (Florida)  
**Date:** April 2026

---

## 1. Purpose

This document establishes the intellectual property (IP) boundaries for software, models, and datasets produced during the MDM 2026 AI Forum Hackathon. It distinguishes between:

- **Pre-Existing IP** — proprietary software, models, methodologies, and patents owned by Thornveil LLC, developed prior to and independent of this event
- **Hackathon Products** — new software, configurations, integrations, frontends, and datasets created during the event on government time
- **Synthetic Data** — datasets generated for demonstration purposes containing no real government data

---

## 2. Pre-Existing Thornveil LLC Intellectual Property

The following components are the sole property of Thornveil LLC, developed independently prior to this hackathon, and are **not** transferred to the U.S. Government by participation in this event. These components are made available to the hackathon under a limited, non-exclusive, royalty-free license for government use (see Section 4).

### 2.1 Software Systems

| Component | Description | Status |
|-----------|-------------|--------|
| **RigRun** | Local-first sovereign AI inference platform including classification-aware routing engine, 5-layer safety proxy, cascade router, and Go backend | Thornveil proprietary; provisional patent pending |
| **HawkStack** | Neural architecture methodology, recipe generator CLI (`hawkstack-ladder`), cyclic-restart SGDR training protocol, and 15-checkpoint model zoo | Thornveil proprietary; provisional patent pending |
| **ThermalHawk-Nano v2** | ~1.73M parameter thermal drone detection model (WEM-Diamond architecture, SGDR-trained) with trained weights | Thornveil proprietary; provisional patent pending |
| **Harakat** | Arabic diacritization engine (BiLSTM+Attention, 6.7MB) | Thornveil proprietary |

### 2.2 Trained Model Weights

All neural network weights for the following models are Thornveil LLC property:

- ThermalHawk-Nano v2 (AntiUAV-410 thermal drone detection)
- HawkStack model zoo (15 validated reference checkpoints across 6 domains)
- Any HawkStack-derived model trained prior to 27 April 2026

### 2.3 Methodologies and Research

- HawkStack three-parameter topology framework (Feature Quality, Coupling Tightness, Pathway Count)
- Cyclic-restart SGDR evaluation protocol (Fresh and Std variants)
- Domain-calibrated recipe generation methodology
- HawkStack Technical Report (33 pages) and Policy Brief (2 pages)

### 2.4 Patent Portfolio

Thornveil LLC provisional patent applications filed 1 March 2026 (THRN-2026-001 through THRN-2026-024) covering, among other inventions:

- Classification-aware AI routing and data sanitization
- Counter-UAS autonomous engagement
- Edge-deployable micro-model architectures
- Thermal detection neural architectures

These patents are referenced but not transferred. Government use of hackathon products does not constitute a license to the underlying patents beyond the scope defined in Section 4.

---

## 3. Hackathon Products — U.S. Government Ownership

The following components are **created during the hackathon** (27–30 April 2026) on government time and are therefore **government-owned work product**. The U.S. Government receives full ownership and unlimited rights to these items:

### 3.1 SENTRY — Classification-Aware Logistics Data Sanitization

- React frontend (upload interface, processing view, split-screen comparison, redaction report, analytics dashboard)
- Logistics data schema normalization layer
- Military-specific regex library (PII, MGRS, frequency, COMSEC, TM reference patterns)
- Sanitization rule engine (transformation tables, generalization logic)
- Redaction report generator
- GCSS-MC MPR format adapters
- Integration code connecting the SENTRY frontend to RigRun backend APIs
- Any HawkStack-derived text sensitivity classifier model **trained during the event**

### 3.2 PULSE — Predictive Maintenance & Readiness Forecasting

- React dashboard (fleet heatmap, risk leaderboard, unit deep dive, cannibalization board)
- Failure risk scoring algorithm (rule-based and/or ML-based)
- Smart cannibalization matching engine
- Readiness forecasting logic
- Fault code → part mapping tables
- Integration code connecting PULSE frontend to backend APIs
- Any HawkStack-derived failure prediction model **trained during the event**

### 3.3 BASTION — Contested Installation Incident Response

- React frontend (installation map, incident COP, checklist interface, NL query bar)
- Synthetic installation knowledge base (buildings, ECPs, response forces, EAPs)
- EAP template engine
- Incident classification logic
- Cordon zone generator
- Response force positioning logic
- Mock sensor feed bridge for ThermalHawk demo integration
- Integration code connecting BASTION frontend to backend APIs

### 3.4 Synthetic Datasets

All synthetic datasets generated for this event, including:

- GCSS-MC Maintenance Production Report export (500+ records)
- Daily readiness snapshots (15,000+ rows)
- Installation incident log (100 records)
- Fleet registry, parts catalog, and personnel roster
- Dataset generation engine source code

These datasets contain **no real government data, no real PII, no real classified information, and no real operational data**. They are entirely synthetic, generated for demonstration and testing purposes.

### 3.5 Presentation Materials

All slide decks, demo scripts, and briefing materials created for the hackathon final presentation.

---

## 4. License Grant — Thornveil Pre-Existing IP to U.S. Government

Thornveil LLC grants the U.S. Government a **limited, non-exclusive, royalty-free, non-transferable license** to use the Pre-Existing IP identified in Section 2 solely in connection with:

- Evaluation, demonstration, and further development of the Hackathon Products (Section 3)
- Internal government research and prototyping derived from this event
- Non-commercial government use within the Department of Defense

This license **does not** include:

- The right to sublicense, sell, or distribute Thornveil Pre-Existing IP to third parties
- The right to reverse-engineer, decompile, or extract Thornveil proprietary model weights for use independent of the Hackathon Products
- The right to file derivative patent claims on Thornveil Pre-Existing IP
- Commercial licensing or transfer to contractors without a separate agreement with Thornveil LLC

### 4.1 Severability of Hackathon Products

The Hackathon Products (Section 3) are designed to function as a layer on top of Thornveil Pre-Existing IP. The government may:

- Freely modify, extend, and deploy the Hackathon Products
- Replace Thornveil dependencies with alternative implementations (e.g., substitute a different LLM backend for RigRun, or train new models using a different methodology than HawkStack)
- Integrate Hackathon Products into other government systems

If the government wishes to continue using Thornveil Pre-Existing IP beyond prototyping (e.g., in a deployed system, a program of record, or a production capability), a separate licensing agreement or contract with Thornveil LLC is required.

---

## 5. Dependency Map

The following diagram shows which hackathon products depend on which Thornveil components:

```
HACKATHON PRODUCTS (Gov't owned)          THORNVEIL DEPENDENCIES (Thornveil owned)
─────────────────────────────────         ────────────────────────────────────────

SENTRY Frontend ──────────────────────►   RigRun (classification routing, safety proxy)
SENTRY Text Classifier* ─────────────►   HawkStack (training methodology, SGDR protocol)
SENTRY Regex Library ─────────────────►   (no dependency — standalone)
SENTRY Sanitization Engine ───────────►   (no dependency — standalone)

PULSE Dashboard ──────────────────────►   (no dependency — standalone)
PULSE Failure Predictor* ─────────────►   HawkStack (training methodology, SGDR protocol)
PULSE Cannibalization Engine ─────────►   (no dependency — standalone)

BASTION Frontend ─────────────────────►   RigRun (NL query interface)
BASTION Incident Response Engine ─────►   (no dependency — standalone)
BASTION ThermalHawk Integration ──────►   ThermalHawk-Nano v2 (model weights)

* Models trained during the event are gov't owned; the training methodology
  (HawkStack/SGDR protocol) used to produce them is Thornveil IP.
  The gov't may retrain models using any methodology of its choosing.
```

---

## 6. Models Trained During the Event

Any neural network model **trained during the hackathon** (27–30 April 2026) is government-owned work product, regardless of whether Thornveil training methodology (HawkStack, SGDR) was used to produce it. This includes:

- SENTRY text sensitivity classifier (~100K parameters)
- PULSE equipment failure predictor (~8K parameters)
- Any fine-tuned or adapted versions of existing models

The trained weights, training data, training logs, and evaluation results for these models are government property.

**Clarification:** The fact that these models were trained using Thornveil's HawkStack methodology does not make the resulting weights Thornveil property. The methodology is the tool; the output is the product. Analogy: a carpenter's saw belongs to the carpenter, but the table built with it belongs to the customer who hired them.

---

## 7. Data Rights

### 7.1 Synthetic Data
All synthetic datasets are government-owned. They contain no Thornveil trade secrets, no real government data, and no restricted information.

### 7.2 Real Government Data
If any real government data (e.g., actual GCSS-MC exports, real readiness data) is provided to the hackathon team during the event, it remains government property and will not be retained by Thornveil LLC after the event concludes. No real government data will be used to train any Thornveil model or incorporated into any Thornveil product.

---

## 8. Points of Contact

**Thornveil LLC:**  
Jesse Morgan, Founder & CEO  
jesse@thornveil.ai  
(831) 275-8979

**For licensing inquiries regarding continued use of Thornveil Pre-Existing IP beyond the hackathon prototype scope, contact the above.**

---

## 9. Acknowledgment

By including this LICENSE.md in the hackathon project repository, the participant acknowledges that:

1. Hackathon Products created on government time are government-owned
2. Pre-Existing Thornveil IP is identified and remains Thornveil property
3. The government receives a limited license to Thornveil dependencies for evaluation and prototyping
4. Continued operational use of Thornveil dependencies requires a separate agreement
5. All synthetic data is government-owned and contains no real operational data

---

*This document is not a legal contract. It is a good-faith intellectual property notice intended to clearly delineate ownership boundaries for all parties. Thornveil LLC recommends that MARCORLOGCOM CDAO review this notice and consult legal counsel if a formal IP agreement is desired.*
