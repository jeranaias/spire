/**
 * Task #135 — When a manual / auto refresh on the Model Registry or
 * Model Detail page fails, the cached payload must stay on screen and a
 * dismissible inline warning ("Refresh failed at HH:MM:SS — showing
 * previous load") must surface near the freshness label. The warning
 * clears on the next successful refresh OR when the operator dismisses
 * it explicitly.
 *
 * The spec drives the UI through Playwright route interception so the
 * failure is real (the api-retry layer exhausts its 3 retries and the
 * hook's catch branch fires) — no mocking of React state.
 */
import { test, expect, type Page } from "@playwright/test";
import { signIn, gotoHash, SECURITY_MANAGER_DODID } from "./_helpers";

/** ↻ Refresh button — same aria-label on both the registry and detail pages. */
function refreshButton(page: Page) {
  return page.getByRole("button", { name: /refresh registry/i });
}

/** Locator for the Task #135 inline warning banner. */
function refreshFailedBanner(page: Page) {
  return page.getByText(/Refresh failed at \d{2}:\d{2}:\d{2}/);
}

test.describe("Task #135 — refresh-failed inline warning", () => {
  // Each scenario walks the api-retry layer (3 retries with ~1s/3s/5s
  // backoff) twice — once to surface the banner, once to re-trigger it
  // before testing the success-clears-it path. Bump per-test timeout
  // above the repo-wide 30s default so it does not race the retries.
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    await signIn(page, SECURITY_MANAGER_DODID);
  });

  test("registry: failed refresh surfaces dismissible warning, cached view stays", async ({
    page,
  }) => {
    // Land on the registry and let the initial fetch succeed.
    await gotoHash(page, "#/admin/models");
    await expect(
      page.getByRole("heading", { name: /Admin · Model Supply Chain/i }),
    ).toBeVisible({ timeout: 15_000 });
    // At least one model row link must be rendered — confirms the
    // initial payload landed in the hook's `data` slot.
    const firstRow = page.locator('a[href*="/admin/models/"]').first();
    await expect(firstRow).toBeVisible({ timeout: 10_000 });
    await expect(refreshFailedBanner(page)).toHaveCount(0);

    // Now fail every subsequent registry fetch with a 5xx so withRetry
    // exhausts its budget and the hook's catch branch fires.
    await page.route("**/api/system/admin/models**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "synthetic-failure-task-135" }),
      }),
    );

    await refreshButton(page).click();

    // withRetry attempts 3 retries with ~1s/3s/5s backoff before
    // giving up — give the warning ~25s to surface.
    await expect(refreshFailedBanner(page)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(/showing previous load/i)).toBeVisible();

    // Cached view must still be on screen.
    await expect(
      page.getByRole("heading", { name: /Admin · Model Supply Chain/i }),
    ).toBeVisible();
    await expect(firstRow).toBeVisible();
    // The fatal ErrorState ("Model Registry Offline") must NOT have
    // taken over the page.
    await expect(page.getByText(/Model Registry Offline/i)).toHaveCount(0);

    // Banner is dismissible.
    const dismiss = page.getByRole("button", {
      name: /Dismiss refresh-failed warning/i,
    });
    await expect(dismiss).toBeVisible();
    await dismiss.click();
    await expect(refreshFailedBanner(page)).toHaveCount(0);
    await expect(firstRow).toBeVisible();

    // A subsequent successful refresh must clear the warning even
    // when the operator did not dismiss it manually.
    // Re-trigger failure first…
    await refreshButton(page).click();
    await expect(refreshFailedBanner(page)).toBeVisible({ timeout: 25_000 });
    // …then drop the failure interceptor and refresh again.
    await page.unroute("**/api/system/admin/models**");
    await refreshButton(page).click();
    await expect(refreshFailedBanner(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(firstRow).toBeVisible();
  });

  test("detail: failed refresh surfaces dismissible warning, cached card stays", async ({
    page,
  }) => {
    // Reach the registry, then click into the first model card.
    await gotoHash(page, "#/admin/models");
    const firstRow = page.locator('a[href*="/admin/models/"]').first();
    await expect(firstRow).toBeVisible({ timeout: 15_000 });
    await firstRow.click();

    await expect(
      page.getByRole("link", { name: /Model supply chain/i }),
    ).toBeVisible({ timeout: 10_000 });
    // Detail card sections — confirms the detail payload rendered.
    await expect(page.getByText(/^Provenance$/i).first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(refreshFailedBanner(page)).toHaveCount(0);

    // Fail the detail endpoint.
    await page.route("**/api/system/admin/models/**", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "detail-failure-135" }),
      }),
    );

    await refreshButton(page).click();
    await expect(refreshFailedBanner(page)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(/showing previous load/i)).toBeVisible();

    // Cached card content must still be on screen.
    await expect(page.getByText(/^Provenance$/i).first()).toBeVisible();
    // The fatal ErrorState must NOT have taken over.
    await expect(page.getByText(/Model Card Unavailable/i)).toHaveCount(0);

    // Dismiss clears the banner.
    const dismiss = page.getByRole("button", {
      name: /Dismiss refresh-failed warning/i,
    });
    await dismiss.click();
    await expect(refreshFailedBanner(page)).toHaveCount(0);

    // Successful refresh re-clears (re-trigger then drop the route).
    await refreshButton(page).click();
    await expect(refreshFailedBanner(page)).toBeVisible({ timeout: 25_000 });
    await page.unroute("**/api/system/admin/models/**");
    await refreshButton(page).click();
    await expect(refreshFailedBanner(page)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(/^Provenance$/i).first()).toBeVisible();
  });
});
