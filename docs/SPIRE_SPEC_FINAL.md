# SPIRE — Contested Logistics Operating System
# Definitive Technical Specification v4.0
## MDM 2026 AI Forum Hackathon | 27–30 April 2026

---

# PHILOSOPHY

SPIRE is one platform with three views of the same data, designed for three users who share a logistics pipeline:

- The **maintenance chief** creates the data and needs predictions
- The **data custodian** cleans the data and makes it shareable
- The **commander** consumes the operational picture and makes decisions

One upload. Three perspectives. No seams.

The system does the hunting, pecking, cross-referencing, and analysis. The human makes loadbearing decisions — what to approve, what to act on, what to escalate. Everything else is automated.

---

# PLATFORM IDENTITY

**Name:** SPIRE — Sanitization, Prediction, Intelligence, Readiness Engine
**Tagline:** "Contested Logistics. Local Intelligence."
**One-liner:** A locally-hosted logistics operating system that sanitizes data for sharing, predicts equipment failures, and visualizes force readiness — all without a network connection.

## The Three Views

**SENTRY** — Sanitize and secure logistics data for cross-domain sharing
*"What's clean? What's dirty? What can I release?"*

**PULSE** — Predict equipment failures and optimize maintenance decisions
*"What's about to break? Where are the parts? What happens if I don't act?"*

**BASTION** — Visualize force readiness and coordinate operational response
*"Show me my force and what condition it's in, right now, on a map."*

---

# DATA PIPELINE

```
                    INGESTION
                       │
            ┌──────────▼──────────┐
            │   Data Quality &    │
            │   Integrity Check   │  ← "Are these records trustworthy?"
            │   (schema, types,   │
            │    duplicates,      │
            │    impossible vals) │
            └──────────┬──────────┘
                       │
            ┌──────────▼──────────┐
            │      SENTRY         │
            │  Tier 1: HawkStack  │  ← 100K param classifier, <10ms/record, CPU
            │  Tier 2: RigRun LLM │  ← 122B MoE, contextual analysis, GPU
            │  Human Review Queue │  ← Approve / reject / modify
            └──────┬───────┬──────┘
                   │       │
          ┌────────▼──┐  ┌─▼────────────┐
          │ Sanitized │  │   Alerts:    │
          │ Dataset   │  │ • classif.   │
          │ (clean)   │  │   discrepancy│
          │           │  │ • data qual. │
          │           │  │   anomaly    │
          │           │  │ • aggregation│
          │           │  │   risk       │
          └────┬──────┘  └──────┬───────┘
               │                │
     ┌─────────▼─────────┐     │
     │      PULSE         │     │
     │  Risk scoring      │     │
     │  Readiness forecast│     │
     │  Cannibalization   │     │
     │  Anomaly detection │     │
     └────┬──────┬────────┘     │
          │      │              │
          │  ┌───▼───────┐     │
          │  │  Alerts:  │     │
          │  │ • readiness│     │
          │  │   collapse │     │
          │  │ • capability│    │
          │  │   gap      │    │
          │  │ • supply   │    │
          │  │   anomaly  │    │
          │  │ • sys of   │    │
          │  │   record   │    │
          │  │   mismatch │    │
          │  └─────┬─────┘     │
          │        │           │
     ┌────▼────────▼───────────▼────┐
     │          BASTION              │
     │  Unified alert feed          │
     │  Geospatial COP              │
     │  Response checklists         │
     │  + ThermalHawk sensor feed   │
     └──────────────────────────────┘
```

---

# UI DESIGN SPECIFICATION

## Design Language

**Theme:** Dark. Non-negotiable. Every serious defense/intelligence platform (Palantir Gotham, Anduril Lattice, TAK) runs dark. Practical reasons: reduces glare in TOCs and watch floors, easier on eyes during extended ops, signals "operational tool" not "corporate dashboard."

**Color Palette:**
```
Background:         #0A0C13  (near-black, slight blue undertone)
Surface (cards):    #12151E  (elevated surface)
Surface hover:      #1A1E2E  (subtle lift on interaction)
Border:             #1E2235  (barely visible separation)
Border active:      #2A3050  (focused/selected state)

Primary accent:     #3B82F6  (blue — trust, authority, military)
Primary hover:      #2563EB  (deeper blue on interaction)

Danger:             #EF4444  (red — deadlined, critical, rejected)
Danger muted:       #7F1D1D  (red background for alerts)
Warning:            #F59E0B  (amber — degraded, flagged, review)
Warning muted:      #78350F  (amber background)
Success:            #22C55E  (green — MC, cleared, approved)
Success muted:      #14532D  (green background)
Info:               #8B5CF6  (purple — PII flagged)

Text primary:       #E5E7EB  (high contrast, main content)
Text secondary:     #9CA3AF  (labels, metadata, timestamps)
Text muted:         #6B7280  (disabled, placeholder)
```

**Typography:**
- UI labels, navigation, body: Inter (clean, high readability at all sizes)
- Data tables, numbers, metrics, timestamps: JetBrains Mono (monospace alignment for columnar data)
- Large numbers / hero stats: Inter at 32-48px, semibold, with tabular-nums for alignment

**Spacing system:** 4px base unit. All spacing in multiples of 4: 4, 8, 12, 16, 24, 32, 48, 64.

**Border radius:** 6px on cards and containers. 4px on buttons and inputs. 2px on badges and chips. 9999px on status dots and circular indicators.

**Elevation:** No drop shadows. Use border color changes and background color shifts to indicate elevation. Dark themes with drop shadows look muddy. Use a 1px border in #1E2235 for cards, brightening to #2A3050 on hover/focus.

**Animation:** Subtle and purposeful. 150ms ease-out for hover states. 200ms ease-out for view transitions. 300ms for data loading states. No bouncing, no spinning logos, no gratuitous motion. The processing animation in SENTRY should be a smooth scan-line effect — a horizontal bar of blue light sweeping across each record row as it processes, with flagged elements glowing red momentarily before the sanitized version appears.

