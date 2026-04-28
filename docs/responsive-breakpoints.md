# SPIRE — responsive breakpoints

Task #185 added the `3xl` Tailwind breakpoint and reworked every operator-
facing screen so the layout scales smoothly from a 1024×768 tablet to a
2560×1440 demo monitor without horizontal scroll, clipping, or wasted
real estate. This doc captures the breakpoint map, the per-screen
contracts, and the `localStorage` keys that store operator preferences.

## Breakpoint map

Tailwind 4 ships these defaults; SPIRE adds `3xl` via the
`--breakpoint-3xl: 120rem` token in `frontend/src/index.css` (`@theme` block).

| Token | Min width   | Tier name           | Typical viewport            |
|-------|-------------|---------------------|-----------------------------|
| —     | 0px         | mobile              | dropped into stacked layout |
| `sm`  | 640px       | small               | (rare for SPIRE)            |
| `md`  | 768px       | medium              | tablet portrait             |
| `lg`  | 1024px      | desktop             | 1024×768 / iPad landscape   |
| `xl`  | 1280px      | wide desktop        | 1280×800                    |
| `2xl` | 1536px      | 1080 tier           | 1920×1080 ≈ 1536px logical  |
| `3xl` | 1920px      | wide-monitor demo   | 2560×1440                   |

SPIRE never targets viewports below `lg`; the stacked fallbacks at `<lg`
exist so a quick portrait rotation, sidebar pop-out, or browser zoom
doesn't trash the layout.

## Per-screen contracts

### TopBar status strip (`frontend/src/components/StatusStrip.tsx`)

* **`<lg` (1024-)** — collapses the four headline chips (Overall MC,
  FPCON, Comms, Alerts) into a single summary chip
  ("MC · FPCON · COMMS · alerts"). Click expands the full chip set
  as an absolute-positioned overlay below the strip; the active view
  canvas is **not pushed**. Mission context still gets its own
  truncated chip on the right.
* **`lg+` (1024+)** — full chip flow with mission pressable on the right.
* Viewport tracked via `matchMedia("(min-width: 1024px)")`.

### BASTION (`frontend/src/views/BastionView.tsx`)

