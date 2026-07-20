# SPIRE Bug Bash · Pilot Cohort First Week

Welcome to the pilot. This is a 10-scenario checklist designed to give
the CWO + 2 SSgts realistic exposure to every part of SPIRE in their
first ~3 hours of use. Each scenario has:

- **Setup** — what role to switch to, what view to open.
- **Expected** — what should happen.
- **Try to break it** — where the seams are. File issues here.

File every bug, surprise, and "this should work differently" via the
floating **Report Issue** button (Shift+F) or
https://github.com/jeranaias/spire/issues/new/choose.

---

## Scenario 1 · Cold start as MEF Commander
**Role:** MEF Commander · **View:** auto-routes to BASTION

**Expected:**
- Classification banner reads `UNCLASSIFIED // SYNTHETIC DATA`, FPCON BRAVO.
- BASTION map loads CartoDB Dark Matter tiles centered on Camp Henderson.
- Building polygons visible (motor pools amber, training olive, etc.).
- 10 unit markers show MIL-STD-2525C-lite battalion rectangles with MC%.
- TopBar shows NODE STATUS (MLG-NODE-0), AIR-GAP toggle, AlertBadge.

**Try to break it:**
- Pan/zoom rapidly. Does the map flicker?
- Click every unit marker. Does each open the response panel?
- Try opening BASTION before the tiles fully load. Does anything crash?

---

## Scenario 2 · ThermalHawk simulation
**Role:** MEF Commander · **View:** BASTION · **Action:** click "Simulate ThermalHawk" (red button bottom-left of alert sidebar)

**Expected:**
- Map flies to CLB-6 motor pool over 1.2s.
- 3 cordon rings drop staggered (red 300m, orange 500m, blue 1000m).
- Target reticle spins on the building.
- Classification banner FPCON escalates BRAVO → CHARLIE for 30s.
- Response panel opens on right with a 3-step Immediate / Follow-on
  checklist. Items filtered to MEF Commander summary tier.
- Toast: "FPCON elevated to CHARLIE · ThermalHawk UAS incident active"

**Try to break it:**
- Click Simulate ThermalHawk twice quickly. Does it queue or ignore?
- Wait 30s — does FPCON revert to BRAVO automatically?
- Switch to PULSE during the sim. Is anything stale or lying?

---

## Scenario 3 · GC-4 Fused Threats
**Role:** Security Manager · **View:** BASTION · **Note:** the alert sidebar should already show fused threats above the raw alerts.

**Expected:**
- "◆ Fused Threats · GC-4" panel at the top of the alert sidebar.
- At least 1-2 fused threats present (PACS + UAS coordinated incursion,
  weather + readiness context, multi-gate access pattern).
- Each threat shows the correlation chain (e.g. PACS → ThermalHawk arrows).
- Clicking a threat expands it to show response taskings.

**Try to break it:**
- Trigger a ThermalHawk sim (Scenario 2). Does a CRITICAL fused threat
  surface within 5-10s? It should correlate the sim's UAS alert with
  any open PACS gate event.
- Resolve the sim. Does the fused threat fade out cleanly?

---

## Scenario 4 · GC-1 Autonomous Replenishment
**Role:** G-4 (2d MLG) · **View:** PULSE → Forecast

**Expected:**
- Monte Carlo chart with 30d history + 14d projection, TODAY reference
  line at the seam, p10/p90 envelope visible, three summary cards
  (projected horizon end / P-cross-threshold / first-cross date).
- Below the chart: **Recommended Actions · GC-1** panel with 3-5
  ranked actions per at-risk asset.
- Each action: kind tag (CANNIBALIZE / EXPEDITE / CROSS-LEVEL), MC%
  delta, cost, ETA, confidence, Approve button.

**Try to break it:**
- Approve a CANNIBALIZE action. Toast confirms. Switch to PULSE →
  Cannibalization. Is the new match present?
- Approve an EXPEDITE action. Does the toast say something specific
  about the expedite tier?
- Switch the Forecast horizon (7d / 14d / 30d). Do the recommendations
  re-rank?

---

## Scenario 5 · GC-3 Predictive Failure
**Role:** Maintenance Chief (CLB-6) · **View:** PULSE → Risk Board

**Expected:**
- Top of Risk Board: **Predicted Failures · GC-3** panel listing
  assets likely to fail within the configured horizon.
- Each row: top component prediction (e.g. "engine in 9d"), probability
  bar, criticality chip, "Draft Action" button.
- Engine label visible: `engine: rule_based_v1` (will flip to `j2_v1`
  when J2 weights load).

**Try to break it:**
- Switch the Predicted-Failure horizon (7/14/30d). Does the threshold
  cross meaningfully?
- Click Draft Action on an asset. Does it route to the Risk Board
  filter for that unit so you can pick a Recommend action?

---

## Scenario 6 · GC-5 Coalition Release
**Role:** Data Custodian · **View:** SENTRY → Coalition