## Layout Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ ◆ SPIRE   [SENTRY] [PULSE] [BASTION]    🟢 Local │ ⚡ 0    🔍  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│                                                                 │
│                   MAIN CONTENT AREA                              │
│                   (swaps per active view)                        │
│                                                                 │
│                                                                 │
│                                                                 │
│                                                                 │
│                                                                 │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Local Infrastructure │ No Cloud │ AES-256 │ v1.0.0  │ 14:32:07 │
└─────────────────────────────────────────────────────────────────┘
```

### Top Bar (persistent across all views, 48px height)

Left cluster:
- SPIRE logo mark (small geometric spire/obelisk shape, 24px, primary blue)
- "SPIRE" in Inter semibold 14px
- Three tab buttons: SENTRY | PULSE | BASTION
  - Inactive: text secondary color, no background
  - Active: text primary color, subtle blue background (#1A2744), blue bottom border 2px
  - Each tab has a tiny status indicator dot (green if module healthy, amber if degraded, grey if unavailable)

Right cluster:
- System status: green dot + "Local" (or "Lite Mode" in amber when GPU unavailable)
- Alert count: lightning bolt icon + count badge (red if critical alerts exist, amber if warnings, grey if zero)
- Global search: magnifying glass icon that expands to a full query bar on click
  - Placeholder text changes per active view:
    - SENTRY: "Search records, classifications, redactions..."
    - PULSE: "Ask about readiness, equipment, predictions..."  
    - BASTION: "Query installations, incidents, forces..."
  - In Full Mode: NL queries route to RigRun
  - In Lite Mode: keyword search only (query bar border shows amber, tooltip "NL queries require GPU mode")

### Status Footer (persistent, 28px height)

Subtle, low-contrast bar at the very bottom. Always visible. Never distracting.

Content: "Local Infrastructure │ No Cloud │ No Third-Party APIs │ AES-256 Encrypted │ v1.0.0 │ [timestamp updating every second]"

If any condition changes (e.g., encryption disabled for testing), the relevant segment turns amber with a warning icon. This bar is the ambient trust signal — the judge glances down at any moment and sees the security posture.

### Settings / Configuration (gear icon, bottom of sidebar or accessible from top bar)

Panels:
- **Ingestion Sources**: Manual Upload (active, green), GCSS-MC API (greyed, "not connected"), LOGAIS Feed (greyed), DRRS-MC Feed (greyed). Each has a "Configure" button that opens a connection dialog — even greyed out, this signals production readiness.
- **Operating Mode**: Full Mode (GPU) / Lite Mode (CPU) toggle. Shows which capabilities are available in each mode. Green checkmarks for available, grey dashes for unavailable.
- **Classification Rules**: Count of active rules, last updated timestamp, expandable list.
- **Equipment Profiles**: Count of equipment types in the system, defect code count, last updated.
- **Security**: Encryption status, audit log status (hash chain intact: green), session timeout setting, "Secure Wipe" button (red, requires confirmation dialog).
- **Role / View As**: Dropdown to switch between roles for the demo: Maintenance Chief (CLB-6), G-4 (2d MLG), MEF Commander, Data Custodian, Security Manager. Each role sets a default landing view and data filter scope.

---

# VIEW 1: SENTRY — Data Sanitization & Security

## Problem Statement

Marine Corps logistics data is trapped. Maintenance records, supply chain status, equipment readiness reports, and consumption data contain a mixture of UNCLASSIFIED and CUI information — often within the same record. A single maintenance remark might contain a routine fault description alongside an MGRS grid coordinate, a FOUO technical reference, and a maintainer's PII.

Today, there is no automated way to determine what is releasable and what is not. Most of this data simply never gets shared — not because someone reviewed it and said no, but because nobody has the tools or the time to figure out what's clean and what isn't. The result: logistics officers have maintenance data that could improve readiness visibility across the MEF, but it stays locked in the unit that generated it.

## The WOW Factor

The processing view is the signature moment. The judge watches records scroll through with a blue scan-line sweeping across each row. Sensitive elements pulse red as they're detected — a name here, a grid coordinate there, a classified TM reference. The sanitized version appears on the right side simultaneously, clean and green. Running counters tick up at the bottom: "487 processed... 488... 489..." It feels like watching a machine think. It's mesmerizing.

But the deeper wow is the review queue. The judge realizes: the system didn't just flag and forget. Every flagged record is waiting for a human decision. The system did 95% of the work. The human makes the call. That's the moment they trust it.

## Screens

### 1a. Upload & Data Quality

**Layout:** Centered content, generous whitespace. Not cluttered.

Top: "Data Ingestion" header with batch counter ("Batch #7 — 2026-04-28")

Main area: Large drag-and-drop zone (dashed border, 50% of viewport). Accepted formats listed: CSV, XLSX, JSON, TXT. "or click to browse" link. When a file is dragged over, the zone glows blue.

Below drop zone: "Last ingested: synthetic_logistics_500.xlsx — 500 records — 2026-04-28 14:22"

After file drop, before processing:
- File preview: first 10 rows in a mini data table with auto-detected column headers
- Schema auto-mapping: detected columns mapped to canonical fields (SR Number, Equipment, Fault Description, etc.) with green checkmarks for matched, amber for uncertain, red for unmapped
- "Process" button (primary blue, large) and "Configure Rules" link

**Data Quality Gate** (runs before sanitization):
After clicking Process, a quality check runs first. Results appear in an expandable panel:
```
DATA QUALITY REPORT
━━━━━━━━━━━━━━━━━━
✓ 487 of 500 records passed integrity checks (97.4%)
⚠ 8 records: hours decreased from previous entry (impossible — data entry error)
⚠ 3 records: serial number does not match TAMCN
⚠ 2 records: defect code not found in code table

Data Quality Score: 97.4%   [Continue with flagged records] [Exclude flagged records]
```

This gate exists because PULSE will analyze whatever SENTRY passes through. Garbage in = garbage out. The quality check catches it before it becomes a bad prediction. **Records excluded at the data quality gate are not sent to PULSE for risk scoring.** Records that pass with warnings are sent but carry a "data quality flag" that PULSE displays as a yellow indicator on any prediction derived from flagged input.

### 1b. Processing View (the money shot)

**Layout:** Full-width split screen.

Left side (55% width): "Raw Input"
- Records scroll in a table with columns: Record ID, Equipment, Unit, Fault Description
- As each record processes, a blue horizontal scan-line sweeps across the row (150ms)
- If sensitive elements detected: the specific text highlights with a colored glow
  - PII: purple glow (#8B5CF6)
  - Grid coords: blue glow (#3B82F6)
  - Comms/freq: orange glow (#F59E0B)  
  - Classified refs: red glow (#EF4444)
  - The glow fades to a colored underline after 500ms
- If clean: a green checkmark appears at the end of the row, row dims slightly

Right side (45% width): "Sanitized Output"
- Same records appear as they're processed, showing the sanitized version
- Redacted elements shown as colored badges: [PII REDACTED], [GRID GENERALIZED], [COMSEC REDACTED], [CLASSIFIED REF REMOVED]
- Each badge is clickable — shows tooltip with: original value, replacement, confidence, category

Center divider: thin line with directional arrows showing data flow left → right

**Bottom strip (80px height):**
Real-time processing dashboard with animated counters:
```
Records: 347/500 ████████████████░░░░░ 69.4%

Tier 1 (HawkStack): 312 (89.9%)    Tier 2 (LLM): 35 (10.1%)

Flagged:  PII 41  │  GEO 23  │  COMMS 12  │  CLASSIFIED 8  │  MULTI 7
                   │
Clean: 256         │  Classification Discrepancies: 3
                   │  Aggregation Risks: 1
```

Each counter animates as it increments. The Tier 1 vs Tier 2 split is highlighted because it demonstrates the HawkStack cascade — the judge sees that 90% of records were classified by a 100K parameter model in milliseconds.

### 1c. Review Queue

**Layout:** Three-column kanban-style board.

Column 1: "Auto-Cleared" (green header) — Records where Tier 1 confidence > 95% and no sensitive elements detected. Each card shows: Record ID, Equipment, Unit, Quality Score. One-click "Approve All" button at column header. Individual cards can be expanded to see full record.

Column 2: "Flagged for Review" (amber header) — Sensitive elements detected and redacted. Each card shows: Record ID, Equipment, redaction count, redaction types as colored dots. Expanding a card shows the before/after with highlights. "Approve" and "Reject" buttons per card. "Approve Remaining" button at column header.

Column 3: "Held" (red header) — Classification discrepancies, low confidence, or aggregation risks. Each card has a red border and requires individual review. Cannot be bulk-approved. Expanding shows the specific concern: "This record is marked UNCLASSIFIED but contains reference to [CLASSIFIED TM 9-2350-264-20-3]."

**Key detail:** The review queue is where SPIRE becomes trustworthy. The system does 95% of the work. The human reviews and approves. No automated release authority. Show this in the demo and say it explicitly.

### 1d. Aggregation Risk Panel

Accessible from the review queue when an aggregation risk is flagged.

Shows the batch-level analysis:
```
AGGREGATION RISK DETECTED
━━━━━━━━━━━━━━━━━━━━━━━━━

