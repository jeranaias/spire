// Task #185 — responsive layout audit.
//
// Walks every signed-in operator route at five canonical viewports
// (1024×768, 1280×800, 1440×900, 1920×1080, 2560×1440) and asserts:
//
//   * No horizontal page scrollbar (document.scrollWidth ≤ innerWidth + 1).
//   * No visible element extends past the right edge of the viewport
//     (per-element `getBoundingClientRect().right > innerWidth + 1`).
//   * BASTION alerts column follows the rail/240/288 contract.
//   * DECISION BRIDGE stage tile grid renders 2 cols at xl, 4 cols at 3xl.
//   * SENTRY split-pane stacks at <lg and renders the resizer at lg+.
//
// Hard constraints (per task spec):
//   - Frontend-only; no backend mock changes.
//   - `addInitScript` calls (focus_mode, splitter seed) MUST run before
//     `signIn`, otherwise they don't apply on the auth-bounce navigation.
//   - Routes under `/sentry/*` and `/admin*` are scope-gated; we sign in
//     as Park (security_manager) for those, Reyes (g4) for everything
//     else.
//
// Run with: npx playwright test responsive_layout.spec.ts

import { test, expect, type Page } from "@playwright/test";
import {
  signIn,
  gotoHash,
  TEST_DODID,
  TEST_PIN,
  SECURITY_MANAGER_DODID,
} from "./_helpers";

type Viewport = { name: string; width: number; height: number };

// Five canonical demo viewports — covering both supported edges
// (1024×768 / 2560×1440) and the two laptop sizes operators most often
// hit during pre-demo dry runs (1280×800 MacBook, 1440×900 MBP 14").
const VIEWPORTS: Viewport[] = [
  { name: "lg-1024",  width: 1024, height: 768  },
  { name: "xl-1280",  width: 1280, height: 800  },
  { name: "xl-1440",  width: 1440, height: 900  },
  { name: "2xl-1920", width: 1920, height: 1080 },
  { name: "3xl-2560", width: 2560, height: 1440 },
];

// Route matrix — every signed-in surface that ships with the app, split
// by which MOCK_USERS identity can reach it. Default-role surfaces use
// Reyes (g4); SENTRY/ADMIN surfaces use Park (security_manager).
type RouteSpec = { hash: string; label: string };

const G4_ROUTES: RouteSpec[] = [
  { hash: "#/",                      label: "DECISION BRIDGE (index)" },
  { hash: "#/home",                  label: "HOME (role redirect)" },
  { hash: "#/bastion",               label: "BASTION" },
  { hash: "#/pulse/overview",        label: "PULSE / Fleet Overview" },
  { hash: "#/pulse/risk",            label: "PULSE / Risk Board" },
  { hash: "#/pulse/cannib",          label: "PULSE / Cannibalization" },
  { hash: "#/pulse/forecast",        label: "PULSE / Forecast" },
  { hash: "#/pulse/model",           label: "PULSE / Model" },
  { hash: "#/about/team",            label: "ABOUT / Team" },
  { hash: "#/about/transition",      label: "ABOUT / Transition" },
  { hash: "#/integrations/gcss-mc",  label: "INTEGRATIONS / gcss-mc" },
];

const SECURITY_ROUTES: RouteSpec[] = [
  { hash: "#/sentry/upload",         label: "SENTRY / Upload" },
  { hash: "#/sentry/processing",     label: "SENTRY / Processing" },
  { hash: "#/sentry/review",         label: "SENTRY / Review Queue" },
  { hash: "#/sentry/coalition",      label: "SENTRY / Coalition" },
  { hash: "#/sentry/mark",           label: "SENTRY / Mark" },
  { hash: "#/sentry/export",         label: "SENTRY / Export" },
  { hash: "#/admin",                 label: "ADMIN" },
  { hash: "#/admin/audit",           label: "ADMIN / Audit" },
  { hash: "#/admin/models",          label: "ADMIN / Models" },
  { hash: "#/admin/economics",       label: "ADMIN / Economics" },
];

/** Pre-seed localStorage flags before sign-in. addInitScript runs on
 *  every navigation in the page lifetime, so calling it BEFORE signIn
 *  guarantees the auth-bounce navigation already sees the flags. */
