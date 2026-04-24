# SPIRE Demo Script — MDM 2026 AI Forum Hackathon

**Total run time:** 8–10 min (5-min cut also rehearsed)
**Speakers:** SME (Adrian) opener, Jesse + Adrian + CWO operators, SSgt stands by with UxS angle when BASTION lands.
**Goal:** Prove one platform, three views, 11 use cases covered. Close with the parameter-count punchline.

---

## Opener — SME · 1 min

> "I've spent [X] years in Marine Corps logistics. Every week I sit on top of maintenance data that could help adjacent units, predict failures before they happen, and show the commander exactly where the force stands. That data is trapped in GCSS-MC, mixed with PII and CUI, and there is no way to clean it, analyze it, and visualize it in one place. So we built one. This is SPIRE."

*Action: Jesse opens SPIRE. Status footer visible: "Local Infrastructure · No Cloud · No Third-Party APIs · AES-256 Encrypted"*

---

## SENTRY — Jesse · 3 min

**Beat 1: upload + data-quality gate (30s)**

*Action: Role dropdown → Data Custodian. Click SENTRY → Upload.*

> "The data custodian is the person responsible for releasing data. I'm uploading 500 maintenance records from across the MEF."

*Drop file (or use "Load canonical dataset" button). Data quality gate fires.*

> "498 of 500 passed integrity checks. Two flagged — one with hours decreasing from the previous entry, one with a serial that doesn't match the TAMCN. Operator entry errors. PULSE will not process those two records."

**Beat 2: processing animation (90s)**

*Click Process batch. Switch to Processing tab.*

> "Records scroll through the pipeline. Blue scan line on each row as SENTRY classifies it. Red highlights when it finds a classified TM reference. Purple for PII. Orange for comms. Watch the bottom strip:"
>
> "Tier 1 — a one-hundred-thousand-parameter HawkStack text classifier — handled nine-hundred-plus of them on CPU in under three seconds. The other fifty went to Tier 2, our Gemma 4 instance, through the classification proxy on RigRun. Five ENFORCE pillars on every call — HMAC audit, spillage scanner, tribunal, action gate, hallucination probe."

**Beat 3: review queue (45s)**

*Switch to Review Queue.*

> "423 auto-cleared. 47 flagged. 30 held. The system recommends. The human approves. No automated release authority."
>
> *Click a held record.*
>
> "This one was marked UNCLASSIFIED but SENTRY caught a reference to a classified TM. The aggregation-risk panel at the bottom caught something else: 78% of HIMARS records for 5/11 Marines show NMC. Individually they're unclassified. Aggregated, they reveal the unit's fires readiness. SENTRY flagged it automatically."

**Beat 4: upstream marking (45s)**

*Switch to Mark Draft.*

> "SENTRY isn't just downstream sanitization. Same engine runs upstream. Here's a draft paragraph."
>
> *Paste the radar fault sample.*
>
> "Under 10 milliseconds, no LLM: recommends SECRET // NOFORN, explains why in evidence cards, logs the decision to the audit trail. That's the DoDM 5200.01 marking recommender — same pipeline, upstream of the data ever entering a system."

---

## PULSE — Adrian (operator-led) · 2 min

*Role dropdown → Maintenance Chief (CLB-6). PULSE view opens on Fleet Overview.*

**Beat 5: fleet overview (30s)**

*Adrian delivers — not Jesse.*

> "I'm a logistics Marine. This is what I see when I log in. CLB-6 is red. JLTVs at 58%. Five-eleven Marines at 69. I could've pulled that from three different spreadsheets — or I can just look here."

**Beat 6: risk board + deep dive (60s)**

*Click Risk Board. Click a top-ranked JLTV.*

> "Risk score 84. Primary factor: transmission fault twice in 90 days. Fleet average for JLTVs is 0.8. Predicted failure within 14 days. I click in — I see the full maintenance timeline, the component-fault histogram, the risk-score weights. This comes from an eight-thousand-parameter model, same architecture family that detects cardiac arrhythmias on an ECG."

**Beat 7: cannibalization + forecast (30s)**

*Switch to Cannibalization.*

> "2d MLG has the exact part on a deadline JLTV. Zero readiness impact — donor is waiting for depot return anyway. I click Generate Order and hand this to my OIC."

*Switch to Forecast.*

> "This unit projected to cross the 75% line in 11 days. Pre-emptive cannibalization, parts expedite, we stay green."

---

## BASTION — CWO + SSgt · 2 min