78% of records for HIMARS (TAMCN E1897) at 5/11 Marines show NMCM or NMCS status.

Combined, these records reveal the unit's current fires readiness posture.
Individual records are UNCLASSIFIED. Aggregated dataset may be operationally sensitive.

Recommendation: Restrict release of combined HIMARS readiness data for 5/11 Marines.
Options: [Release with aggregation warning] [Redact unit-level HIMARS data] [Hold for SSO review]
```

### 1e. Export Panel

After review is complete:
- Summary stats: "423 records approved for release. 47 records held. 30 redactions applied."
- Release Authority dropdown: "U.S. Only" / "FVEY" / "NATO" / "Specific Partner"
  - Selection adjusts sanitization rules (NATO release may further generalize unit designators)
- Format: CSV / XLSX / JSON
- Include audit trail: checkbox (default on)
- Distribution statement auto-populated based on release authority selection
- "Export Sanitized Dataset" button (green)
- "Export Redaction Report" button (secondary)
- "Export Full Audit Log" button (secondary)

### 1f. Input Screening (hard stop)

If a user uploads a file containing indicators of classification above the operating level (document headers/footers with "SECRET//NOFORN", metadata indicating a classified source system):

Full-screen red modal. Cannot be dismissed without acknowledgment.
```
⛔ CLASSIFICATION LEVEL EXCEEDED

This file contains indicators of classification above
the current operating level (UNCLASSIFIED).

Detected: Document header marking "SECRET//NOFORN"

Processing rejected. This attempt has been logged.
Contact your Security Manager or SSO.

[Acknowledge]
```

---

# VIEW 2: PULSE — Predictive Maintenance & Readiness

## Problem Statement

Marine Corps equipment readiness is managed reactively. Units track MC/NMC rates in spreadsheets and GCSS-MC, but there is no automated system that predicts which equipment will fail next, which units are trending toward readiness shortfalls, or which parts should be pre-positioned based on failure patterns. Maintenance decisions are made based on experience and gut feel rather than data. Smart cannibalization — identifying which NMC assets have parts needed by higher-priority assets — is done manually by maintenance chiefs walking the motor pool.

## The WOW Factor

The maintenance chief opens PULSE and immediately sees which of their vehicles are about to break. Not after querying a database. Not after pulling a report. The heatmap is right there — CLB-6 is amber and trending red. They click into it and see three JLTVs flagged critical with specific risk scores, specific contributing factors, specific predicted failure types, and a specific recommended action. Then they see the cannibalization match — a deadline JLTV at 2d MLG has the exact part they need, and the system calculated that pulling it has zero impact on 2d MLG's readiness because that vehicle is already waiting for depot repair.

This is the view that makes a Motor T chief say "where has this been my entire career."

## Screens

### 2a. Fleet Overview (landing page for Maintenance Chief role)

**Layout:** Full-width dashboard with hero metrics up top, heatmap below.

**Hero Metrics Bar (4 large stat cards across the top, 100px height):**
```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  FLEET MC   │  │  CRITICAL   │  │  PARTS ON   │  │  AVG DAYS   │
│   78.2%     │  │   ASSETS    │  │   ORDER     │  │    NMC      │
│   ▼ 2.1%    │  │     12      │  │     47      │  │    23.4     │
│  (7 days)   │  │   ▲ 3       │  │   ▼ 5       │  │   ▲ 1.2     │
└─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
```

Each card: large number in JetBrains Mono (tabular-nums), trend arrow with delta, time period label. Card background subtly tinted by status (green/amber/red based on threshold). The numbers should feel like they belong on a Bloomberg terminal — dense, precise, immediately scannable.

**Fleet Readiness Heatmap (main content, 60% of viewport):**

Table layout. Rows = units (CLB-6, CLB-1, 3d Maint Bn, etc.). Columns = equipment types (JLTV, MTVR, M1A1, LAV, HIMARS, etc.). Cells show MC rate as percentage with background color gradient:

- 90-100%: deep green (#14532D bg, #22C55E text)
- 75-89%: amber (#78350F bg, #F59E0B text)
- 60-74%: orange (#7C2D12 bg, #FB923C text)
- Below 60%: red (#7F1D1D bg, #EF4444 text)
- No equipment of this type: dark grey, dash

Clicking any cell drills into that unit × equipment combination, showing individual asset cards.

**Right sidebar (30% width): Alert Feed**
Scrollable feed of PULSE-generated alerts, newest first. Each alert is a compact card:
```
┌─ ⚠ READINESS ALERT ─────────── 14:22 ─┐
│ CLB-6 projected to drop below 75%      │
│ MC rate within 14 days.                 │
│ Contributing: 3 JLTVs critical         │
│ [View Details]                          │
└────────────────────────────────────────┘

┌─ 🔧 CANNIBALIZATION MATCH ─── 14:20 ─┐
│ JLTV USMC-22-01234 at CLB-6 needs     │
│ transmission seal (NSN 2520-01-582-    │
│ 4721). Match: USMC-22-05678 at 2d MLG │
│ (deadline, zero readiness impact).     │
│ [Generate Order]                       │
└────────────────────────────────────────┘