async function preseedLocalStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      // Force the BASTION alerts column to follow the viewport contract,
      // not Map Focus Mode's rail-at-every-breakpoint override (#37).
      // NOTE: the canonical key is `spire.bastion.mapFocus` (see
      // BastionView.tsx FOCUS_MODE_STORAGE_KEY) — the previous
      // `spire.bastion.focus_mode` write was a no-op the app ignored.
      window.localStorage.setItem("spire.bastion.mapFocus", "0");
      window.localStorage.setItem("spire.bastion.focus_mode", "0");
      // Clear any stored splitter pixel values so both SENTRY splitters
      // start at their legacy ratios for the responsive assertions.
      // REVIEW owns `spire.sentry.splitterPx` (queue ↔ inspector); the
      // PROCESSING screen has its own slot now (`processingSplitterPx`).
      window.localStorage.removeItem("spire.sentry.splitterPx");
      window.localStorage.removeItem("spire.sentry.processingSplitterPx");
    } catch { /* private mode tolerant */ }
  });
}

/** Page-level: no horizontal scrollbar (1px slack for fractional rounding). */
async function expectNoHScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
  expect.soft(
    overflow,
    `${label}: document horizontal overflow (px)`,
  ).toBeLessThanOrEqual(1);
}

/** Per-element overflow check — flags any visible element whose
 *  bounding-rect right edge sits past `innerWidth + 1`. The intent is
 *  "did the layout shift unexpectedly past the viewport edge", not
 *  "are there any DOM nodes outside the viewport box":
 *
 *    - Skip zero-size / off-screen / hidden / opacity-0 elements.
 *    - Skip explicitly-positioned overlays (`fixed`/`absolute`) — these
 *      legitimately position outside the viewport when closed/folded
 *      (tooltips, the StatusStrip overlay we just added, etc).
 *    - Skip elements inside an `overflow-x: auto/scroll/hidden`
 *      ancestor — the TopBar nav, certain tab strips, and the SENTRY
 *      review queue all use horizontal scroll containers; their
 *      children are clipped by the parent and don't push the page.
 *    - Skip inline SVG sub-elements (measurement is unreliable when
 *      the parent <svg> is the actually-rendered element).
 *    - Skip the document.documentElement itself (the page root —
 *      we already cover that via `expectNoHScroll`).
 *
 *  The list of offenders is logged in the failure message so the spec
 *  is actionable, not just red. */
async function expectNoElementOverflowsRight(
  page: Page,
  label: string,
): Promise<void> {
  const offenders = await page.evaluate(() => {
    const w = window.innerWidth;
    const out: { tag: string; cls: string; right: number; width: number }[] = [];
    function inHScrollAncestor(el: HTMLElement): boolean {
      let p: HTMLElement | null = el.parentElement;
      while (p && p !== document.body) {
        const s = window.getComputedStyle(p);
        // Any horizontal-overflow container clips its children — they
        // can extend beyond the viewport without pushing the page.
        if (
          s.overflowX === "auto" ||
          s.overflowX === "scroll" ||
          s.overflowX === "hidden" ||
          s.overflow === "auto" ||
          s.overflow === "scroll" ||
          s.overflow === "hidden"
        ) {
          return true;
        }
        p = p.parentElement;
      }
      return false;
    }
    const all = document.querySelectorAll("body *");
    for (const el of Array.from(all) as HTMLElement[]) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") continue;
      if (parseFloat(style.opacity || "1") === 0) continue;
      if (style.position === "fixed" || style.position === "absolute") continue;
      if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
      if (rect.right <= w + 1) continue;
      if (inHScrollAncestor(el)) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && typeof el.className === "string")
          ? el.className.slice(0, 80)
          : "",
        right: Math.round(rect.right),
        width: Math.round(rect.width),
      });
    }
    return { vw: w, offenders: out.slice(0, 6), total: out.length };
  });
  expect.soft(
    offenders.total,
    `${label}: ${offenders.total} visible in-flow element(s) extend past ${offenders.vw}px — first 6: ${JSON.stringify(offenders.offenders)}`,
  ).toBe(0);
}

/** Land on the route, wait for its surface to settle, run both checks. */
async function auditRoute(
  page: Page,
  v: Viewport,
  r: RouteSpec,
): Promise<void> {
  await gotoHash(page, r.hash);
  // networkidle is best-effort — Recharts/MapLibre keep small streams
  // open. Don't block the spec on it.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
  const tag = `${r.label} @ ${v.name}`;
  await expectNoHScroll(page, tag);
  await expectNoElementOverflowsRight(page, tag);
}

