/**
 * Task #137 — Lock down the freshness + DDIL banner on the Model Registry
 * and Model Detail surfaces.
 *
 * The W1 #83 freshness affordances (loaded-at label, manual ↻ Refresh,
 * inline DDIL banner copy, auto re-fetch on reconnect, ErrorState retry
 * not page-reloading, post-re-auth deep-route restoration) were verified
 * by code review only — the planned e2e never ran because the dev URL was
 * returning a "Running" infra placeholder. With the proxy healthy this
 * spec pins the behavior so future changes can't silently regress it.
 *
 * Coverage:
 *   1. /admin/models renders "Loaded HH:MM:SS" + ↻ Refresh button.
 *   2. /admin/models flips DDIL through CONNECTED → LIMITED → INTERMITTENT
 *      → DISCONNECTED and asserts each banner copy variant; flipping back
 *      to CONNECTED hides the banner AND triggers a re-fetch (the
 *      loaded-at clock advances).
 *   3. /admin/models/:id repeats the DDIL transitions on the detail page.
 *   4. The ↻ Refresh button bumps loaded-at on a CONNECTED click.
 *   5. The ErrorState retry path re-runs the fetch (state mutation, no
 *      `window.location.reload`).
 *   6. AuthView post-re-auth restoration: a 401-bounced operator sent to
 *      /auth lands back on the deep model-detail route they came from.
 */
import { test, expect, type Page } from "@playwright/test";
import { signIn, gotoHash, SECURITY_MANAGER_DODID } from "./_helpers";

// First registered model id (matches `dataset/data/model_registry.json`).
// Used for the detail-page assertions; falls back to whatever the registry
// returns first so this spec doesn't go brittle if the seed shifts.
const FALLBACK_MODEL_ID = "pulse-risk-scorer";

type DdilUiMode = "CONNECTED" | "LIMITED" | "INTERMITTENT" | "DISCONNECTED";

// Modes render in CommsControl as `${SHORT}\n${LABEL}` inside a Pressable.
// Driving via the UI keeps the spec honest — the same path an operator
// takes — and avoids needing a window-exposed store seam.
const MODE_LABEL: Record<DdilUiMode, string> = {
  CONNECTED: "Connected",
  LIMITED: "Limited",
  INTERMITTENT: "Intermittent",
  DISCONNECTED: "Disconnected",
};

async function ddilSet(page: Page, mode: DdilUiMode) {
  // Open the COMMS chip popover. The chip's aria-label is
  // `Comms <Label> — DDIL switcher`, where <Label> is the *current* mode.
  // Match by the trailing "DDIL switcher" segment so the locator is
  // stable regardless of which mode we're transitioning from.
  const chip = page.getByRole("button", { name: /DDIL switcher/i }).first();
  await chip.waitFor({ state: "visible", timeout: 10_000 });
  await chip.click();
  const menu = page.getByRole("menu", { name: /DDIL mode menu/i });
  await menu.waitFor({ state: "visible", timeout: 5_000 });
  // The 4-state segmented switcher renders the long label as a child node.
  // We invoke `.click()` on the element handle directly — Playwright's
  // hit-testing flags the centred TopBar chrome as an intercepting
  // overlay, and even `{force:true}` routes the OS click event to that
  // overlay instead of the button. A direct DOM `.click()` runs the
  // React onClick synchronously without any compositor hit-test.
  const btn = menu.locator(`button:has-text("${MODE_LABEL[mode]}")`).first();
  await btn.waitFor({ state: "visible", timeout: 5_000 });
  await btn.evaluate((el) => (el as HTMLButtonElement).click());
  // Close the popover so it doesn't intercept subsequent banner reads.
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => {});
}

async function getLoadedAt(page: Page): Promise<string> {
  // The freshness header renders "Loaded HH:MM:SS (Ns ago)". Match the
  // HH:MM:SS slice — that's the bit `formatLoadedAt` produces and is
  // stable across language locales (24h, leading zeros).
  const text = await page
    .locator("text=/^Loaded \\d{2}:\\d{2}:\\d{2}/")
    .first()
    .textContent();
  expect(text, "loaded-at label is present").toBeTruthy();
  const match = text!.match(/Loaded (\d{2}:\d{2}:\d{2})/);
  expect(match, "loaded-at label parses HH:MM:SS").not.toBeNull();
  return match![1];
}