*Role dropdown → MEF Commander. BASTION view opens — dark Leaflet COP.*

**Beat 8: unified picture (30s)**

*CWO delivers.*

> "This is what the MEF commander sees. Force readiness on a map, with color coding. CLB-6 has a readiness halo — the alert from PULSE is here. Gate access anomalies from PACS, utility advisories from SCADA, NASA FIRMS heat anomalies — all in the left sidebar. One pane of glass."

**Beat 9: ThermalHawk trigger (60s)**

*CWO clicks "Simulate ThermalHawk detection."*

*Drone track appears over CLB-6 motor pool. Cordon zones render. Alert auto-promotes to CRITICAL.*

> "That detection is a one-point-seven-seven-million-parameter model running on an eighty-dollar Hailo-8 edge chip. Our ThermalHawk-Nano v2 — trained on Anti-UAV-410, benchmarked zero-shot on HIT-UAV from your dataset pool."

*System auto-correlates.*

> "SPIRE just noticed this facility contains 60% of CLB-6's operational vehicles — the unit that PULSE already flagged as hurting. Auto-escalated to CRITICAL. Checklist on the right: PMO dispatched, ECP-3 locked down, regional C-UAS notified — all pre-drafted."

*SSgt closes the BASTION section.*

> "Detection to actionable response plan in under five seconds. No cloud, no network, no frontier model. A sub-2-million-parameter vision model in the same stack as our text classifier and failure predictor."

**Beat 10: NL TMR easter egg (20s) — if time permits**

*CWO clicks the NL bar. Types: "TMR Lejeune to Geiger 5 MTVRs Wednesday urgent"*

> "Natural language in — structured TMR out, validated against installation movement policy, routed through the approval chain. Email-and-spreadsheet retires."

---

## Close — SME · 1 min

> "One upload. Three views. Same platform. The marquee numbers:"
>
> - SENTRY Tier-1 text classifier: **~100,000 parameters**
> - PULSE equipment-failure predictor: **~8,000 parameters**
> - ThermalHawk-Nano v2 drone detector: **1,770,000 parameters**
> - **Total HawkStack machine-learning stack: ~1.88 million parameters.**
>
> "Every one of those trained with the same SGDR protocol, cross-validated across six published domains. The LLM fills in the contextual edge cases. The rule engine documents everything for the ATO package. Every call logged to a SHA-256-chained audit trail through RigRun's five-pillar ENFORCE safety proxy."
>
> "This runs in a Toughbook. It runs at a FOB with no comms. It runs in Kyiv during a blackout. The Marine Corps doesn't need more cloud dashboards. It needs intelligence that works when the network is down, the power is intermittent, and the threat is real."
>
> *Hand judges the HawkStack policy brief.*
>
> "That's SPIRE."

---

## 5-minute contingency cut

Same structure, tighter:

- Opener (30s): tight version
- SENTRY (90s): upload → processing → one discrepancy
- PULSE (90s): heatmap → risk score → cannib match
- BASTION (30s): map → ThermalHawk trigger → "same map, three threat types"
- Close (30s): parameter table + "no cloud" line

**Never cut:** scan-line animation, risk score 84 moment, ThermalHawk drone over motor pool, role-dropdown switch.

---

## Use cases covered (for the scorecard)

| Judging bullet | Beat that lands it |
|---|---|
| Joint / Allied Interop (3.b.3) | SENTRY release-authority FVEY/NATO dropdown + caveat recommendation |
| Data Sanitization (3.b.3) | SENTRY processing view + review queue + aggregation risk |
| **Upstream marking (DoDM 5200.01)** | **SENTRY Mark Draft tab** |
| Predictive Maintenance (3.b.2) | PULSE risk board |
| **Class IX consumption forecasting** | **PULSE risk aggregate — forecast by NSN** (reframe) |
| **Induction sequencing** | **PULSE risk board = induction priority queue** (reframe) |
| Expeditionary Sustainment | PULSE cannibalization matcher |
| Installation Incident Response (3.b.4) | BASTION COP + response checklist |
| **Proactive installation monitoring** | **BASTION multi-stream feed (PACS/SCADA/Weather)** |
| Contested Installations | Graceful degradation — Lite Mode banner when LLM unreachable |
| Global Awareness | BASTION MEF-wide map |
| Integration of AI with autonomous systems | ThermalHawk × HIT-UAV cross-dataset + BASTION correlation |
| **NL TMR** | **BASTION NL bar Easter egg** |

**Total: 13 distinct use cases, one product.**