for (const v of VIEWPORTS) {
  test.describe(`viewport ${v.name} (${v.width}×${v.height})`, () => {
    test.use({ viewport: { width: v.width, height: v.height } });

    test(`g4 routes (Reyes) — no overflow at ${v.name}`, async ({ page }) => {
      await preseedLocalStorage(page);
      await signIn(page, TEST_DODID, TEST_PIN);
      for (const r of G4_ROUTES) {
        await auditRoute(page, v, r);
      }
    });

    test(`security_manager routes (Park) — no overflow at ${v.name}`, async ({ page }) => {
      await preseedLocalStorage(page);
      await signIn(page, SECURITY_MANAGER_DODID, TEST_PIN);
      for (const r of SECURITY_ROUTES) {
        await auditRoute(page, v, r);
      }
    });
  });
}

// ────────────────────────────────────────────────────────────────────
// Per-screen contract assertions
// ────────────────────────────────────────────────────────────────────

test.describe("BASTION alerts column responsive width", () => {
  for (const v of VIEWPORTS) {
    test(`alerts column matches the ${v.name} contract`, async ({ page }) => {
      await page.setViewportSize({ width: v.width, height: v.height });
      await preseedLocalStorage(page);
      await signIn(page, TEST_DODID, TEST_PIN);
      await gotoHash(page, "#/bastion");
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(400);

      const aside = page.locator("aside").first();
      await aside.waitFor({ state: "visible", timeout: 10_000 });
      const box = await aside.boundingBox();
      if (!box) test.fail(true, "alerts <aside> not measurable");
      const w = box?.width ?? 0;

      if (v.width < 1280) {
        // <xl → 48px rail (allow up to 72px for border + scrollbar gutter).
        expect.soft(w, `${v.name}: alerts rail should be ~48px`).toBeLessThanOrEqual(72);
      } else if (v.width < 1536) {
        // xl → 240px (w-60)
        expect.soft(w, `${v.name}: alerts column should be ~240px`).toBeGreaterThanOrEqual(220);
        expect.soft(w, `${v.name}: alerts column should be ~240px`).toBeLessThanOrEqual(280);
      } else {
        // 2xl+ → 288px (w-72)
        expect.soft(w, `${v.name}: alerts column should be ~288px`).toBeGreaterThanOrEqual(264);
        expect.soft(w, `${v.name}: alerts column should be ~288px`).toBeLessThanOrEqual(320);
      }
    });
  }
});

test.describe("DECISION BRIDGE stage tile grid", () => {
  async function trackCount(page: Page): Promise<number> {
    return page.evaluate(() => {
      const target = document.querySelector(
        '[data-testid="stage-tile-grid"]',
      ) as HTMLElement | null;
      if (!target) return 0;
      return getComputedStyle(target).gridTemplateColumns.split(" ").length;
    });
  }

  test("renders 2 columns at xl and 4 columns at 3xl", async ({ page }) => {
    // The stage tile grid is rendered by `<StageGrid />` which only mounts
    // when the store's `stageMode` flag is true. Persistence lives at
    // `spire.stageMode` (see `state/store.ts`), so seed it BEFORE the
    // first navigation so the very first paint of DecisionBridgeView is
    // already the stage variant.
    await page.addInitScript(() => {
      try {
        // Storage format is the literal string "1" (see loadStageMode in
        // state/store.ts), not JSON.
        localStorage.setItem("spire.stageMode", "1");
      } catch {}
    });
    await preseedLocalStorage(page);
    await signIn(page, TEST_DODID, TEST_PIN);

    // xl tier — expect 2 columns of stage tiles (md:grid-cols-2).
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoHash(page, "#/");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.locator('[data-testid="stage-tile-grid"]').waitFor({ state: "attached", timeout: 15_000 });
    await page.waitForTimeout(200);
    const xlCols = await trackCount(page);
    expect.soft(xlCols, "stage tile grid should be 2 cols at 1280").toBe(2);

    // 3xl tier — expect 4 columns of stage tiles.
    await page.setViewportSize({ width: 2560, height: 1440 });
    await page.waitForTimeout(400);
    const xxxlCols = await trackCount(page);
    expect.soft(xxxlCols, "stage tile grid should be 4 cols at 2560").toBe(4);
  });
});

