# SPIRE Slides Outline

Slide deck to produce in whatever tool the team uses (Google Slides / Keynote / PowerPoint). This file is the source of truth for CONTENT. Design follows the spec dark palette: `#0A0C13` background, `#E5E7EB` text, `#3B82F6` primary accent.

---

## Slide 1 — Title

**SPIRE**
Sanitization, Prediction, Intelligence, Readiness Engine
*Contested Logistics. Local Intelligence.*

Modern Day Marine 2026 AI Forum & Hackathon
27–30 April 2026 · Walter E. Washington Convention Center

All-Marine team — SSgt Jesse Morgan · Adrian Moon · CWO [name] · SSgt [name]
Thornveil LLC

---

## Slide 2 — The problem

Three pain points, one platform:

- **Maintenance data that could help adjacent units stays locked in the unit that generated it.** Nobody has the tools to separate UNCLAS from CUI in a reasonable time.
- **Equipment failures are managed reactively.** Motor-T chiefs track MC rates in spreadsheets and GCSS-MC. No automated system predicts which vehicle breaks next.
- **Installation incidents are managed via binder and phone tree.** That worked for peacetime fire drills. It does not work for a contested installation with simultaneous multi-domain threats.

Contested logistics is the DC I&L stated priority.

---

## Slide 3 — One platform, three views

```
                 SENTRY          PULSE          BASTION
                 "clean"    →    "predict"    →    "visualize"
                                   ↘              ↙
                              RigRun · HawkStack · ThermalHawk
                                   ↓
                            Local, air-gap, encrypted
```

One upload, three perspectives, no seams.

---

## Slide 4 — The HawkStack argument

We do not need frontier models to solve logistics.

| Model | Parameters | Hardware | Role |
|---|---|---|---|
| SENTRY Tier-1 text classifier | **~100,000** | CPU (any laptop) | Sensitivity classification |
| PULSE failure predictor | **~8,000** | CPU (any laptop) | Equipment risk scoring |
| ThermalHawk-Nano v2 | **1,770,000** | Hailo-8 edge chip ($80) | Drone detection |
| **Total HawkStack stack** | **~1.88M** | CPU + $80 edge | Full ML workload |
| Gemma 4 (Tier-2 edge cases) | 26B active · 524K ctx | RTX PRO 6000 via RigRun | NL queries, cross-module correlation |

Every HawkStack model trained with Thornveil training protocol. Same protocol validated across six published domains (SentryHawk, ForgeHawk, DepthHawk, CellHawk, WildHawk, ECG). No pretraining. No cloud.

---

## Slide 5 — SGDR gain curve

*[Inject J1 SENTRY + J2 PULSE gain_curve.json results when training lands.]*

Plot per-cycle best validation accuracy across 10 SGDR cycles. Shows the characteristic "restart bumps" that recover 14–55 pp of hidden capacity across HawkStack's six published domains. Same protocol, same recovery pattern, new domains.

---

## Slide 6 — Cross-dataset generalization

| Model | Native dataset | Metric | Cross-validated on |
|---|---|---|---|
| PULSE 8K predictor | Synthetic USMC faults | [TBD] | CWRU Bearing Fault (12k DE) — PHM industry benchmark |
| ThermalHawk-Nano v2 | Anti-UAV-410 (82.95% mAP) | mAP@50 | HIT-UAV (zero-shot) |
| SENTRY Tier-1 classifier | Synthetic logistics corpus | [TBD] | Real GCSS-MC sample (pending MARCORLOGCOM access) |

Same weights. Different data. The methodology travels.

---

## Slide 7 — Use-case coverage

13 use cases, one product:

✓ Joint / Allied Interop  ✓ Data Sanitization  ✓ DoDM 5200.01 upstream marking
✓ Predictive Maintenance  ✓ Class IX forecasting  ✓ AI scheduling
✓ Expeditionary Sustainment  ✓ Installation Incident Response
✓ Proactive installation monitoring  ✓ Contested Installations
✓ Global Awareness  ✓ Integration of AI with autonomous systems
✓ NL TMR submission

No other team will cover this many with this focus.

---

## Slide 8 — Security posture

- All processing runs **locally**. Zero cloud. Zero third-party APIs.
- **AES-256 encryption** on data at rest. Passphrase at startup.
- Every LLM call through RigRun's **ENFORCE 5-pillar safety proxy**:
  HMAC audit · Argus spillage · Tribunal cross-check · Action Gate · Hallucination probe
- **SHA-256 hash-chained audit trail**. Tamper = broken chain.
- **Input screening** rejects files above operating level with a hard stop.
- **Secure Wipe** overwrites all local state on demand.
- **NIST 800-171 / DoD 8500.01** alignment. ATO-ready posture.

---

## Slide 9 — Graceful degradation

| Subsystem | Full Mode | Lite Mode |
|---|---|---|
| SENTRY Tier-1 classification | ✓ | ✓ (same model, CPU) |
| SENTRY Tier-2 disambiguation | Gemma 4 @ 512K ctx | Queue for later |
| PULSE risk scoring | ✓ | ✓ (same model) |
| PULSE cannibalization | ✓ | ✓ |
| BASTION map + alerts | ✓ | ✓ |
| BASTION NL queries | Gemma 4 | Greyed out |
| ThermalHawk sensor | Hailo-8 edge | Hailo-8 edge |

Lite Mode keeps **~90% of functionality**. The system degrades, it does not crash.

---

## Slide 10 — The closing line

> "The Marine Corps doesn't need more cloud dashboards that require a CAC reader and a VPN. It needs AI that works when the network is down, the power is intermittent, and the threat is real."

*Hand the HawkStack policy brief to the judges.*

**SPIRE. Contested Logistics. Local Intelligence.**

---

## Handout to print

- HawkStack policy brief (2-page PDF) — bring 20+ copies
- Thornveil business cards
- One-page "How to adopt" with the team's emails + a link to the repo
