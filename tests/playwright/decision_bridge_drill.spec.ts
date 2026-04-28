/**
 * Decision Bridge per-row drill — Task #159 (verifies Task #45 wiring).
 *
 * The Decision Bridge (`/`) renders three row-style tiles whose individual
 * rows must drill into a *preselected* destination, while a click on the
 * tile's header strip opens the same destination *without* preselection:
 *
 *   AlertsTile     row → /bastion + selectedBuildingId & selectedUnitId set
 *                  hdr → /bastion + no preselection
 *   ShortagesTile  row → /pulse/forecast + ForecastTab unit dropdown set
 *                  hdr → /pulse/forecast + dropdown == FLEET
 *   McTile         row → /pulse + selectedUnitId set
 *                  hdr → /pulse + no preselection
 *
 * Why this spec hits the live dev server:
 * Task #45 stitched four moving parts (DecisionBridge tiles, the Zustand
 * store, the destination view's deep-link consumer, and HashRouter
 * navigation). A unit test of any one piece can pass while the full chain
 * is broken — Task #159 is the integration backstop that proves the
 * end-to-end behaviour is intact every time the suite runs.
 *
 * Visibility note for the preselection assertions:
 *   - Shortages → ForecastTab consumes `location.state.unit` to seed its
 *     <select> value. We assert the dropdown directly.
 *   - Alerts   → BastionView's MapCanvas consumes selectedBuildingId via
 *     a MapLibre WebGL paint layer (a building outline + sticky popup).
 *     The popup IS rendered as DOM — but its appearance is gated on
 *     MapLibre's tile load, which is flaky in headless. We assert the
 *     authoritative store state set by AlertsTile.drillToAlert via the
 *     dev-only `window.__spireStore` test bridge.
 *   - MC%      → McTile sets selectedUnitId in the store, but
 *     FleetOverviewTab (the default `/pulse` tab) does NOT currently
 *     consume it (no visible reflection in the heatmap). We assert the
 *     store state via the same test bridge — that's the contract Task #45
 *     established at the bridge's edge. A follow-up wiring task would
 *     surface this in the heatmap UI.
 *
 * Header-strip drills are negative-asserted: we reset the store to null
 * before clicking the header, click, then re-read to confirm the
 * preselection was NOT touched by a header-only navigation.
 */
import { test, expect, type Page } from "@playwright/test";
import { signIn, gotoHash, TEST_DODID } from "./_helpers";

// Pull a value from the dev-only Zustand bridge attached in main.tsx
// (`window.__spireStore`). Returns null if the store is not exposed —
// that almost certainly means the dev server bundled in production mode
// and the spec should fail loudly rather than silently pass.
async function readStore<T>(page: Page, key: "selectedBuildingId" | "selectedUnitId"): Promise<T | null> {
  return await page.evaluate((k) => {
    const w = window as unknown as { __spireStore?: { getState: () => Record<string, unknown> } };
    if (!w.__spireStore) return null;
    return (w.__spireStore.getState()[k] as T | null) ?? null;
  }, key);
}

async function resetStorePreselection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __spireStore?: { getState: () => Record<string, unknown> } };
    const s = w.__spireStore?.getState() as
      | { setSelectedBuildingId?: (v: string | null) => void; setSelectedUnitId?: (v: string | null) => void }
      | undefined;
    s?.setSelectedBuildingId?.(null);
    s?.setSelectedUnitId?.(null);
  });
}

// All three tiles can take a moment to paint after the bridge mounts —
// the API calls are pollWithBackoff'd so first paint can lag a couple
// hundred ms behind navigation. 15s is generous; the actual budget is
// usually < 2s.
const TILE_TIMEOUT = 15_000;