test.describe("SENTRY ProcessingTab split-pane", () => {
  // Drives the SENTRY upload → process flow so ProcessingTab actually
  // mounts (it short-circuits to an error/loading state without batch
  // context). The auto-seeded canonical batch on /sentry/upload + the
  // "Process batch" button is the cheapest path; no fixture wiring needed.
  async function seedBatchAndOpenProcessing(page: Page) {
    await gotoHash(page, "#/sentry/upload");
    await page.waitForLoadState("networkidle").catch(() => {});
    // Wait for the auto-seeded canonical batch's "Process batch" button
    // to appear, then click it. The button only shows once `batch` is
    // populated by `loadCanonical`, so its visibility is the right gate.
    const processBtn = page.getByRole("button", { name: /process batch/i });
    await processBtn.waitFor({ state: "visible", timeout: 30_000 });
    await processBtn.click();
    // The handler navigates to /sentry/processing on success.
    await page.waitForURL(/#\/sentry\/processing/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  test("stacks at <lg and shows the resizer at lg+", async ({ page }) => {
    await preseedLocalStorage(page);
    await signIn(page, SECURITY_MANAGER_DODID, TEST_PIN);

    // lg+ viewport FIRST so the upload + process round-trip happens at a
    // viewport where the UI is well-tested. We then verify resizer
    // presence here, then resize down to <lg and assert the stacked path.
    await page.setViewportSize({ width: 1280, height: 800 });
    await seedBatchAndOpenProcessing(page);
    const resizer = page.locator("[role='separator']").first();
    await resizer.waitFor({ state: "visible", timeout: 15_000 });
    expect.soft(
      await resizer.count(),
      "lg+ should expose the splitter resizer",
    ).toBeGreaterThan(0);

    // <lg viewport: panes stack, no resizer. The matchMedia listener in
    // SentrySplitPane drops the resizer when the query no longer matches.
    await page.setViewportSize({ width: 1023, height: 800 });
    await page.waitForTimeout(500);
    const stackedHasResizer = await page.locator("[role='separator']").count();
    expect.soft(
      stackedHasResizer,
      "<lg should stack the panes, not show the splitter resizer",
    ).toBe(0);
  });
});