┌─ 📊 SYSTEM MISMATCH ──────── 14:18 ─┐
│ Calculated MC rate for 2d LAR Bn      │
│ (72%) differs from reported (81%).    │
│ 3 assets may be misreported.          │
│ [Review Assets]                       │
└────────────────────────────────────────┘
```

### 2b. Risk Board

**Layout:** Scrollable list of asset risk cards, sorted by risk score descending.

Each card is a horizontal row (80px height):
```
┌──────────────────────────────────────────────────────────────────────┐
│ ████████████████████████████████████░░░░  84  JLTV USMC-22-01234    │
│                                          CLB-6 │ 18,450 mi          │
│ Primary: Transmission fault 2x in 90 days      │ Last maint: 47d ago│
│ Predicted: TRANS failure within 14 days         │ [View] [Action]    │
└──────────────────────────────────────────────────────────────────────┘
```

The risk bar is a horizontal colored bar that fills proportionally to the score. 0-25 green, 26-50 yellow, 51-75 orange, 76-100 red. The bar animates smoothly when the view loads.

Clicking "View" opens the equipment deep dive. Clicking "Action" opens a pre-populated recommendation: "Schedule organizational maintenance within 7 days. Prioritize transmission inspection IAW TM 9-2320-391-20."

**Equipment Deep Dive (expanded view or slide-out panel):**
- Maintenance timeline: horizontal timeline showing every SR, fault event, parts order, and readiness transition over the asset's life. Events are color-coded dots connected by a line. Click any dot for details.
- Fault frequency chart: small bar chart showing fault counts by category over last 12 months.
- Risk score trend: line chart showing how the risk score has changed over time.
- Parts cost cumulative: line chart showing total maintenance cost over time.
- Predicted next failure: card showing predicted failure type, estimated date, confidence score, and contributing factors.

### 2c. Cannibalization Board

**Layout:** Split view.

Left (50%): "Needs Parts" — NMCS assets, each showing the needed part (NSN, nomenclature), how long they've been NMCS, and the impact on unit readiness.

Right (50%): "Available Donors" — matched assets at other units that have the needed part and are already NMC (deadline, depot awaiting). Each match shows:
- Donor asset, unit, and current status
- Readiness impact calculation: "Removing this part has zero impact — donor is deadline awaiting depot return (est. 90+ days)"
- Physical proximity: "Same base" / "Same coast" / "Cross-country"
- "Generate Cannibalization Order" button — produces a formatted document ready for signature

The matches should auto-sort by lowest readiness impact first, then closest proximity.

### 2d. Readiness Forecast

**Layout:** Line chart with forecast overlay.

Solid line: actual MC rate over the last 90 days.
Dashed line: projected MC rate for next 7/14/30 days.
Shaded confidence interval around the dashed line.
Horizontal threshold line at 75% (or whatever the unit's reportable threshold is) in red.

If the forecast crosses below the threshold, the intersection point is marked with a red dot and a label: "Projected below 75% on [date]."

Toggle between unit-level view (one line per unit) and fleet-wide view (aggregate).

### 2e. Feedback Loop

On every prediction card, two small buttons: ✓ "Correct" and ✗ "Incorrect."

When a maintenance chief marks a prediction as correct or incorrect, it logs the feedback for model improvement. Even if the retraining pipeline isn't built for the hackathon, the feedback buttons signal that you understand the model lifecycle. Show the judge: "When the chief says the prediction was wrong, that feedback improves the model over time."

### 2f. Minimum Data Thresholds

Not every asset has enough history for a meaningful prediction. PULSE enforces minimum thresholds:
- **Risk score:** Requires at least 3 maintenance events in the last 12 months. Below that, the risk card shows "Insufficient data — [X] events recorded, 3 required" in muted text instead of a score.
- **Readiness forecast:** Requires at least 14 days of daily readiness snapshots for a unit. Below that, the forecast chart shows the historical line but the projection is greyed out with "Insufficient history for forecast."
- **Cannibalization matching:** Only matches assets that have been NMCS for at least 48 hours (avoids matching assets that might resolve through normal supply channels).

These thresholds prevent PULSE from generating confident-looking predictions from garbage data — which would destroy trust faster than having no predictions at all.

---

# VIEW 3: BASTION — Operations & Response

## Problem Statement

There is no single interface where a logistics commander can see force readiness geospatially, receive correlated alerts from data security, maintenance prediction, and physical security sources, and get auto-generated response guidance — let alone one that works disconnected. Readiness data lives in GCSS-MC. Classification issues live in security manager inboxes. Installation incidents live in PMO logs. The commander's operational picture is assembled manually from these silos. DC I&L has explicitly identified contested installations as a planning priority, and the current binder-and-phone-tree approach was not designed for simultaneous multi-domain incidents with degraded communications.

## The WOW Factor

The map loads and the judge sees the MEF's force posture in one glance. Ten units plotted geospatially, each a circle colored by their MC rate — green, amber, red. Supply routes drawn between logistics bases and units. Parts in transit shown as moving dots along the routes. The commander sees EVERYTHING without opening a single spreadsheet.

Then an alert from PULSE appears — CLB-6 is dropping. The CLB-6 circle pulses amber. Then ThermalHawk detects a drone over CLB-6's motor pool. A red track appears on the map. The system auto-correlates: "UAS detected over facility containing 60% of CLB-6's operational vehicles" and escalates severity to CRITICAL. A response checklist appears in the sidebar. All on one screen. All in 5 seconds.

## Screens

### 3a. Common Operating Picture (landing page for Commander role)

**Layout:** Full-width map with overlay panels.

**The Map (80% of viewport):**

Leaflet.js with dark-themed tiles (CartoDB Dark Matter or Mapbox Dark). No bright white map backgrounds — the tiles should blend with the dark UI.

Layers (toggleable via a small floating layer control, top-right):

**Must-have (build first):**
- Unit positions: circles at each unit's location, sized by total equipment count, colored by MC rate (green/amber/red gradient). Hovering shows tooltip: "CLB-6 | 75.6% MC | 28 JLTV, 15 MTVR, 3 Wrecker"
- Readiness indicators: colored halos around units that have active alerts. Amber halo = readiness warning. Red halo = critical readiness or capability gap.
- Data integrity flags: small amber pin icons at units where SENTRY flagged classification discrepancies or data quality issues. Click for details.
- Sensor feeds: ThermalHawk detection tracks (when active). Drone icons with heading and altitude.

**Nice-to-have (build if time allows):**
- Supply routes: faint lines connecting MCLB Albany, MCLB Barstow to units. Parts in transit shown as small blue dots moving along routes with estimated arrival time on hover.
- Installation detail (when zoomed in): building outlines, ECPs, rally points, motor pools, ASPs.
- Inner ring on unit circles: equipment type breakdown (pie chart style — proportion of vehicles, aircraft, comm, weapons).

**Left sidebar (320px): Alert Stream**

Unified feed pulling from all three sources:
- SENTRY alerts (data/classification issues) — amber shield icon
- PULSE alerts (readiness/maintenance issues) — amber pulse icon
- BASTION alerts (physical/security incidents) — red tower icon
- ThermalHawk alerts (sensor detections) — red drone icon

Each alert card:
```
┌─ 🔴 CRITICAL ──────────── 14:32:07 ─┐
│ UAS DETECTED                         │
│ Over Motor Pool, CLB-6               │
│ Altitude: ~200ft AGL, heading E      │
│                                      │
│ Correlated: Facility contains 60%    │
│ of CLB-6 operational vehicles        │
│                                      │
│ Auto-escalated: HIGH → CRITICAL      │
│                                      │
│ [View on Map] [Response Checklist]   │
└──────────────────────────────────────┘
```

Alerts auto-sort by severity then recency. Critical alerts have a subtle red pulse animation on the left border. Clicking "View on Map" pans and zooms to the relevant location. Clicking "Response Checklist" opens the response panel.

**Right panel (slides out on alert selection): Response Panel**

When an alert is selected, a panel slides from the right showing the auto-generated response:

For a readiness alert:
```
READINESS ALERT RESPONSE
━━━━━━━━━━━━━━━━━━━━━━━

CLB-6 projected below 75% MC within 14 days.

RECOMMENDED ACTIONS:
☐ Notify 2d MLG G-4 (auto-drafted message ready)
☐ Execute cannibalization: pull trans seal from
  USMC-22-05678 at 2d MLG (zero readiness impact)
☐ Escalate 3 critical JLTVs to priority maintenance
☐ Request parts expedite for 2 NMCS vehicles
☐ Update DRRS-MC to reflect projected readiness

NOTIFICATIONS:
☐ 2d MLG G-4: [Draft Ready] [Send]
☐ CLB-6 Motor T Chief: [Draft Ready] [Send]
☐ MEF G-4: Not required (threshold not met)
```

For a UAS detection:
```
UAS INCIDENT RESPONSE
━━━━━━━━━━━━━━━━━━━━━

Detected: Small UAS, Motor Pool, CLB-6
Severity: CRITICAL (auto-escalated — critical asset proximity)

IMMEDIATE ACTIONS (0-5 MIN):
☐ Alert: Giant Voice / Installation notification
☐ Dispatch: PMO to Motor Pool for visual confirmation
☐ Restrict: Lock down ECPs nearest to Motor Pool
☐ Protect: Secure critical equipment (60% of CLB-6 operational vehicles in facility)
☐ Report: Notify Regional C-UAS coordinator