test.describe("Decision Bridge per-row drill — Task #45 wiring (#159)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, TEST_DODID);
    await gotoHash(page, "#/");
    // Confirm the dev test bridge is present — without it the per-row
    // assertions for Alerts and MC% are meaningless. Fail fast if the
    // dev server somehow served a production bundle.
    await page.waitForFunction(
      () => Boolean((window as unknown as { __spireStore?: unknown }).__spireStore),
      null,
      { timeout: 10_000 },
    );
  });

  test("Alerts tile: row drills to BASTION with building+unit preselected; header drills generically", async ({ page }) => {
    // ----- Row click -----
    await resetStorePreselection(page);

    // First alert row — Pressable aria ends with "open in BASTION".
    const firstAlertRow = page.locator('button[aria-label$="open in BASTION"]').first();
    await firstAlertRow.waitFor({ state: "visible", timeout: TILE_TIMEOUT });
    const rowAria = await firstAlertRow.getAttribute("aria-label");
    expect(rowAria, "alert row should expose its severity/title/unit via aria-label").toBeTruthy();

    await firstAlertRow.click();

    // URL lands on /bastion (HashRouter → window.location.hash).
    await page.waitForFunction(
      () => window.location.hash === "#/bastion",
      null,
      { timeout: 10_000 },
    );
    expect(page.url()).toMatch(/#\/bastion$/);

    // Preselection: the bridge's drillToAlert(a) sets BOTH selectedBuildingId
    // (resolved via resolveAlertTarget against the COP) AND selectedUnitId
    // (the alert's unit, when present). We assert the building was set;
    // when the row aria-label encodes a unit (format `${sev} · ${title} ·
    // ${unit} — open in BASTION` per DecisionBridge.tsx ~L467) we also
    // assert that unit landed in the store. Without the unit assertion
    // the spec would silently regress if drillToAlert ever stopped
    // mirroring alert.unit into selectedUnitId.
    const selBuilding = await readStore<string>(page, "selectedBuildingId");
    expect(selBuilding, "AlertsTile row click should set selectedBuildingId in the store").toBeTruthy();

    const alertUnitMatch = rowAria!.match(/^[^·]+ · [^·]+ · ([^—]+?) — open in BASTION$/);
    if (alertUnitMatch) {
      const expectedAlertUnit = alertUnitMatch[1].trim();
      const selUnit = await readStore<string>(page, "selectedUnitId");
      expect(
        selUnit,
        `AlertsTile row click should set selectedUnitId="${expectedAlertUnit}" when the alert carries a unit`,
      ).toBe(expectedAlertUnit);
    }

    // ----- Tile-header click -----
    await gotoHash(page, "#/");
    await resetStorePreselection(page);

    // The Tile header Pressable's aria-label is "<label> — <drillLabel>".
    // For AlertsTile that's exactly "Top Alerts (10s) — BASTION".
    const alertsHeader = page.locator('button[aria-label="Top Alerts (10s) — BASTION"]');
    await alertsHeader.waitFor({ state: "visible", timeout: TILE_TIMEOUT });
    await alertsHeader.click();

    await page.waitForFunction(
      () => window.location.hash === "#/bastion",
      null,
      { timeout: 10_000 },
    );
    expect(page.url()).toMatch(/#\/bastion$/);

    const selBuildingAfterHeader = await readStore<string>(page, "selectedBuildingId");
    const selUnitAfterHeader = await readStore<string>(page, "selectedUnitId");
    expect(
      selBuildingAfterHeader,
      "AlertsTile header click must NOT set selectedBuildingId (header drills generically)",
    ).toBeNull();
    expect(
      selUnitAfterHeader,
      "AlertsTile header click must NOT set selectedUnitId (header drills generically)",
    ).toBeNull();
  });

  test("Shortages tile: row drills to PULSE forecast with unit preselected in dropdown; header drills generically", async ({ page }) => {
    // ----- Row click -----
    await resetStorePreselection(page);

    // First shortage row — aria ends with "open in PULSE forecast".
    const firstShortageRow = page.locator('button[aria-label$="open in PULSE forecast"]').first();
    await firstShortageRow.waitFor({ state: "visible", timeout: TILE_TIMEOUT });
    const rowAria = await firstShortageRow.getAttribute("aria-label");
    expect(rowAria).toBeTruthy();

    // Extract the drill_unit from the aria-label. Format (DecisionBridge.tsx
    // line ~550):
    //   `${s.label} ${s.item}${s.drill_unit ? ` · ${s.drill_unit}` : ""} · H+${h}h — open in PULSE forecast`
    // The drill_unit (when present) is the segment between the LAST " · "
    // and " · H+". If absent the row's preselection is naturally a no-op
    // and we degrade to URL-only assertion.
    const drillUnitMatch = rowAria!.match(/ · ([^·]+?) · H\+\d+h — open in PULSE forecast$/);
    const drillUnit = drillUnitMatch ? drillUnitMatch[1].trim() : null;

    await firstShortageRow.click();

    // URL lands on /pulse/forecast.
    await page.waitForFunction(
      () => window.location.hash === "#/pulse/forecast",
      null,
      { timeout: 10_000 },
    );
    expect(page.url()).toMatch(/#\/pulse\/forecast$/);

    // ForecastTab seeds its unit <select> from location.state.unit. Wait
    // for the select to mount and assert the value matches the drill_unit
    // we extracted from the row aria. If the row had no drill_unit, we
    // assert the dropdown stayed at the FLEET default.
    const unitSelect = page.locator("select").filter({ has: page.locator('option[value="FLEET"]') });
    await unitSelect.waitFor({ state: "visible", timeout: TILE_TIMEOUT });
    if (drillUnit) {
      await expect(unitSelect, `ForecastTab unit dropdown should preselect "${drillUnit}" from the bridge drill`).toHaveValue(drillUnit, { timeout: 10_000 });
    } else {
      await expect(unitSelect).toHaveValue("FLEET");
    }

    // Belt-and-braces: the bridge also mirrors the unit into the store so
    // other surfaces can re-use it. Confirm that hand-off too.
    if (drillUnit) {
      const selUnit = await readStore<string>(page, "selectedUnitId");
      expect(selUnit).toBe(drillUnit);
    }

    // ----- Tile-header click -----
    await gotoHash(page, "#/");
    await resetStorePreselection(page);

    const shortagesHeader = page.locator('button[aria-label="Forecasted Shortages — PULSE"]');
    await shortagesHeader.waitFor({ state: "visible", timeout: TILE_TIMEOUT });
    await shortagesHeader.click();

    await page.waitForFunction(
      () => window.location.hash === "#/pulse/forecast",
      null,
      { timeout: 10_000 },
    );
    expect(page.url()).toMatch(/#\/pulse\/forecast$/);

    // Header click navigates without router state → ForecastTab falls
    // back to the "FLEET" default. Visible negative assertion.
    const unitSelectAfterHeader = page.locator("select").filter({ has: page.locator('option[value="FLEET"]') });
    await unitSelectAfterHeader.waitFor({ state: "visible", timeout: TILE_TIMEOUT });
    await expect(
      unitSelectAfterHeader,
      "Header click must NOT preselect a unit — ForecastTab should sit on FLEET",
    ).toHaveValue("FLEET", { timeout: 10_000 });
  });

  test("MC% tile: row drills to PULSE with unit preselected; header drills generically", async ({ page }) => {
    // ----- Row click -----
    await resetStorePreselection(page);

    // First MC% row — aria ends with "open in PULSE" exactly (NOT
    // "open in PULSE forecast", which is the shortages tile). The
    // McTile aria format also embeds "% MC · 7-day delta" so we pin
    // both substrings via a regex on aria-label to avoid colliding
    // with the shortages-row Pressables (which also live on this view).
    const firstMcRow = page.locator(
      'button[aria-label*="% MC · 7-day delta"][aria-label$="open in PULSE"]',
    ).first();
    await firstMcRow.waitFor({ state: "visible", timeout: TILE_TIMEOUT });
    const rowAria = await firstMcRow.getAttribute("aria-label");
    expect(rowAria, "MC row aria-label").toBeTruthy();
    // Aria format (DecisionBridge.tsx line ~644):
    //   `${u.unit} · ${ratePct}% MC · 7-day delta ${sign}${pp} pp — open in PULSE`
    const unitMatch = rowAria!.match(/^([^·]+?) · [\d.]+% MC/);
    expect(unitMatch, "should be able to extract unit from MC row aria").toBeTruthy();
    const expectedUnit = unitMatch![1].trim();

    await firstMcRow.click();

    await page.waitForFunction(
      () => window.location.hash === "#/pulse",
      null,
      { timeout: 10_000 },
    );
    expect(page.url()).toMatch(/#\/pulse$/);

    // McTile sets selectedUnitId in the store on row click. FleetOverviewTab
    // does not currently surface this in the heatmap (a known wiring gap),
    // but the Task #45 contract at the bridge boundary IS that the store
    // hand-off happens. Assert the store state authoritatively.
    const selUnit = await readStore<string>(page, "selectedUnitId");
    expect(
      selUnit,
      `McTile row click should set selectedUnitId="${expectedUnit}" in the store`,
    ).toBe(expectedUnit);

    // ----- Tile-header click -----
    await gotoHash(page, "#/");
    await resetStorePreselection(page);

    const mcHeader = page.locator('button[aria-label="MC% by Unit (60s) — PULSE"]');
    await mcHeader.waitFor({ state: "visible", timeout: TILE_TIMEOUT });
    await mcHeader.click();

    await page.waitForFunction(
      () => window.location.hash === "#/pulse",
      null,
      { timeout: 10_000 },
    );
    expect(page.url()).toMatch(/#\/pulse$/);

    const selUnitAfterHeader = await readStore<string>(page, "selectedUnitId");
    expect(
      selUnitAfterHeader,
      "McTile header click must NOT set selectedUnitId (header drills generically)",
    ).toBeNull();
  });
});