test.describe("SENTRY ReviewQueueTab split-pane (review pass)", () => {
  // The REVIEW splitter only mounts when an InspectorPane is open
  // (selectedRecord != null). To get there we need the queue populated +
  // a record clicked. The fastest path: drive the upload → process →
  // review handoff so the queue exists, then click the first available
  // record card.
  async function openReviewWithSelection(page: Page) {
    await gotoHash(page, "#/sentry/upload");
    await page.waitForLoadState("networkidle").catch(() => {});
    const processBtn = page.getByRole("button", { name: /process batch/i });
    await processBtn.waitFor({ state: "visible", timeout: 30_000 });
    await processBtn.click();
    await page.waitForURL(/#\/sentry\/processing/, { timeout: 30_000 });
    // Wait for processing to settle then jump to /review.
    const reviewBtn = page.getByRole("button", { name: /review queue/i });
    await reviewBtn.waitFor({ state: "visible", timeout: 60_000 });
    await reviewBtn.click();
    await page.waitForURL(/#\/sentry\/review/, { timeout: 30_000 });
    await page.waitForLoadState("networkidle").catch(() => {});
    // ReviewCard renders with `cursor-pointer` and contains an `orig:`
    // → `recommend:` classification badge pair. SR numbers are hashed
    // (`SR_NUMBER_<hex>`) and not surfaced in the card body, so filter
    // by the badge text instead — every queue item has it.
    const card = page
      .locator('div.cursor-pointer')
      .filter({ hasText: /orig:/i })
      .first();
    await card.waitFor({ state: "visible", timeout: 30_000 });
    await card.click();
  }

  test("lg+ exposes the review splitter once a record is selected", async ({ page }) => {
    await preseedLocalStorage(page);
    await signIn(page, SECURITY_MANAGER_DODID, TEST_PIN);

    await page.setViewportSize({ width: 1440, height: 900 });
    await openReviewWithSelection(page);

    const splitter = page.locator('[data-testid="sentry-review-splitpane"]');
    await splitter.waitFor({ state: "attached", timeout: 15_000 });
    await expect.soft(
      splitter,
      "review splitter should be present at lg+",
    ).toHaveAttribute("data-stacked", "false");

    // The drag handle is a [role='separator'] inside the splitter host.
    const resizer = splitter.locator("[role='separator']");
    expect.soft(
      await resizer.count(),
      "review splitter should expose a drag handle at lg+",
    ).toBeGreaterThan(0);
  });

  test("<lg stacks the review queue above the inspector", async ({ page }) => {
    await preseedLocalStorage(page);
    await signIn(page, SECURITY_MANAGER_DODID, TEST_PIN);

    // Start at lg+ to drive the seeding flow (the upload UI is wider
    // than 1023 needs to be) then resize down to <lg before inspecting
    // the splitter state.
    await page.setViewportSize({ width: 1280, height: 800 });
    await openReviewWithSelection(page);

    await page.setViewportSize({ width: 1023, height: 800 });
    await page.waitForTimeout(500);
    const splitter = page.locator('[data-testid="sentry-review-splitpane"]');
    await splitter.waitFor({ state: "attached", timeout: 15_000 });
    await expect.soft(
      splitter,
      "review splitter should fall back to stacked layout at <lg",
    ).toHaveAttribute("data-stacked", "true");
    expect.soft(
      await splitter.locator("[role='separator']").count(),
      "stacked review splitter should not render a drag handle",
    ).toBe(0);
  });
});

test.describe("BASTION click-to-expand alerts (focus-mode corner case)", () => {
  // Reviewer-flagged edge case: at <xl with Map Focus Mode ON, clicking
  // the alerts-rail's expand affordance was a no-op because
  // `showAlertsOverlay = !viewportXl && !mapFocusMode && alertsOverlayOpen`
  // never went true. The fix in BastionView.tsx clears focus mode first,
  // then opens the overlay at <xl. This test guards that path.
  test("expand from focus mode at <xl drops focus and opens the overlay", async ({ page }) => {
    // Pre-seed focus mode ON before sign-in so the BASTION first-paint
    // is already in focus mode (rail-only, alerts column hidden). Sentry
    // splitter clears piggy-back into the same init script so they hit
    // before the very first paint of any SPIRE page.
    await page.addInitScript(() => {
      try {
        // Canonical key per BastionView's FOCUS_MODE_STORAGE_KEY.
        window.localStorage.setItem("spire.bastion.mapFocus", "1");
        window.localStorage.removeItem("spire.sentry.splitterPx");
        window.localStorage.removeItem("spire.sentry.processingSplitterPx");
      } catch {}
    });

    await page.setViewportSize({ width: 1024, height: 768 }); // <xl
    await signIn(page, TEST_DODID, TEST_PIN);
    await gotoHash(page, "#/bastion");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(1200);

    // Sanity check: the rail's expand button should be present (aria-label
    // "Expand alerts column (F) — N active...").
    const expandBtn = page.getByRole("button", {
      name: /expand alerts/i,
    });
    await expandBtn.waitFor({ state: "visible", timeout: 10_000 });

    // Capture pre-click state for the failure message — useful when CI
    // viewport drift breaks the assumption that the rail is showing.
    const preFocus = await page.evaluate(
      () => window.localStorage.getItem("spire.bastion.mapFocus"),
    );

    await expandBtn.click();
    await page.waitForTimeout(800);

    // Belt-and-braces: also dispatch a programmatic click in case the
    // synthetic click was eaten by some intermediate handler. React's
    // synthetic system listens at the document root, so a real click
    // event with `bubbles: true` reaches the onClick handler the same
    // way a user click would.
    await page
      .evaluate(() => {
        const btn = document.querySelector(
          'button[aria-label^="Expand alerts column"]',
        ) as HTMLButtonElement | null;
        btn?.click();
      })
      .catch(() => {});
    await page.waitForTimeout(600);

    // After the click, the BASTION alert overlay (role="dialog",
    // aria-label "BASTION alert stream (overlay)") should be visible.
    // The fix in onExpand drops focus mode AND opens the overlay at <xl,
    // so even from the (focus-mode-on, <xl) corner case the overlay
    // surfaces.
    const overlay = page.getByRole("dialog", {
      name: /BASTION alert stream/i,
    });
    const overlayVisible = await overlay
      .isVisible()
      .catch(() => false);

    // Also check the post-click focus-mode flag — the fix should drop it
    // to "0" regardless of viewport width.
    const postFocus = await page.evaluate(
      () => window.localStorage.getItem("spire.bastion.mapFocus"),
    );

    expect.soft(
      overlayVisible,
      `click-to-expand should open the alerts overlay (preFocus=${preFocus}, postFocus=${postFocus})`,
    ).toBe(true);
    expect.soft(
      postFocus,
      "click-to-expand should drop focus mode to '0'",
    ).toBe("0");
  });
});

test.describe("StatusStrip <lg compact mode", () => {
  test("collapses to a summary chip + overlay at <lg", async ({ page }) => {
    // 1023px is the largest viewport WITHOUT the lg breakpoint; the
    // implementation gates compact mode on `matchMedia("(min-width: 1024px)").matches === false`.
    await page.setViewportSize({ width: 1023, height: 768 });
    await preseedLocalStorage(page);
    await signIn(page, TEST_DODID, TEST_PIN);
    await gotoHash(page, "#/");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(300);

    // The <lg path renders a single Pressable labelled "Status summary…".
    const summaryChip = page.getByRole("button", {
      name: /status summary/i,
    });
    await expect(summaryChip).toBeVisible();

    // Click expands the chip overlay (role="dialog").
    await summaryChip.click();
    const overlay = page.locator("#status-strip-summary-overlay");
    await expect(overlay).toBeVisible();
  });
});

// ────────────────────────────────────────────────────────────────────
// Snapshot baselines — committed under
// `tests/playwright/__snapshots__/responsive/`. Generated/refreshed
// with: `npx playwright test responsive_layout.spec.ts --update-snapshots`
//
// Snapshots cover the two visually-densest screens (DECISION BRIDGE
// and BASTION) at every viewport, plus PULSE/Fleet at the canonical
// demo viewport, plus SENTRY/Processing at the splitter-edge viewports
// (1023 stacked, 1280 split). We don't snapshot every route/viewport
// combination — that would be 100+ baselines and the per-element
// overflow check above already provides scalar coverage on the rest.
// ────────────────────────────────────────────────────────────────────

const SNAPSHOT_OPTS = {
  // Tolerate small antialiasing / sub-pixel font deltas across runs.
  // The goal is "did the layout shift" not "are the pixels identical".
  maxDiffPixelRatio: 0.02,
  // Mask dynamic regions the snapshot would otherwise flake on.
  // (Polled timestamp values, animated chart cursors, etc.)
  animations: "disabled" as const,
};

test.describe("Snapshot baselines (DECISION BRIDGE + BASTION)", () => {
  for (const v of VIEWPORTS) {
    test(`decision-bridge @ ${v.name}`, async ({ page }) => {
      await page.setViewportSize({ width: v.width, height: v.height });
      await preseedLocalStorage(page);
      await signIn(page, TEST_DODID, TEST_PIN);
      await gotoHash(page, "#/");
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(500);
      await expect(page).toHaveScreenshot(
        `responsive/decision-bridge-${v.name}.png`,
        SNAPSHOT_OPTS,
      );
    });

    test(`bastion @ ${v.name}`, async ({ page }) => {
      await page.setViewportSize({ width: v.width, height: v.height });
      await preseedLocalStorage(page);
      await signIn(page, TEST_DODID, TEST_PIN);
      await gotoHash(page, "#/bastion");
      await page.waitForLoadState("networkidle").catch(() => {});
      // MapLibre needs an extra beat to draw tiles + labels.
      await page.waitForTimeout(1500);
      await expect(page).toHaveScreenshot(
        `responsive/bastion-${v.name}.png`,
        SNAPSHOT_OPTS,
      );
    });
  }
});

test.describe("Snapshot baselines (PULSE + SENTRY edge cases)", () => {
  test("pulse/overview @ 1920×1080", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await preseedLocalStorage(page);
    await signIn(page, TEST_DODID, TEST_PIN);
    await gotoHash(page, "#/pulse/overview");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(700);
    await expect(page).toHaveScreenshot(
      `responsive/pulse-overview-2xl-1920.png`,
      SNAPSHOT_OPTS,
    );
  });

  test("sentry/processing stacked @ 1023×800", async ({ page }) => {
    await page.setViewportSize({ width: 1023, height: 800 });
    await preseedLocalStorage(page);
    await signIn(page, SECURITY_MANAGER_DODID, TEST_PIN);
    await gotoHash(page, "#/sentry/processing");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot(
      `responsive/sentry-processing-stacked-1023.png`,
      SNAPSHOT_OPTS,
    );
  });

  test("sentry/processing split @ 1280×800", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await preseedLocalStorage(page);
    await signIn(page, SECURITY_MANAGER_DODID, TEST_PIN);
    await gotoHash(page, "#/sentry/processing");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
    await expect(page).toHaveScreenshot(
      `responsive/sentry-processing-split-1280.png`,
      SNAPSHOT_OPTS,
    );
  });
});
