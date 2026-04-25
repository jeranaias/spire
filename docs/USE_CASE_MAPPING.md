# SPIRE — MDM 2026 Use Case Coverage

## TL;DR

**Most teams here picked one of nine use cases. SPIRE solves five — in one operating system, with one synthetic dataset, with the same role scoping and the same audit chain.**

| MDM 2026 Use Case | Category | SPIRE Coverage | Surface |
|---|---|---|---|
| **#2 Inventory Control Management** | Other | ✅ Full | PULSE — 350 assets, GCSS-MC schema mirror, real-time risk board, cannibalization matcher |
| **#5 Parts Demand Forecasting for Contested Logistics** | Predictive Maintenance | ✅✅ Full + extended | GC-1 Monte Carlo readiness forecast (200 paths) + GC-3 component-level failure prediction with auto-drafted requisitions |
| **#6 CUI Auto-Tagging and Classification Assistant** | Data Sanitization | ✅✅ Full + extended | SENTRY — Tier-1 pattern engine (regex_v1) + Tier-2 LLM gate (Gemma 4 26B FP8) per DoDM 5200.01, plus the upstream MARK tab for draft-document classification |
| **#7 Installation Common Operating Picture (I-COP)** | Installation Incident Response | ✅✅ Full + extended | BASTION — real MapLibre map + MIL-STD-2525C unit symbology + GC-4 multi-sensor fusion (PACS + ThermalHawk + SCADA + weather) |
| **#9 TMR Automation** | Other | ✅ Full | BASTION NL bar — Gemma 4 parses *"submit TMR Lejeune to Cherry Point 5 MTVRs Wednesday"* into structured TMR + validates against installation policy + routes approval chain |

**Use cases out of scope (not pretending to cover):**
- #3 Learning Intelligence Dashboard (LID) — already in production at MCU's lms.cucorn.com; different vertical, has incumbents.
- #4 LogTRACE — doctrine-driven consumption; complementary to GC-1 but not what we built.
- #8 Depot Maintenance Throughput Optimizer — depot-side; SPIRE is unit + installation.

## Why one system, not five point solutions

A team building only #5 (parts demand) sees forecast data without knowing which units have which assets, without a coalition release path for sharing the data with JSDF for combined exercises, without a classification engine to redact it, without an installation COP for operational context, without an audit chain to prove the forecast wasn't tampered.

**SPIRE composes them.** Same dataset, same role scoping, same audit chain, same identity layer, same air-gap deployment story. A fixed cost in architecture; a 5x multiplier in operational utility.

## What that means for a pilot

- **Maintenance Chief** wants #2 + #5: gets PULSE-Risk-Board + GC-3 predicted failures.
- **G-4** wants #5 + #9: gets GC-1 recommend-actions + NL TMR parser.
- **MEF Commander** wants #7: gets BASTION COP + GC-4 fused threats.
- **Data Custodian** wants #6: gets SENTRY upstream marking + downstream coalition release.
- **Security Manager** wants the audit chain across all of it.

Five operators, five jobs, one URL.

## Mapping to live evidence

Anyone with the URL can verify each claim:

| Claim | Verification |
|---|---|
| #2 — 350 real assets visible | https://spire-mdm.fly.dev/api/system/status → `dataset.assets: 350` |
| #5 — Monte Carlo forecast | `/api/pulse/forecast?unit=CLB-6&horizon=14` → 200 paths, p10/p90 envelope |
| #6 — LLM classification reachable | `/api/system/status` → `llm.reachable: true`, `model: gemma4-26b-fp8` |
| #7 — Installation COP | `/api/bastion/cop` → 50 buildings, 4 ECPs, 8 rally points, real lat/lon |
| #9 — NL TMR parser live | `POST /api/bastion/nl-query {"text":"submit TMR..."}` → engine: `Gemma4 via RigRun proxy` |

## Built for

Modern Day Marine 2026 AI Forum Hackathon · MARCORLOGCOM CDAO · 27–30 April 2026 · By uniformed USMC personnel on duty time.