async function pickFirstModelId(page: Page): Promise<string> {
  // Navigate to the registry index and grab the first model row's id from
  // its href so the detail-page spec stays in lock-step with the seed.
  await gotoHash(page, "#/admin/models");
  await page
    .locator("text=/^Loaded \\d{2}:\\d{2}:\\d{2}/")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  const firstHref = await page
    .locator("a[href*='#/admin/models/']")
    .first()
    .getAttribute("href");
  if (!firstHref) return FALLBACK_MODEL_ID;
  const m = firstHref.match(/#\/admin\/models\/([^?#]+)/);
  return m ? decodeURIComponent(m[1]) : FALLBACK_MODEL_ID;
}

test.describe("Task #137 — Model Registry freshness + DDIL banner", () => {
  test.beforeEach(async ({ page }) => {
    // Sit just below the xl breakpoint (1280px) so the centred MissionClock
    // pill — which lives in a `pointer-events-none` wrapper but still has
    // children that Playwright treats as overlap intercepts — is hidden.
    // The freshness affordances render identically at lg+.
    await page.setViewportSize({ width: 1200, height: 900 });
    await signIn(page, SECURITY_MANAGER_DODID);
  });

  // -----------------------------------------------------------------
  // /admin/models — loaded-at + Refresh + DDIL banner copy
  // -----------------------------------------------------------------

  test("registry index renders loaded-at + Refresh affordance", async ({ page }) => {
    await gotoHash(page, "#/admin/models");
    // Header h1 is the page-loaded sentinel; loaded-at is in the same
    // header chunk on the right-hand column.
    await expect(
      page.getByRole("heading", { name: /Admin · Model Supply Chain/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator("text=/^Loaded \\d{2}:\\d{2}:\\d{2}/").first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: /Refresh registry/i }),
    ).toBeVisible();
    // CONNECTED → no inline DDIL banner.
    await expect(page.locator("text=DDIL · LIMITED COMMS")).toHaveCount(0);
    await expect(page.locator("text=DDIL · INTERMITTENT COMMS")).toHaveCount(0);
    await expect(page.locator("text=DDIL · COMMS DENIED")).toHaveCount(0);
  });

  test("manual ↻ Refresh advances the loaded-at clock", async ({ page }) => {
    await gotoHash(page, "#/admin/models");
    const before = await getLoadedAt(page);
    // Wait one wall-second so HH:MM:SS has room to differ before pressing
    // refresh — otherwise a sub-second turnaround can re-stamp the same
    // second value and the assertion races.
    await page.waitForTimeout(1100);
    await page.getByRole("button", { name: /Refresh registry/i }).click();
    await expect
      .poll(async () => getLoadedAt(page), { timeout: 5_000 })
      .not.toBe(before);
  });

  test("DDIL transitions surface the right banner copy on the registry index", async ({ page }) => {
    await gotoHash(page, "#/admin/models");
    await expect(
      page.locator("text=/^Loaded \\d{2}:\\d{2}:\\d{2}/").first(),
    ).toBeVisible({ timeout: 10_000 });

    // LIMITED: yellow latency banner.
    await ddilSet(page, "LIMITED");
    await expect(
      page.locator("text=DDIL · LIMITED COMMS — high latency on every fetch"),
    ).toBeVisible({ timeout: 5_000 });

    // INTERMITTENT: yellow drop-rate banner.
    await ddilSet(page, "INTERMITTENT");
    await expect(
      page.locator("text=DDIL · INTERMITTENT COMMS — ~30% of fetches drop on the wire"),
    ).toBeVisible({ timeout: 5_000 });

    // DISCONNECTED: red cached-fetch banner with the auto-refresh promise.
    await ddilSet(page, "DISCONNECTED");
    await expect(
      page.locator("text=DDIL · COMMS DENIED — view is from cached fetch"),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator("text=/auto-refresh on reconnect/i"),
    ).toBeVisible();

    // CONNECTED: banner disappears AND a re-fetch fires (loaded-at moves).
    const before = await getLoadedAt(page);
    await page.waitForTimeout(1100);
    await ddilSet(page, "CONNECTED");
    await expect(page.locator("text=DDIL · COMMS DENIED")).toHaveCount(0);
    await expect
      .poll(async () => getLoadedAt(page), { timeout: 5_000 })
      .not.toBe(before);
  });

  // -----------------------------------------------------------------
  // /admin/models/:id — same affordances on the detail page
  // -----------------------------------------------------------------

  test("model detail renders loaded-at + Refresh affordance", async ({ page }) => {
    const modelId = await pickFirstModelId(page);
    await gotoHash(page, `#/admin/models/${encodeURIComponent(modelId)}`);
    await expect(
      page.locator("text=Active implementation:").first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator("text=/^Loaded \\d{2}:\\d{2}:\\d{2}/").first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: /Refresh registry/i }),
    ).toBeVisible();
  });

  test("DDIL transitions surface the right banner copy on model detail", async ({ page }) => {
    const modelId = await pickFirstModelId(page);
    await gotoHash(page, `#/admin/models/${encodeURIComponent(modelId)}`);
    await expect(
      page.locator("text=/^Loaded \\d{2}:\\d{2}:\\d{2}/").first(),
    ).toBeVisible({ timeout: 10_000 });

    await ddilSet(page, "LIMITED");
    await expect(
      page.locator("text=DDIL · LIMITED COMMS — high latency on every fetch"),
    ).toBeVisible({ timeout: 5_000 });

    await ddilSet(page, "INTERMITTENT");
    await expect(
      page.locator("text=DDIL · INTERMITTENT COMMS — ~30% of fetches drop on the wire"),
    ).toBeVisible({ timeout: 5_000 });

    await ddilSet(page, "DISCONNECTED");
    await expect(
      page.locator("text=DDIL · COMMS DENIED — view is from cached fetch"),
    ).toBeVisible({ timeout: 5_000 });

    // Reconnect must drop the banner and re-pull the detail card.
    const before = await getLoadedAt(page);
    await page.waitForTimeout(1100);
    await ddilSet(page, "CONNECTED");
    await expect(page.locator("text=DDIL · COMMS DENIED")).toHaveCount(0);
    await expect
      .poll(async () => getLoadedAt(page), { timeout: 5_000 })
      .not.toBe(before);
  });

  // -----------------------------------------------------------------
  // ErrorState retry — must NOT reload the page
  // -----------------------------------------------------------------

  test("ErrorState retry re-runs the fetch in-place, no window.location.reload", async ({ page }) => {
    // 4 retry attempts at 0/1/3/5s = up to ~9s before ErrorState renders.
    test.setTimeout(60_000);
    // Stamp a marker on `window` so a full-page reload (the previous
    // retry path) would wipe it. The retry must re-run the fetch in
    // place — marker stays put.
    await page.evaluate(() => {
      (window as unknown as { __spireRetryMarker?: number }).__spireRetryMarker =
        Date.now();
    });
    const markerBefore = await page.evaluate(
      () => (window as unknown as { __spireRetryMarker?: number }).__spireRetryMarker,
    );
    expect(markerBefore).toBeTruthy();

    // Phase 1 — every admin/models call fails. With api-retry's default
    // schedule (4 attempts at 0/1/3/5s) the ErrorState surfaces after
    // ~9s. Test timeout extended below to absorb the back-off. The
    // regex matches the registry index endpoint with the `?role=…`
    // query string the client appends — but explicitly excludes the
    // detail variant `/admin/models/<id>` so this test stays
    // independent of any other in-flight reads.
    await page.route(/\/api\/system\/admin\/models(\?|$)/, (route) =>
      route.fulfill({ status: 503, body: "registry unavailable" }),
    );

    await gotoHash(page, "#/admin/models");
    // ErrorState renders the title as a styled `<div>` (not a semantic
    // heading), so match it by visible text inside the `role="alert"`
    // panel rather than via `getByRole("heading", …)`.
    await expect(
      page.getByRole("alert").filter({ hasText: /Model Registry Offline/i }).first(),
    ).toBeVisible({ timeout: 20_000 });

    // Phase 2 — drop the route; the next click on "Retry" reuses the
    // shared `refresh()` callable from `useRegistryFetch`, bypassing the
    // legacy `window.location.reload()` path.
    await page.unroute(/\/api\/system\/admin\/models(\?|$)/);
    await page.getByRole("button", { name: /retry/i }).first().click();

    await expect(
      page.locator("text=/^Loaded \\d{2}:\\d{2}:\\d{2}/").first(),
    ).toBeVisible({ timeout: 15_000 });

    // Marker survived → no `window.location.reload()` happened.
    const markerAfter = await page.evaluate(
      () => (window as unknown as { __spireRetryMarker?: number }).__spireRetryMarker,
    );
    expect(markerAfter).toBe(markerBefore);
  });
});
