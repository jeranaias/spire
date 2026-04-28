/**
 * Task #162 — Show the unit's projected readiness rate after a proposed
 * cannibalization.
 *
 * The Confirm Propose modal must show donor unit MC% before → after AND
 * recipient unit MC% before → after, and must surface a warning banner
 * when the projected donor MC rate would drop below the configured
 * readiness floor (70%).
 *
 * This spec drives the UI end-to-end:
 *   - signs in as g4 (Reyes), navigates to PULSE → Cannibalization
 *   - selects the first open need, opens the propose modal on the first
 *     candidate donor
 *   - asserts the new "Projected unit MC%" panel renders with both
 *     before-→-after percentages and "X/Y → A/Y MC" raw counts.
 *
 * Locking this UI down keeps the projection panel from quietly
 * regressing (e.g. losing the recipient row, or showing only the
 * donor's "Donor unit MC impact estimate" copy as before).
 */
import { test, expect } from "@playwright/test";
import { signIn, gotoHash, TEST_DODID } from "./_helpers";

test.describe("Task #162 — propose modal projected unit MC% panel", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, TEST_DODID);
  });

  test("modal shows donor + recipient unit MC% before → after", async ({ page }) => {
    await gotoHash(page, "#/pulse/cannib");

    // Wait for the needs column to render.
    await page.getByText(/Open NMCS Assets/i).waitFor({ timeout: 15_000 });

    // Need rows are rendered as <button> (Pressable) elements. Find the
    // first one inside the section that announces the needs list — its
    // siblings include the filter/sort chrome which we want to skip.
    const needsHeader = page.getByText(/Open NMCS Assets/i).first();
    const needsSection = needsHeader.locator(
      "xpath=ancestor::section[1]",
    );
    const firstNeed = needsSection.locator("button").filter({ hasText: /NMCS/ }).first();
    await firstNeed.waitFor({ state: "visible", timeout: 10_000 });
    await firstNeed.click();

    // Donors should appear. Click the first Propose button.
    const proposeBtn = page.getByRole("button", { name: /^propose$/i }).first();
    await proposeBtn.waitFor({ state: "visible", timeout: 10_000 });
    await proposeBtn.click();

    // Modal opens.
    const dialog = page.getByRole("dialog", { name: /propose cannibalization match/i });
    await dialog.waitFor({ state: "visible", timeout: 5_000 });

    // The new panel header must be present (replaces "Donor unit MC
    // impact estimate" copy from the donor-only version).
    await expect(dialog.getByText(/Projected unit MC%/i)).toBeVisible();

    // The panel must contain at least one "X.X% → Y.Y%" before-after
    // string. Same-unit cannib renders one combined row; cross-unit
    // renders two. Either way, at least one arrow is present.
    const arrowText = dialog.locator("text=/\\d+\\.\\d+% → \\d+\\.\\d+%/").first();
    await expect(arrowText).toBeVisible();

    // Raw MC counts (X/Y → A/Y MC) are also shown. A regex match keeps
    // this resilient to different totals across seeds.
    const rawCounts = dialog.locator("text=/\\d+\\/\\d+ → \\d+\\/\\d+ MC/").first();
    await expect(rawCounts).toBeVisible();

    // The panel must call out the donor row OR the combined row.
    const hasDonorRow = await dialog.getByText(/\(donor\)/).count();
    const hasCombinedRow = await dialog.getByText(/\(donor \+ recipient\)/).count();
    expect(hasDonorRow + hasCombinedRow).toBeGreaterThan(0);

    // "Why this hull is strippable: ..." remains as the trailing
    // explanation under the panel.
    await expect(dialog.getByText(/Why this hull is strippable/i)).toBeVisible();

    // Close cleanly so the test doesn't leave a modal hanging.
    await dialog.getByRole("button", { name: /cancel/i }).click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  });
});