**Expected:**
- Profile picker: FVEY · FVEY-LOG · JPN · AUS · PHL.
- Select JPN. Live preview re-scopes:
  - Distribution statement: REL TO JPN per US-JPN MOU.
  - Caveats: REL TO JPN, FOR COALITION EXERCISE.
  - Units allowed/blocked stat with green/red counts.
  - Sample SR records visible with redactions applied (EDIPIs replaced,
    fault components generalized to family).
  - Partner units visible: JGSDF 1st Logistics Brigade, etc.
- Click "Generate Release Package". Toast: release_id created, audit logged.

**Try to break it:**
- Switch profiles rapidly. Does the preview re-scope every time?
- Try Coalition tab as MEF Commander. Should see InsufficientPrivilege
  overlay (data_custodian + security_manager only).

---

## Scenario 7 · GC-7 Air-gap Mode
**Role:** Security Manager · **View:** any

**Expected:**
- TopBar shows AIR-GAP toggle (security_manager + mef_commander only).
- StatusFooter shows green COMMS · CONNECTED pulse.
- Click AIR-GAP. Toggle goes red, ring-pulse halo activates, toast:
  "Air-gap engaged — local writes will be queued".
- StatusFooter changes to red COMMS · AIRGAP. Q:0 chip appears (no
  queued ops yet).
- File a piece of feedback via Shift+F while air-gapped — does it queue?
- Click AIR-GAP again to release. Toast: "Air-gap released — N queued
  ops replayed". Footer reverts to green.

**Try to break it:**
- Toggle air-gap rapidly. Does state stay consistent?
- Watch the audit chain (AdminTab → recent outcomes) — is there a
  comms_airgap_engaged + comms_airgap_released entry pair?

---

## Scenario 8 · GC-6 Training Flywheel
**Role:** Security Manager · **View:** TopBar ADMIN tab (only visible to security_manager)

**Expected:**
- Hero stats row: total outcomes, overall accuracy, pilot feedback count,
  retraining recommendation.
- Engine performance bars showing rule_based_v1 ~78%, j2_v1 ~91%,
  regex_v1 ~83%, llm_gate_v1 ~88% (seeded historical data).
- Rolling accuracy SVG chart with 80%/90% reference lines.
- Per-decision-kind accuracy table.
- Recent outcomes table with 30 entries, contributing notes for
  incorrect calls.
- Pilot feedback panel (filed via Shift+F).

**Try to break it:**
- File feedback via Shift+F. Does it appear in the AdminTab feedback
  panel within 8s?
- Try /admin as a non-security-manager role. Should see InsufficientPrivilege.

---

## Scenario 9 · GC-2 CRDT-style reconciliation
**Role:** Security Manager (or G-4 / MEF Commander) · **View:** any

**Expected:**
- TopBar shows the NODE STATUS chip (e.g. `MLG-NODE-0 · NO PEER`).
- Click chip. Drawer opens with vector-clock cards for local + peer.
- Click "Seed Demo Conflict". A pending conflict appears in the drawer.
- Each side of the conflict shows: actor, timestamp, vector clock,
  payload diff. Pick buttons let you choose winner.
- Toast: "Conflict resolved · local write wins · loser preserved in
  audit chain".

**Try to break it:**
- Seed multiple conflicts rapidly. Do they all show up?
- Resolve them in different orders. Does the audit chain capture each?

---

## Scenario 10 · End-to-end role switch + scope guard
**Action:** Switch through every role via the TopBar dropdown.

**Expected per role:**
| Role | Lands on | Sees | Doesn't see |
|---|---|---|---|
| Maintenance Chief | /pulse | Fleet Overview filtered to CLB-6 (1 unit), Risk Board, GC-1, GC-3 | SENTRY (out-of-scope overlay), no Admin tab, no Air-gap toggle, no Node Status |
| G-4 | /bastion | All BASTION + PULSE for 3 units (CLB-6, 7th ESB, 3d Maint Bn), Node Status | SENTRY (out-of-scope), no Admin tab |
| MEF Commander | /bastion | Everything except SENTRY · Coalition + Mark + Export, Air-gap toggle visible | (no Admin tab — Security Manager only) |
| Data Custodian | /sentry | All SENTRY tabs incl. Coalition + Mark + Export | PULSE / BASTION show out-of-scope overlay |
| Security Manager | /bastion | Everything + Admin tab + Air-gap toggle + Node Status + Mark/Export/Coalition | (none) |

**Try to break it:**
- Switch role mid-action. Does in-flight state survive (especially SENTRY batch)?
- Try direct URL (#/admin) as Maintenance Chief. Should see InsufficientPrivilege.

---

## Where to file your findings

Every "huh, that's weird" is worth filing. Use Shift+F or the floating
"Report Issue" button.

If you find a security/scope leak (a role seeing data outside its
authorization), file via SECURITY.md path, not the public issue tracker.

Three flavors of issue templates available:
- **Bug** — something broke
- **Feature** — something missing
- **Incident** — operational defect (scope leak, classification staleness, audit chain anomaly)

Maintainers triage on the bi-weekly cadence. CWO can label / comment on
all issues; SSgts can comment freely.

Welcome aboard.
