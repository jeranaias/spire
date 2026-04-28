# SPIRO Tool Catalog

> Task #194 — SPIRE MDM 2026 demo — SPIRO tooling expansion

SPIRO ships with **34 tools** across 7 surfaces. Each tool wraps a backend
endpoint or in-process helper; every mutating tool writes a hash-chained
audit row so the SOC view has full forensic coverage of any SPIRO-initiated
action.

| Surface | Tool count |
|---|---|
| Asset / Fleet (legacy) | 7 |
| SENTRY | 5 |
| PULSE | 5 |
| BASTION | 7 |
| DHA RESCUE | 4 |
| System | 4 |
| Audit | 2 |
| **Total** | **34** |

Role gates use the same `frozenset` constants as the regular UI surface
(`backend/scoping.py`), so a session that can't reach a tab can't reach
that tab's tools either.

---

## 1. Asset / Fleet (legacy — pre-194)

| Tool | Role gate | Mutating? | Brevity callout |
|---|---|---|---|
| `find_asset` | any | no | "Look up that asset." |
| `search_assets` | any | no | "Search the roster." |
| `find_cannibalization_match` | any | no | "Find a donor." |
| `recommend_actions` | any | no | "What should I do?" |
| `predict_failures` | any | no | "Predict failures." |
| `get_coalition_view` | any | no | "What does <partner> see?" |
| `status_summary` | any | no | "SITREP." |

## 2. SENTRY

| Tool | Role gate | Mutating? | Brevity callout |
|---|---|---|---|
| `classify_text` | any | no | "Run tier-1 on this." |
| `redact_for_partner` | any | no | "Redact for <partner>." |
| `mark_classification` | SENTRY_REVIEW_ROLES | yes (audit) | "Mark classification." |
| `aggregation_risk` | any | no | "Score aggregation risk." |
| `release_package` | COALITION_RELEASE_ROLES | yes (audit) | "Stage release package." |

## 3. PULSE

| Tool | Role gate | Mutating? | Brevity callout |
|---|---|---|---|
| `forecast_readiness` | PULSE_VIEW_ROLES | no | "Pull the forecast." |
| `risk_explain` | PULSE_VIEW_ROLES | no | "Who's red?" |
| `propose_cannib` | any | yes (audit) | "Propose the cannib." |
| `approve_action` | g4 + mef_commander | yes (audit) | "Approve." |
| `donor_for_part` | any | no | "Donor for that part." |

## 4. BASTION

| Tool | Role gate | Mutating? | Brevity callout |
|---|---|---|---|
| `simulate_thermalhawk` | BASTION_SIMULATE_ROLES | yes (audit) | "Run UAS drill." |
| `resolve_sim` | BASTION_SIMULATE_ROLES | yes (audit) | "Clear sim." |
| `list_alerts` | BASTION_VIEW_ROLES | no | "Alerts up." |
| `acknowledge_alert` | mef_commander + security_manager + g4 | yes (audit) | "Roger — ack." |
| `correlate_threats` | BASTION_VIEW_ROLES | no | "Correlate threats." |
| `installation_status` | BASTION_VIEW_ROLES | no | "Installation status." |
| `dispatch_qrf` | mef_commander + security_manager + g4 | yes (audit) | "Dispatch QRF." |

## 5. DHA RESCUE

| Tool | Role gate | Mutating? | Brevity callout |
|---|---|---|---|
| `blood_inventory` | any | no | "Class VIII status." |
| `advance_scenario` | SCENARIO_CONTROL_ROLES | yes (audit) | "Charlie Mike — advance." |
| `market_sourcing` | any | no | "Source it." |
| `parse_tmr` | any | no | "Parse this TMR." |

## 6. System

| Tool | Role gate | Mutating? | Brevity callout |
|---|---|---|---|
| `mission_clock` | any | no | "Read mission clock." |
| `set_fpcon` | mef_commander + security_manager | yes (audit) | "FPCON CHARLIE." |
| `set_comms` | AIRGAP_ROLES | yes (audit) | "Comms airgap." |
| `reset_demo` | g4 + security_manager | yes (audit) | "Reset demo." |

## 7. Audit

| Tool | Role gate | Mutating? | Brevity callout |
|---|---|---|---|
| `audit_query` | AUDIT_READ_ROLES | no | "Query the chain." |
| `back_brief` | any | no | "Back-brief." |

---

## Persona

SPIRO's persona block (`backend/copilot/planner.py::SYSTEM_PROMPT`) carries
a Marine brevity vocabulary the operator can rely on:

- Affirmative / Negative / Roger / Stand by / Wilco / Copy / Out / Break
- On scope / Off scope / Tracking / Bingo / Winchester
- SITREP / BLUF / Back-brief / Charlie Mike / Oscar Mike

Tone rules:

- 24-hour time only (no AM/PM).
- No emojis, no exclamation points, no marketing language.
- No apologies — Marines fix, they don't say sorry.
- Lead complex answers with `BLUF —` and one sentence.

Refusal templates (verbatim shape):

- Off-scope role: `Negative — off scope. <role> sees that surface; not you.`
- Above authority: `Negative — above my authority. Recommend you escalate to <role>.`
- Missing data: `Stand by — I need <thing>. Run <tool> first.`
- Refused speculation: `Negative — won't speculate on real-world ops. Stick to the dataset.`

---

## Composer chips by role (frontend)

| Role | Chips |
|---|---|
| `g4` | MORNING BRIEF · WHO'S RED · CANNIB |
| `mef_commander` | SITREP · FPCON CHARLIE · BACK-BRIEF |
| `security_manager` | MARK CLASSIFICATION · RELEASE PACKAGE · AUDIT QUERY |
| `data_custodian` | REDACT FOR PARTNER · AGGREGATION RISK |
| `maintenance_chief` | DONOR FOR PART · WHAT'S RED · PREDICT 14d |

Source: `frontend/src/components/Spiro.tsx` `examplesForRole`.

---

## Audit chain coverage

Every mutating tool emits a `spiro.<tool_name>` audit row via
`backend.persistence.log`. The SOC view (`/api/system/admin/audit`) shows
these rows alongside `sentry.*`, `pulse.*`, and `bastion.*` writes, so a
Security Manager can see exactly which SPIRO call set FPCON CHARLIE,
acknowledged which alert, or staged which coalition release.

Mutating tools now receive the caller's DODID through the `caller_dodid`
plumb — the planner's `execute()` reads `request.state.user.dodid` from
`backend/routes/copilot.py::execute_plan` and the runner forwards it via
`inspect.signature` opt-in. The audit row's `actor` field is the operator
who clicked the chip, not a generic `spiro` actor.

---

## Brevity → tool routing

The persona block in `backend/copilot/planner.py::SYSTEM_PROMPT` carries
~25 brevity → tool mappings (e.g. "SITREP" → `status_summary`,
"FPCON CHARLIE" → `set_fpcon{level:CHARLIE}`, "QRF" → `dispatch_qrf`,
"AIRGAP" → `set_comms{mode:airgap}`). The same mappings are mirrored in a
deterministic helper, `route_brevity()`, used by the rule-based fallback
planner so brevity recognition works even with no LLM key configured —
critical for the demo's offline mode and pytest coverage.
