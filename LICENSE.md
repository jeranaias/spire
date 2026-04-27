# LICENSE AND INTELLECTUAL PROPERTY NOTICE

## Modern Day Marine 2026 AI Forum Hackathon
### MARCORLOGCOM CDAO — Washington, D.C. — 27–30 April 2026

**Participant:** SSgt Jesse Morgan, USMC  
**Affiliated Entity:** Thornveil LLC (Florida)  
**Date:** April 2026  
**Last revised:** 27 April 2026 (live-inference integration + third-party attribution table)

---

## 0. Marine Made — product attribution

**SPIRE the product is Marine Made.** Every line of SPIRE's hackathon
work product (the SENTRY / PULSE / BASTION / SPIRO surfaces, the
synthetic dataset engine, the role-shaped UI, the operational workflows,
the audit chain integration, the air-gap mode, the GCSS-MC schema
isomorphism, the live-feed scaffolding) was designed, built, and shipped
by SSgt Jesse Morgan, USMC — an active-duty Marine — on duty time
during the MDM 2026 hackathon period. The design choices reflect what a
Marine actually needs at the workbench, not what a contractor guesses
they need.

Per Section 3, that hackathon work product is U.S. Government-owned. It
is also unambiguously Marine-authored.

**Thornveil LLC's contribution is separable, pre-existing, and listed
under Section 2.** Components like RigRun (classification-aware AI
proxy), HawkStack (neural-architecture methodology), and ThermalHawk
(thermal drone detection model) were developed by Jesse Morgan via
Thornveil LLC *prior to* and *independent of* this event, are covered
by provisional patents filed 1 March 2026, and are made available to
the demo under the limited license described in Section 4. Government
use of those Thornveil components beyond evaluation requires a separate
agreement.

The two contributions compose cleanly: SPIRE is the Marine-built
product surface; Thornveil components are the optional intelligence
backbone the demo plugs into.

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
| **HawkStack** | Neural architecture methodology, recipe generator CLI (`Thornveil recipe tools`), Thornveil training methodology, and 15-checkpoint model zoo | Thornveil proprietary; provisional patent pending |
| **ThermalHawk-Nano v2** | Thermal drone detection model family (Thornveil proprietary architecture architecture, Thornveil training protocol-trained) with trained weights. Original Thornveil-licensed v2 variant (val mAP (accuracy) on Anti-UAV410) and Thornveil-licensed Thornveil proprietary architecture variant (val mAP (accuracy)) — the variant currently deployed in SPIRE BASTION live inference. | Thornveil proprietary; provisional patent pending |
| **Harakat** | Arabic diacritization engine (BiLSTM+Attention, 6.7MB) | Thornveil proprietary |

### 2.2 Trained Model Weights

All neural network weights for the following models are Thornveil LLC property:

- ThermalHawk-Nano v2 (AntiUAV-410 thermal drone detection)
- HawkStack model zoo (15 validated reference checkpoints across 6 domains)
- Any HawkStack-derived model trained prior to 27 April 2026

### 2.3 Methodologies and Research

- HawkStack Thornveil topology methodology framework (Thornveil topology axes)
- Thornveil training protocol evaluation protocol (Fresh and Std variants)
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