* **Alerts column** (`AlertStreamHeader` + alerts list aside):
  * `<xl` (1024–1279) → 48px rail (`w-12`), severity-tinted, with active-count chip.
  * `xl`–`2xl-` (1280–1535) → 240px (`w-60`), full alert stream, severity filter, search.
  * `2xl+` (1536+) → 288px (`w-72`), legacy density.
  * Map Focus Mode (#37) hotkey `F` forces the rail at every breakpoint.
  * Viewport tracked via `matchMedia("(min-width: 1280px)")` listener so
    the column updates live on resize.
  * **Click-to-expand at `<xl`**: clicking the rail opens the alerts
    content as an **overlay** pinned to the left edge of the map column
    (absolute positioning, `z-20`, `w-72`). The map is **not pushed**.

* **Response drawer** (right `<aside>` when an alert is selected):
  * `<md` → fluid `w-[min(72vw,400px)]` so the schematic stays glanceable behind it.
  * `md`–`xl-` → 400px (legacy width).
  * `xl`–`3xl-` → 28rem (448px).
  * `3xl+` → 32rem (512px) to match the wider alerts column.

* **Map column** (`flex-1 min-w-0`) — `min-w-0` is load-bearing; without it
  MapLibre's intrinsic width measurement was occasionally pushing the
  flex row past the parent on 1024-wide viewports.

### PULSE — `FleetOverviewTab.tsx`

* KPI metric row: `grid-cols-2 md:grid-cols-4`. The four KPI cards
  ("Fleet MC", "Critical Assets", "Parts on Order", "Avg Days NMC")
  collapse to a 2×2 grid below `md` so labels stop truncating mid-word.

### DECISION BRIDGE — `DecisionBridge.tsx`

* **Stage tile grid** (`STAGE_TILES.map`): `grid-cols-1 md:grid-cols-2 3xl:grid-cols-4`.
  At 1920+, the four use-case tiles fan out across the canvas; at 1080,
  they remain 2×2 to keep tile bodies useful.
* **Hero 6×2 grid** (`MissionTile`, `AlertsTile`, `ShortagesTile`,
  `McTile`, `AuditTile`): `grid-cols-2 grid-rows-3 lg:grid-cols-6 lg:grid-rows-2`.
  Below `lg`, the row-spans/col-spans on each tile fold into a 2-column
  3-row stack; from `lg` upward, the original 6×2 hero layout takes
  over and the manually-tuned col-spans (`col-span-2`, `col-span-3`)
  pick up.

### SENTRY — `SentrySplitPane.tsx` (shared)

* Operator-resizable horizontal split component shared by SENTRY's
  Processing and Review screens. Drag the centre handle, double-click
  to reset, Arrow keys nudge by 24px, Home resets.
* Width clamp: `max(180px, 25%)` to `min(container − 180px, 75%)`.
* Each call site supplies its own `storageKey`; the persisted integer
  is the LEFT pane's pixel width.
* Below `lg` the panes stack vertically (left on top, right below); the
  drag handle is hidden because pixel-precise dragging is a desktop
  affordance only. Stack threshold is `matchMedia("(min-width: 1024px)")`.
* First paint with no persisted value falls back to a per-call-site
  ratio (Processing 55/45, Review 62/38) so existing operators see no
  surprise reflow.

### SENTRY — `ProcessingTab.tsx`

* Raw vs Sanitized columns use `<SentrySplitPane>` with
  `storageKey="spire.sentry.processingSplitterPx"`. Default ratio 55/45.

### SENTRY — `ReviewQueueTab.tsx`

* When a record is selected, the queue columns ↔ `InspectorPane` use
  `<SentrySplitPane>` with `storageKey="spire.sentry.splitterPx"`
  (REVIEW owns the canonical short key per Task #185 review pass).
  Default ratio 62/38. With no record selected, the queue columns
  occupy the full row and no splitter mounts.
* Below `lg` the SentrySplitPane stacks columns above the inspector,
  honouring the 1024×768 minimum-resolution requirement.

### AUTH — `AuthView.tsx`

* Cert picker grid: `sm:grid-cols-2 lg:grid-cols-3`. At `lg+` (1024px)
  the four MOCK_USERS certs land in a single row; below `sm` they
  stack vertically.

### ADMIN — `AdminView.tsx`

* Hero stats row: `grid-cols-2 md:grid-cols-4` (parity with PULSE).
* Rolling-accuracy + decision-kind row: `grid-cols-1 lg:grid-cols-2` so
  the two charts stack on narrow viewports rather than getting squished
  side-by-side.

## localStorage keys

| Key                            | Owner                | Shape       | Purpose                                                      |
|--------------------------------|----------------------|-------------|--------------------------------------------------------------|
| `spire.sentry.splitterPx`           | `ReviewQueueTab.tsx` | integer px  | Operator's preferred queue-columns width on the REVIEW splitter (canonical slot per #185 review pass). |
| `spire.sentry.processingSplitterPx` | `ProcessingTab.tsx`  | integer px  | Operator's preferred raw-pane width on the PROCESSING splitter.                                        |
| `spire.bastion.focus_mode`          | `BastionView.tsx`    | `"0"`/`"1"` | Map Focus Mode hotkey toggle (#37) — pre-existing.                                                     |

## Playwright coverage

`tests/playwright/responsive_layout.spec.ts` exercises the full
signed-in route matrix at the five canonical viewports below.

| Viewport     | Tier        | Notes                                       |
|--------------|-------------|---------------------------------------------|
| 1024 × 768   | `lg`-edge   | Smallest supported. Rail-only BASTION.      |
| 1280 × 800   | `xl`-edge   | BASTION alerts column expands to 240px.     |
| 1440 × 900   | `xl`/`2xl-` | Common laptop demo viewport.                |
| 1920 × 1080  | `2xl`       | Standard 1080p demo monitor.                |
| 2560 × 1440  | `3xl`       | Wide-monitor demo. 288px alerts, 4-up tiles.|

Per viewport, the spec asserts:

* `document.documentElement.scrollWidth <= window.innerWidth + 1` — no
  horizontal page scrollbar.
* Per-element overflow check: `getBoundingClientRect().right > viewportWidth + 1`
  is logged and fails the spec when discovered on visible elements
  (so a single chip-row clipping on the right edge is caught even
  if the page itself doesn't scroll).
* The BASTION alerts column is in the rail width (`<= 56px`) at 1024
  and at the configured wide width (`240` / `288px`) at 1280/1536+.
* The DECISION BRIDGE stage tile grid renders 2 columns at 1280 and 4
  columns at 2560.

Run with `npx playwright test responsive_layout.spec.ts`.