FOLLOW-ON (5-30 MIN):
☐ Request EOD standby if UAS lands/crashes
☐ Preserve CCTV footage
☐ Notify NCIS for investigation
☐ Conduct airspace deconfliction

NOTIFICATIONS:
☐ Installation CO: [Draft Ready] [Send]
☐ PMO Watch Commander: [Draft Ready] [Send]
☐ Regional C-UAS: [Draft Ready] [Send]
```

Checklist items are interactive — click to check off. Timestamps auto-log when each item is completed. This creates the audit trail of the response.

**Notification [Send] behavior:** Clicking "Draft Ready" opens a pre-populated message preview (formatted plain text suitable for email, chat, or radio script). Clicking "Send" in the demo shows a green toast confirmation: "Notification logged — [recipient] — [timestamp]" and logs the event to the audit trail. In the demo, notifications don't actually transmit (no network). In production, this would integrate with email or a messaging API. The key is that the draft content and the send event are both logged for the response audit trail.

### 3b. Incident History

**Layout:** Table of all incidents (historical and active).

Columns: Incident #, Date/Time, Type, Severity, Location, Status (Active/Resolved), Response Time, Alerts Correlated.

Click any row to see full details including response checklist completion status, timeline of actions, and lessons learned.

Filter by: type, severity, date range, unit, status.

### 3c. Force Readiness Overlay (BASTION + PULSE convergence)

This is the view that makes the three modules feel like one system.

Toggle on the "Force Readiness" layer on the map. Now every unit circle shows its PULSE data geospatially:
- Circle color: MC rate (green/amber/red)
- Circle size: total equipment count
- Popup on click: full PULSE readiness summary for that unit — heatmap row, top risk assets, active alerts, forecast

The commander sees force readiness on a map without ever opening PULSE as a separate view. The data flows from SENTRY → PULSE → BASTION automatically.

---

# EMPTY STATES, LOADING STATES & ANIMATION TIMING

## Pre-Data State (first launch / no data loaded)

When SPIRE opens with no data loaded:
- **Top bar:** Fully rendered, all tabs visible but PULSE and BASTION tabs show a subtle "(no data)" label
- **Default view:** SENTRY Upload screen with the drag-and-drop zone centered. Clean, inviting, obvious what to do first.
- **PULSE tab (if clicked before upload):** Hero stat cards show dashes ("—") instead of numbers. Heatmap grid shows unit names in rows and equipment types in columns, all cells show "—" in muted text. A centered overlay message: "Upload maintenance data via SENTRY to populate readiness analytics." This is important — the structure is visible so judges see what it WILL look like.
- **BASTION tab (if clicked before upload):** Map renders with dark tiles and unit positions plotted (from the fleet registry), but all circles are grey with no readiness data. Centered overlay: "Upload maintenance data via SENTRY to populate force readiness." The map itself is already impressive even without data.

## Loading States

- **SENTRY processing:** The split-screen view renders immediately with the left side showing all records statically. Processing begins and the scan-line sweeps from top to bottom. No blank screen, no spinner — the data is visible from the moment processing starts.
- **PULSE calculation:** Skeleton loading cards (dark grey rectangles pulsing subtly) in the hero metrics and heatmap positions, replaced by real data as calculation completes. Takes <2 seconds for 500 records.
- **BASTION map:** Map tiles load progressively (standard Leaflet behavior). Unit circles appear as soon as readiness data is available, even if tiles are still loading. The map is usable before it's fully rendered.
- **Global pattern:** Never show a full-screen spinner. Always show structure (headers, empty tables, skeleton cards) immediately, then fill with data. The app should feel instant even when it's loading.

## Processing Animation Speed

The SENTRY processing view has two modes:
- **Demo mode (default):** Records process in accelerated batches. The scroll shows groups of 10-20 records flashing through with the scan-line, pausing briefly (~500ms) on any record that has a flagged element so the judge can see the highlight. Total processing time for 500 records: 8-12 seconds. Fast enough to feel powerful, slow enough to see what's happening. The counters in the bottom strip tick up smoothly.
- **Detail mode (toggle):** Single-record processing at ~300ms per record. Used if someone asks to slow down and see every individual record. Total time: ~2.5 minutes for 500 records. Useful for review, not for demo.

Default to demo mode during the presentation. Show the toggle exists if asked.

---

# GRACEFUL DEGRADATION

SPIRE must handle failures visibly and honestly.

### LLM Backend Unavailable (Lite Mode)

If RigRun is unreachable or the user selects Lite Mode:
- Top bar status changes: green dot → amber dot, "Local" → "Lite Mode"
- SENTRY: Tier 1 classifier operates normally. Tier 2 shows "LLM unavailable — ambiguous records queued for manual review." A yellow banner appears at the top of the processing view.
- PULSE: Risk scoring operates normally (HawkStack micro model is CPU-based). NL query bar is greyed out with tooltip: "Natural language queries require Full Mode."
- BASTION: Map and alert feed operate normally. NL query bar greyed out.
- The system continues operating with ~90% of functionality.

### Data Quality Failure

If the input data is severely corrupted (>20% of records fail integrity checks):
- Data quality gate shows a red warning: "Data quality below acceptable threshold (X%). Processing may produce unreliable results."
- User can choose to continue with warning or abort.
- If continued, all downstream outputs (PULSE predictions, BASTION overlays) show a yellow "Low Confidence" badge.

### Network Connectivity (when it shouldn't exist)

If the system detects any outbound network call attempt:
- Red alert banner: "Unexpected network activity detected. SPIRE is configured for local-only operation."
- Log the attempt with timestamp and destination.
- This is a security feature — it proves the air-gap claim is enforced, not just asserted.
- **Implementation note:** This requires a backend monitor (Go or Python process) that watches outbound connections at the OS level, not the browser. If running as an Electron app, this is straightforward. If running as a pure web app served locally, the backend API layer handles the monitoring and surfaces the alert to the frontend. Do NOT claim browser-level network detection — it doesn't work that way.

---

# SECURITY ARCHITECTURE

### Data at Rest
- All local data encrypted with AES-256
- SQLite database encrypted with passphrase required at startup
- Session data ephemeral by default — purged on application close unless explicitly saved
- "Secure Wipe" button: overwrites all local data, audit logs, cached model outputs
  - Confirmation dialog: "This will permanently delete all data stored by SPIRE including audit logs. This action cannot be undone. Type CONFIRM to proceed."

### Audit Trail
- Append-only log with hash chaining
- Each entry: timestamp, action, user role, affected record IDs, hash of previous entry
- SHA-256 hash chain — any modification breaks the chain and flags tampering
- Audit log accessible from Security Manager role only
- Export as signed JSON for external verification

### Input Screening
- Pre-processing scan for classification markings above operating level
- Rejects files with SECRET/TS headers, NOFORN markings, classified system metadata
- Hard stop (red modal, cannot bypass)
- All rejection events logged with timestamp and file hash (not content)

### Role-Based Access
- Configurable roles: Maintenance Chief, G-4, Commander, Data Custodian, Security Manager
- Each role has a default view, data scope, and permission set
- Security Manager role: can view audit logs, classification discrepancy reports, input screening logs
- Data Custodian role: can approve/reject sanitized records for release
- Other roles: read-only on SENTRY data, full access to PULSE and BASTION within their scope

---

# HAWKSTACK INTEGRATION

Three HawkStack micro models power the core ML workload:

| System | Component | Parameters | Hardware | Function |
|--------|-----------|-----------|----------|----------|
| SENTRY | Text classifier (Tier 1) | ~100K | CPU | Sensitivity classification |
| PULSE | Failure predictor | ~8K | CPU | Equipment risk scoring |
| BASTION | ThermalHawk-Nano v2 | 1.73M | Hailo-8 | Drone detection |

Total HawkStack parameter budget: ~1.84M parameters across three models.
LLM (Qwen3.5-122B via RigRun) reserved for Tier 2 classification and NL queries only.

All three models trained with cyclic-restart SGDR — the same protocol documented across six domains in the HawkStack technical report.

### Model Training Timing & IP Implications

**Train all three models BEFORE April 27.** This makes them Thornveil pre-existing IP listed in the LICENSE.md. Training during the event makes them government-owned, which limits Thornveil's ability to reuse them. The hackathon products are the frontends, integration code, and datasets — not the model weights.

If the models need adjustment during the event (fine-tuning on better data Adrian provides), document the base weights as Thornveil IP and the fine-tuned delta as government-owned. This is standard practice.

### SENTRY: Cascade Classification

The two-tier cascade is the core architectural pattern. The ~100K parameter HawkStack text classifier (1D text CNN or BiLSTM, SGDR-trained) handles ~90% of records in under 10ms each on CPU. Only ambiguous records (confidence < 90% or class = AMBIGUOUS) route to Tier 2 (RigRun LLM) for contextual analysis. This is the same cascade routing concept already built into RigRun, but with a HawkStack micro model as Tier 1 instead of a heuristic.

### PULSE: ECG-to-Equipment Analogy

The ~8K parameter failure predictor is the MIT-BIH ECG architecture applied to mechanical health telemetry. Both are 1D time-series anomaly detection problems: ECG detects abnormal electrical patterns predicting cardiac events; PULSE detects abnormal operating patterns predicting mechanical failure. The architecture uses a 1D CNN with 3 parallel temporal convolution branches (kernel sizes 3, 7, 15) — the WEM concept applied to temporal data. Kernel sizes span short-term spikes (3), weekly wear patterns (7), and monthly degradation trends (15).

### BASTION: ThermalHawk-Nano IS a HawkStack Model

ThermalHawk-Nano v2 at ~1.73M parameters is built on the WEM-Diamond architecture family — the same family as the 82K DeepPCB model (97.63% mAP) and the 923K PanNuke histopathology model (0.6050 bPQ). It's the HawkStack policy brief made physical: a sub-2M model on an $80 edge accelerator detecting drones in real time without cloud dependency.

### Full HawkStack technical detail

See MDM_Hackathon_Technical_Specs_v3_FINAL.md for the complete HawkStack integration specification including three-parameter topology predictions, gain sequence analysis plans, and training pipeline details for each model.

---

# DEMO SCRIPT (revised for pipeline flow)

**Total time: 8-10 minutes. Led by the logistics SME (Adrian or CWO), technical details by Jesse.**

### Opener (SME, 1 minute)
"I've spent [X] years in Marine Corps logistics. Every week I have maintenance data that could help adjacent units, that could predict failures before they happen, that could show the commander exactly where the force stands. But that data is trapped in GCSS-MC, mixed with PII and CUI, and there's no way to clean it, analyze it, and visualize it in one place. So we built one. This is SPIRE."

### SENTRY Demo (Jesse, 3 minutes)
- Open the platform. Dark interface. Status bar: "Local Infrastructure. No Cloud."
- Role dropdown shows "Data Custodian." "This is the view for the person responsible for releasing data."
- "I'm uploading 500 maintenance records from across the MEF."
- Drag file. Data quality check runs: "487 of 500 passed integrity checks. 13 flagged."
- Processing view: records scroll, blue scan-line, red highlights on sensitive elements. Bottom strip shows Tier 1 handling 90% on CPU.
- "SENTRY just processed 500 records in [X] seconds. The first classification layer is 100,000 parameters. It runs on any laptop."
- Show review queue: "423 auto-cleared, 47 flagged for review, 30 held. The system recommends. The human approves. No automated release authority."
- Show a classification discrepancy: "This record was marked UNCLASSIFIED but references a classified TM. SENTRY caught it."
- Show aggregation risk: "78% of HIMARS records at 5/11 Marines show NMC. Individually they're UNCLASSIFIED. Together they reveal the unit's fires readiness. SENTRY flagged it."

### PULSE Demo (SME/Adrian, 2 minutes)
- Switch role dropdown to "Maintenance Chief — CLB-6." Data scope narrows to CLB-6.
- "I'm a logistics Marine. This is what I see when I log in." (Adrian delivers this — he's the operator, not Jesse.)
- Heatmap shows CLB-6's equipment. Three JLTVs flagged critical.
- "Risk score 84. Transmission fault twice in 90 days, 18,450 miles, 47 days since last maintenance. PULSE predicts transmission failure within 14 days."
- Jesse adds technical context: "This model is 8,000 parameters. Same methodology that detects cardiac arrhythmias."
- Adrian shows cannibalization match. "2d MLG has the exact part on a deadline JLTV. Zero readiness impact. I click Generate Order and hand this to my OIC."
- Show system-of-record mismatch: "Calculated MC rate for 2d LAR is 72%. DRRS-MC shows 81%. Three assets are misreported. This doesn't replace DRRS-MC — it catches what DRRS-MC missed."

### BASTION Demo (CWO or team member, 2 minutes)
- Switch role dropdown to "MEF Commander." Data scope expands to full MEF.
- Click BASTION tab. Map renders with all ten units plotted, colored by readiness.
- "This is what the MEF commander sees. Force readiness on a map."
- Point to CLB-6 amber circle. "The readiness alert from PULSE is right here. The classification discrepancy from SENTRY is here." (amber pins visible)
- "Now watch." Trigger ThermalHawk detection. Drone track appears over CLB-6.
- "That detection is a 1.73 million parameter model running on an $80 edge chip. It just appeared on the same map as the readiness data."
- System auto-correlates: "UAS over facility containing 60% of CLB-6's operational vehicles. Auto-escalated to CRITICAL."
- Show response checklist auto-generated in the sidebar.
- "Same data. Same map. Logistics crisis, data security issue, and physical threat — all coordinated in one picture."

### Close (SME, 1 minute)
"One upload. Three views. Every alert, prediction, and visualization runs on local infrastructure. No cloud. No API keys. No network required. The methodology behind the AI models is published, validated across six domains, and open."

*Hand judges the HawkStack policy brief.*

"The Marine Corps doesn't need more cloud dashboards. It needs intelligence that works when the network is down, the power is intermittent, and the threat is real. That's what SPIRE is."

---

# ANTICIPATED QUESTIONS & ANSWERS

### Data & Integration
**Q: How does this connect to GCSS-MC in production?**
A: SPIRE ingests whatever format the data arrives in. In production, it would sit downstream of a GCSS-MC BI extract via automated feed. The architecture includes an API ingestion layer for GCSS-MC data services. The settings panel shows the connection points — currently manual upload, with GCSS-MC, LOGAIS, and DRRS-MC API slots ready for configuration on a DoD network.

**Q: What about bandwidth in disconnected environments?**
A: 500 maintenance records as CSV is approximately 2MB. SPIRE supports USB/removable media ingestion — export from GCSS-MC to a USB drive, walk it to the SPIRE workstation. The system is designed for sneakernet.

### Security & Trust
**Q: Who validates the sanitization decisions?**
A: SPIRE never auto-releases. Every record passes through a human review queue. Auto-cleared records require one-click approval. Flagged records require individual review. Held records require full analysis. The system does 95% of the work. The human makes the call.

**Q: What if someone uploads actual classified data?**
A: Input screening runs before any processing. Files with classification markings above the operating level are rejected with a hard stop, logged, and the user is directed to their SSO. The system cannot be bypassed.

**Q: What about aggregation risk?**
A: SENTRY runs a batch-level second pass after individual record processing. If the combined dataset reveals operationally sensitive information (e.g., 78% of a unit's weapons systems are NMC), it flags an aggregation risk for human review before any release.

**Q: What about audit trail tampering?**
A: Audit logs are append-only with SHA-256 hash chaining. Any modification breaks the chain and is immediately flagged. In production, audit logs would be replicated to a separate system controlled by the security manager.

**Q: What happens if someone steals the laptop?**
A: All data at rest is AES-256 encrypted, passphrase required at startup. Session data is ephemeral by default. Secure Wipe function available for emergency data destruction.

### Accuracy & Trust
**Q: What if the model is wrong?**
A: Every prediction includes a confidence score and contributing factors. PULSE doesn't say "this will fail." It says "risk score 84 based on these specific factors." The maintenance chief applies their judgment. Feedback buttons on every prediction enable continuous model improvement.

**Q: Why should I trust your numbers over DRRS-MC?**
A: SPIRE does not replace the system of record. When our calculated MC rate differs from DRRS-MC, that discrepancy IS the insight — it means assets may be misreported. SPIRE audits the system of record, it doesn't compete with it.

**Q: What about data quality issues in the input?**
A: SENTRY runs data integrity checks before sanitization: impossible values (hours decreasing), schema mismatches (serial number doesn't match TAMCN), invalid defect codes. A Data Quality Score is generated for each batch, and flagged records can be excluded before analysis.

### Scale & Deployment
**Q: 500 records is a demo. What about MEF-scale data?**
A: Tier 1 processes records in under 10ms each on CPU — 360,000 records per hour without touching the LLM. PULSE's risk scoring model is 8K parameters and processes an entire fleet in seconds. The architecture scales linearly.

**Q: What hardware does a unit need?**
A: Lite Mode (no LLM) runs on any government laptop — the HawkStack micro models are CPU-only. Full Mode requires a GPU workstation comparable to what already exists at MLGs for engineering applications. 90% of the value is in Lite Mode.

**Q: What about ATO?**
A: SPIRE operates at UNCLASSIFIED as a standalone system, simplifying the RMF process. Architecture aligns with NIST 800-171 and DoD 8500.01. The team has prior ATO packaging experience (MARDET POM Tutor App, FISMA Low 100%).

### Strategic
**Q: How is this different from what MARCORLOGCOM is already building?**
A: MARCORLOGCOM's enterprise analytics require garrison network connectivity. SPIRE fills the gap for the disconnected, forward-deployed environment where enterprise tools can't reach. When the network is up, SPIRE feeds the enterprise. When it's down, SPIRE operates independently. It's complementary, not competitive.

**Q: Who owns this after the hackathon?**
A: Hackathon products (frontends, integration layer, datasets) are government-owned per the LICENSE.md. Thornveil's pre-existing IP (RigRun, HawkStack, ThermalHawk) is available under a limited government license for evaluation and prototyping. Continued operational use requires a separate agreement. Thornveil is an active defense tech company with 22 patents and active SBIR proposals — this doesn't disappear on April 30th.

**Q: What about model updates and maintainability?**
A: Detection rules, equipment profiles, and classification rules are configuration files, not hardcoded. New TAMCNs, defect codes, and sanitization rules are JSON updates. HawkStack models retrain via the same SGDR pipeline. The LLM backend is model-agnostic via an OpenAI-compatible API layer — swap models with zero application code changes.

**Q: Have you red-teamed the sanitization?**
A: Tier 1 catches standard-format sensitive data via pattern matching. Tier 2 (LLM) catches obfuscated or non-standard representations — RigRun's adversarial detection blocked 53/53 tested attacks. But no system is adversary-proof, which is precisely why every record goes through human review. The system recommends. The human approves.

**Q: Can you show me what happens when it fails?**
A: Yes. [Kill LLM backend.] SENTRY continues processing in Tier 1 only mode. Yellow banner appears: "LLM unavailable — operating in pattern-match mode." 90% of records still process normally. Ambiguous records queue for review when the backend reconnects. PULSE risk scoring continues — it's a CPU-only HawkStack model, independent of the LLM. BASTION map and alerts continue. The system degrades gracefully instead of crashing.

### Adoption & Usability
**Q: My Marines can barely use GCSS-MC. What makes you think they'll adopt another tool?**
A: Each role has one primary screen. The maintenance chief sees a readiness heatmap — red means bad, green means good, click for details. The data custodian sees a drag-and-drop zone and a review queue — drag file, review results, approve or reject. The commander sees a map with colored dots. Every workflow completes in two clicks or fewer. If a Marine has to read a manual to figure out what to do, we've failed. [Have Adrian demo this — an operator who didn't build the system walking through it cold.]

**Q: What about OPSEC if someone steals the laptop?**
A: All data at rest is AES-256 encrypted with a passphrase required at startup. Session data is ephemeral by default — closing the app purges processed data unless the user explicitly saves. The Secure Wipe function overwrites all local data for emergency situations. In production, this layers on top of the device's own full-disk encryption.

**Q: What does deployment actually cost per unit?**
A: Lite Mode runs on any existing government laptop — zero additional hardware cost. Full Mode requires a GPU workstation ($15-20K) comparable to what already exists at MLGs for engineering applications. 90% of the platform's value is in Lite Mode. The HawkStack micro models are the core ML workload and they're CPU-only.

---

# REPO STRUCTURE

**State management:** Use Zustand — lightweight, no boilerplate, easy to share state across views. The `useSpireData` hook wraps a Zustand store that holds the current dataset, processing results, alert stream, risk scores, and role/scope selection. All three views read from the same store. SENTRY writes to it when processing completes. PULSE reads from it to calculate risk. BASTION reads from it to render the map. One store, three consumers.

**Dataset generation:** The `dataset/` directory contains the simulation engine for generating synthetic logistics data. See **MDM_Dataset_Engine_Design.md** for the complete 1,200-line specification covering fleet generation, fault injection, maintenance remarks, sensitive data rules, supply chain simulation, and consistency validation. Build the dataset engine FIRST — SENTRY and PULSE both depend on its output.

```
spire/
├── README.md
├── LICENSE.md
├── package.json
│
├── shared/
│   ├── config/
│   │   ├── colors.ts           # Design tokens (all colors from this spec)
│   │   ├── equipment.json      # Equipment profiles, TAMCNs, fault data
│   │   ├── defect_codes.json   # GCSS-MC defect code pairs
│   │   ├── sanitization.json   # Classification rules, redaction templates
│   │   └── installation.json   # Building DB, ECPs, response forces (BASTION)
│   ├── components/
│   │   ├── TopBar.tsx          # Persistent top navigation bar
│   │   ├── StatusFooter.tsx    # Persistent security status footer
│   │   ├── AlertCard.tsx       # Reusable alert card component
│   │   ├── StatCard.tsx        # Hero metric card
│   │   ├── DataTable.tsx       # Sortable/filterable data table
│   │   ├── NLQueryBar.tsx      # Natural language query input
│   │   ├── ReviewCard.tsx      # Review queue card (approve/reject)
│   │   ├── RiskBar.tsx         # Horizontal risk score bar
│   │   └── SecureWipeDialog.tsx
│   ├── hooks/
│   │   ├── useSpireData.ts     # Central data store hook
│   │   ├── useAlerts.ts        # Alert stream management
│   │   └── useRigRun.ts        # RigRun API client (Full/Lite mode aware)
│   ├── utils/
│   │   ├── classification.ts   # Tier 1 regex patterns, confidence scoring
│   │   ├── sanitization.ts     # Redaction rule engine
│   │   ├── dataQuality.ts      # Integrity checks (hours decreasing, schema mismatch)
│   │   ├── aggregationRisk.ts  # Batch-level aggregation analysis
│   │   ├── auditLog.ts         # Append-only hash-chained audit logger
│   │   ├── inputScreening.ts   # Classification marking detector (hard stop)
│   │   ├── riskScoring.ts      # PULSE failure risk algorithm
│   │   ├── cannibalization.ts  # Cross-unit part matching
│   │   ├── forecast.ts         # Readiness projection logic
│   │   └── encryption.ts       # AES-256 data-at-rest wrapper
│   └── types/
│       └── index.ts            # TypeScript interfaces for all data structures
│
├── sentry/
│   ├── UploadView.tsx          # Drag-drop, schema mapping, data quality gate
│   ├── ProcessingView.tsx      # Split-screen real-time processing animation
│   ├── ReviewQueue.tsx         # Three-column kanban (auto-cleared/flagged/held)
│   ├── AggregationPanel.tsx    # Aggregation risk display
│   ├── ExportPanel.tsx         # Release authority, format selection, export
│   └── InputScreeningModal.tsx # Red hard-stop modal for classified input
│
├── pulse/
│   ├── FleetOverview.tsx       # Hero metrics + heatmap + alert sidebar
│   ├── RiskBoard.tsx           # Scrollable risk-scored asset cards
│   ├── EquipmentDive.tsx       # Maintenance timeline, fault charts, prediction
│   ├── CannibalizationBoard.tsx # Split-view needs/donors matching
│   ├── ReadinessForecast.tsx   # Line chart with projection overlay
│   └── FeedbackButton.tsx      # Correct/Incorrect prediction feedback
│
├── bastion/
│   ├── COPMap.tsx              # Leaflet map with all overlay layers
│   ├── AlertStream.tsx         # Unified alert feed from all sources
│   ├── ResponsePanel.tsx       # Auto-generated checklists with check-off
│   ├── IncidentHistory.tsx     # Historical incident table
│   ├── ForceReadinessLayer.tsx # PULSE data rendered geospatially on map
│   └── ThermalHawkSim.tsx      # Simulate detection button + mock feed
│
├── dataset/
│   ├── main.py                 # Orchestrator
│   ├── config.py               # Constants, lookup tables, probabilities
│   ├── fleet.py                # Fixed fleet generation (~500 assets)
│   ├── personnel.py            # Synthetic Marine roster (~200)
│   ├── lifecycle.py            # 365-day operation simulation
│   ├── faults.py               # Equipment-specific fault injection
│   ├── supply.py               # Parts requisition and supply chain
│   ├── remarks.py              # Maintenance remark generation (templates)
│   ├── sensitive.py            # Context-appropriate sensitive data injection
│   ├── consistency.py          # Cross-record consistency validation
│   ├── incidents.py            # Installation incident log generation
│   └── export.py               # XLSX formatting and output
│
├── models/
│   ├── sentry_classifier/      # HawkStack text classifier weights + config
│   ├── pulse_predictor/        # HawkStack 1D temporal CNN weights + config
│   └── thermalhawk/            # ThermalHawk-Nano v2 weights + config
│
├── presentation/
│   ├── demo_script.md          # The exact demo script from this spec
│   ├── qa_cheatsheet.md        # All anticipated Q&A from this spec
│   ├── slides/                 # Presentation deck
│   └── hawkstack_brief.pdf     # Policy brief (print 20+ copies)
│
└── App.tsx                     # Root: top bar, view router, status footer
```

---

# BUILD PRIORITY ORDER

1. **Dataset engine** (shared/dataset/) — SENTRY and PULSE both depend on this. Build and validate first. Run consistency checks. Get Adrian to review the data for realism.

2. **Shared design system** (shared/components/, shared/config/colors.ts) — Top bar, status footer, alert cards, stat cards, data tables. These are used everywhere. Build once, use in all three views.

3. **SENTRY** — Upload → Data Quality → Processing → Review Queue → Export. This is the data entry point. Nothing else works without it.

4. **PULSE** — Fleet Overview → Risk Board → Cannibalization → Forecast. This is the view the judges will relate to most.

5. **BASTION** — COP Map → Alert Stream → Response Panel → ThermalHawk sim. This is the wow finish.

6. **Integration** — Wire alerts from SENTRY and PULSE into BASTION's feed. Add the Force Readiness layer to the map. This is what makes it feel like one system.

7. **Polish** — Animations, transitions, graceful degradation states, role switching, the "kill the LLM" demo.

8. **Presentation** — Slides, demo script rehearsal, Q&A prep, print policy briefs.

---

# RUNTIME ARCHITECTURE

SPIRE runs as a **locally-served web app** (React frontend served by a local Python/Go backend on localhost). This is the simplest approach for the hackathon and avoids Electron packaging complexity. The backend handles file processing, risk scoring, audit logging, and RigRun API proxying. The frontend is pure React served as static files.

**Implication for features:** File system access (upload, export, secure wipe) works through the backend API, not browser APIs. The network activity monitor runs as a backend process watching outbound connections at the OS level. Encryption at rest is handled by the backend's SQLite layer. None of these require Electron.

**For production:** An Electron wrapper would enable desktop distribution, native file system integration, and tighter OS-level security controls. But for a hackathon demo, localhost web app is correct.

---

# SHORTENED DEMO CONTINGENCY

If judges say "you have 5 minutes, not 10":

**Cut version (5 min):**
- Opener (SME, 30 sec): same opening, tighter
- SENTRY (Jesse, 90 sec): upload → processing view → show one classification discrepancy → "423 auto-cleared, human approves"
- PULSE (Adrian, 90 sec): heatmap → click CLB-6 → risk score 84 → cannibalization match
- BASTION (30 sec): map with units → trigger ThermalHawk → "same map, three threat types coordinated"
- Close (SME, 30 sec): "One upload. Three views. Local infrastructure." Hand over policy brief.

**What to cut first:** Aggregation risk, system-of-record mismatch, data quality gate walkthrough, export panel, readiness forecast chart, incident history. These are impressive features but the core story (sanitize → predict → visualize) lands without them.

**What to NEVER cut:** The processing animation in SENTRY (it's the visual hook), the risk score in PULSE (it's the operator value), the drone detection in BASTION (it's the wow finish), and the role-switching (it's the collaboration story).

---

# NAMING

**SPIRE** — Sanitization, Prediction, Intelligence, Readiness Engine

Every letter maps to a core function. No filler words. Verified no DoD program conflicts.

The word evokes a high vantage point — seeing everything from above. The commander sees force readiness from the SPIRE. The maintenance chief sees what's about to break. The data custodian sees what's clean and what's dirty. Three views, one elevated perspective.

Module names under SPIRE: **SENTRY** (data layer), **PULSE** (analytics layer), **BASTION** (operations layer).