All synthetic datasets generated for this event, including (current canonical sizes from the live deploy at https://spire-mdm.fly.dev/api/system/status):

- 10 Marine Corps units (canonical structure: CLB-6, CLB-1, 3d Maint Bn, 3/6 Marines, 2d LAR Bn, MALS-31, MWSS-271, 2d LAAD Bn, 2/14 Marines, 7th ESB)
- 352 fleet assets across 19 equipment types (JLTV / MTVR / LAV / M1A1 / MV-22B / CH-53E / HIMARS / etc.)
- 6,432 service-request records modelled on the GCSS-MC schema (`hashed_header` ↔ SRs, `hashed_sr_parts` ↔ requisitions, `hashed_due_in` ↔ parts on order)
- 128,480 daily readiness snapshots (365-day history × 352 assets)
- 3,983 requisitions with NSN / nomenclature / supply path
- 200 personnel records with role + EDIPI assignments
- 100 installation-incident records (UAS, PACS, SCADA, weather, IED)
- 7 cannibalization events (canonical baseline)
- 50+ buildings, 4 ECPs, 6 rally points, 6 response-force teams across the synthetic Camp Henderson installation
- 5 coalition release profiles (FVEY_BASE / FVEY_LOG / JPN_COALITION / AUS_COALITION / PHL_COALITION) with per-partner field redaction rules
- Dataset generation engine source code (deterministic, seed=42)

These datasets contain **no real government data, no real PII, no real classified information, and no real operational data**. Every identifier (asset_id, serial_number, EDIPI, NSN, MGRS grid) is synthetic and generated by the dataset engine. The synthetic Camp Henderson installation is a fictional analogue of an east-coast CONUS base; it does not correspond to any real installation's perimeter, building layout, or response-force assignments.

### 3.5 Presentation Materials

All slide decks, demo scripts, and briefing materials created for the hackathon final presentation.

### 3.6 Live Inference Integration Layer (BASTION ThermalHawk)

The integration that loads Thornveil's trained ThermalHawk weights inside the SPIRE backend and serves a live thermal video feed in BASTION is hackathon work product:

- `backend/model_hooks.py` — environment-driven model loader (multi-model: SENTRY / PULSE / ThermalHawk; degrades gracefully when torch/weights aren't present)
- `backend/ml/thermal_feed.py` — frame source resolver, per-source detection threshold, server-side bbox rendering
- `GET /api/bastion/thermalhawk/feed` and `/feed/info` endpoints
- `frontend/src/components/ThermalHawkFeed.tsx` — operator-facing live-feed surface with pause control, latency HUD, model card overlay
- BASTION sim wiring that runs a real forward pass on each sim trigger and reports measured latency + box count

The vendored architecture file `backend/ml/thermalhawk.py` is a verbatim extraction of the Thornveil proprietary architecture detector class from a Thornveil training script. The class definition itself (Section 2.1: ThermalHawk-Nano v2) is Thornveil pre-existing IP licensed for hackathon use under Section 4; the *wiring* that makes it run inside SPIRE is government-owned hackathon product.

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
SENTRY Text Classifier* ──────────────►   HawkStack (training methodology, Thornveil training methodology)
SENTRY Regex Library ─────────────────►   (no dependency — standalone)
SENTRY Sanitization Engine ───────────►   (no dependency — standalone)
SENTRY Coalition Release Engine ──────►   (no dependency — standalone)

PULSE Dashboard ──────────────────────►   (no dependency — standalone)
PULSE Risk Scoring (rule-based) ──────►   (no dependency — standalone)
PULSE Monte Carlo Forecast ───────────►   (no dependency — standalone)
PULSE Failure Predictor* ─────────────►   HawkStack (training methodology, Thornveil training methodology)
PULSE Cannibalization Engine ─────────►   (no dependency — standalone)
PULSE Recommend-Actions (GC-1) ───────►   (no dependency — standalone; reads
                                           Thornveil-authored
                                           replenishment_rates.json — moves
                                           with the gov't on hand-over)

BASTION Frontend ─────────────────────►   RigRun (SPIRO copilot via NL query)
BASTION Incident Response Engine ─────►   (no dependency — standalone)
BASTION ThermalHawk Live Inference ───►   ThermalHawk (Thornveil-licensed weights;
                                           vendored architecture loaded by
                                           backend/ml/thermalhawk.py)
BASTION Sensor Fusion ────────────────►   (no dependency — standalone)
BASTION Air-Gap Mode (GC-7) ──────────►   (no dependency — standalone)
BASTION Distributed Sync (GC-2) ──────►   (no dependency — standalone)

SPIRO Operator Copilot ───────────────►   RigRun (Gemma 4 26B FP8 via
                                           classification-aware proxy on
                                           Thornveil-managed compute)

* Models trained during the event are gov't owned; the training methodology
  (HawkStack/Thornveil training methodology) used to produce them is Thornveil IP. The gov't
  may retrain models using any methodology of its choosing.
```

---

## 6. Models Trained During the Event

Any neural network model **trained during the hackathon** (27–30 April 2026) is government-owned work product, regardless of whether Thornveil training methodology (HawkStack, Thornveil training protocol) was used to produce it. This includes:

- SENTRY text sensitivity classifier (~100K parameters)
- PULSE equipment failure predictor (~8K parameters)
- Any fine-tuned or adapted versions of existing models

The trained weights, training data, training logs, and evaluation results for these models are government property.

**Clarification:** The fact that these models were trained using Thornveil's HawkStack methodology does not make the resulting weights Thornveil property. The methodology is the tool; the output is the product. Analogy: a carpenter's saw belongs to the carpenter, but the table built with it belongs to the customer who hired them.

---

## 7. Data Rights and Third-Party Components

### 7.1 Synthetic Data
All synthetic datasets are government-owned. They contain no Thornveil trade secrets, no real government data, and no restricted information.

### 7.2 Real Government Data
If any real government data (e.g., actual GCSS-MC exports, real readiness data) is provided to the hackathon team during the event, it remains government property and will not be retained by Thornveil LLC after the event concludes. No real government data will be used to train any Thornveil model or incorporated into any Thornveil product.

### 7.3 Third-Party Datasets

SPIRE incorporates the following third-party datasets, each retained under its original license:

| Dataset | Use in SPIRE | License | Attribution |
|---|---|---|---|
| **Anti-UAV410** (Hwang Bo et al., IEEE TPAMI 2023) | Training data for the deployed ThermalHawk detector. Weights derived from this dataset are Thornveil property under Section 2.2; the dataset itself is not redistributed by SPIRE. | Research-use license per the dataset's release terms (https://github.com/HwangBo94/Anti-UAV410). | Hwang Bo et al., *Anti-UAV410: A Thermal Infrared Benchmark and Customized Scheme for Tracking Drones in the Wild*, IEEE TPAMI, 2023. |
| **Roboflow Thermal-Drone Detection v1** (University of Zagreb, Faculty of Transport and Traffic Sciences) | Optional bundled live-feed source for the BASTION live thermal video demo. 1,504 thermal DJI drone frames downloaded by `scripts/fetch_thermal_demo.sh` from Zenodo. Retained on the deploy box only; not redistributed. | CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/) | Zenodo DOI: 10.5281/zenodo.15633051 |
| **CartoDB Dark Matter** vector basemap | Visual basemap for the BASTION installation map (MapLibre GL). | © CARTO, free vector style (https://carto.com/help/working-with-data/basemaps/). | © OpenStreetMap contributors (ODbL) for underlying geography. |
| **OpenStreetMap** | Underlying road / building / land geometry rendered through the CartoDB style. | ODbL (https://www.openstreetmap.org/copyright) | Surfaced in MapLibre's required attribution control on every map view. |

No part of SPIRE's hackathon work product redistributes any of the above datasets in a way that would violate their respective licenses. The Anti-UAV410 trained weights are Thornveil's derivative work under Section 2.2 and 2.4.

### 7.4 Open-Source Software Dependencies

SPIRE is built on top of standard open-source libraries (FastAPI, Uvicorn, React, MapLibre GL, Recharts, Tailwind, Zustand, Cryptography, NumPy, OpenCV, PyTorch, etc.). Each dependency retains its original license; full attributions are preserved in `frontend/node_modules/*/LICENSE` and the metadata of every installed Python wheel.

A short summary:
- **MIT** — react, react-dom, react-router, recharts, react-map-gl, zustand, clsx, vite, openpyxl, etc.
- **Apache 2.0** — FastAPI, Uvicorn, MapLibre GL JS, Cryptography (also BSD), opencv-python, torch (with extra terms)
- **BSD-3** — NumPy, Pandas, Pydantic
- **ISC / 0BSD / others** — minor utility packages

The hackathon work product does not modify, re-license, or distribute any of these dependencies in violation of their terms.

### 7.5 External LLM Service

SPIRO, the operator copilot, calls Google's **Gemma 4 26B** (FP8 quantization) over a Tailscale-tunneled HTTPS endpoint to a local RigRun classification proxy. Gemma weights are Google's property and are not redistributed by SPIRE. The SPIRO planner, tool registry, prompt set, and tool-call wiring (`backend/copilot/`) are SPIRE hackathon work product. Switching SPIRE to a different LLM backend (the proxy is OpenAI-shape compatible) is a config change, not a code rewrite — see `backend/routes/llm.py`.

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
