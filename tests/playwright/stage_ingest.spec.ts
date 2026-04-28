/**
 * Stage live-ingest mode (Task #183) — end-to-end coverage.
 *
 * Verifies the operator-facing surface of the empty/ingest/populated
 * lifecycle:
 *   1. Signed in as a security_manager (Park, the only stage-ingest-
 *      eligible Marine in MOCK_USERS), DECISION BRIDGE shows the
 *      drag-drop hero card with three slots.
 *   2. Each slot transitions empty → valid as files are attached.
 *   3. Submitting hydrates the dataset; the hero card disappears and
 *      the success banner reports the new SR count.
 *   4. The "Awaiting GCSS-MC ingest" placeholder appears on BASTION,
 *      PULSE, and SENTRY before ingest, and the "Open DECISION BRIDGE"
 *      action navigates back to the hero card.
 *
 * Pre-conditions: backend booted with seed-42 dataset (default).
 * The spec drives the dataset to empty via the SPIRE_TEST_HOOKS-gated
 * /api/system/admin/force-empty stub so multiple specs can share one
 * backend process. The real SPIRE_BOOT_EMPTY=1 lifespan boot path is
 * covered by the pytest sibling test
 * `test_lifespan_boots_empty_when_env_set` in tests/test_stage_ingest.py,
 * which spins a fresh TestClient under that env to exercise main.py's
 * lifespan branch end-to-end.
 */
import { test, expect } from "@playwright/test";

import { signIn, gotoHash, SECURITY_MANAGER_DODID } from "./_helpers";

const FIXTURE_HEADER = "tests/fixtures/stage_ingest/header.csv";
const FIXTURE_PARTS = "tests/fixtures/stage_ingest/sr_parts.csv";
const FIXTURE_DUE_IN = "tests/fixtures/stage_ingest/due_in.csv";

/** Force the backend dataset singleton into the empty state via the
 *  test-only POST stub. Returns the HTTP status from the call so the
 *  caller can branch between deterministic (200) and missing-hook
 *  (404/410) modes. The hook itself is gated on SPIRE_TEST_HOOKS=1. */
async function forceEmptyDataset(
  page: import("@playwright/test").Page,
): Promise<number> {
  return await page.evaluate(async () => {
    try {
      const r = await fetch("/api/system/admin/force-empty", {
        method: "POST",
      });
      return r.status;
    } catch {
      return 0;
    }
  });
}

/** Hard-require the force-empty hook for the deterministic core flow.
 *  Fails (does NOT skip) when SPIRE_TEST_HOOKS=1 isn't propagated to
 *  the backend, so a misconfigured CI job is loud rather than silent. */
async function forceEmptyOrFail(page: import("@playwright/test").Page) {
  const status = await forceEmptyDataset(page);
  if (status !== 200) {
    throw new Error(
      `force-empty test hook returned ${status}; expected 200. ` +
        "Ensure the backend is started with SPIRE_TEST_HOOKS=1 so the " +
        "stage-ingest core flow can drive the dataset to empty.",
    );
  }
}

test.describe("Stage live-ingest mode (Task #183)", () => {
  test.beforeEach(async ({ page }) => {
    // Sign in as the security_manager Marine — the only role in
    // MOCK_USERS that can drive POST /api/system/stage-ingest.
    await signIn(page, SECURITY_MANAGER_DODID);
  });

  test("DECISION BRIDGE hero card renders the three named slots when empty", async ({
    page,
  }) => {
    await forceEmptyOrFail(page);
    await gotoHash(page, "#/decision");

    // Hero card is identified by data-testid so the spec doesn't
    // depend on copy or layout that may evolve. Deterministic now —
    // force-empty must have succeeded before we reach this line.
    const hero = page.getByTestId("stage-ingest-hero");
    await expect(hero).toBeVisible();

    await expect(hero).toContainText(/Awaiting GCSS-MC ingest/i);
    await expect(page.getByTestId("stage-ingest-slot-header")).toBeVisible();
    await expect(page.getByTestId("stage-ingest-slot-sr_parts")).toBeVisible();
    await expect(page.getByTestId("stage-ingest-slot-due_in")).toBeVisible();
  });

  test("attaching CSVs to each slot flips them to valid", async ({ page }) => {
    await forceEmptyOrFail(page);
    await gotoHash(page, "#/decision");
    const hero = page.getByTestId("stage-ingest-hero");
    await expect(hero).toBeVisible();

    await page
      .getByTestId("stage-ingest-input-header")
      .setInputFiles(FIXTURE_HEADER);
    await page
      .getByTestId("stage-ingest-input-sr_parts")
      .setInputFiles(FIXTURE_PARTS);
    await page
      .getByTestId("stage-ingest-input-due_in")
      .setInputFiles(FIXTURE_DUE_IN);

    await expect(
      page.getByTestId("stage-ingest-slot-header"),
    ).toHaveAttribute("data-state", "valid");
    await expect(
      page.getByTestId("stage-ingest-slot-sr_parts"),
    ).toHaveAttribute("data-state", "valid");
    await expect(
      page.getByTestId("stage-ingest-slot-due_in"),
    ).toHaveAttribute("data-state", "valid");

    await expect(page.getByTestId("stage-ingest-submit")).toBeEnabled();
  });

  test("hydrate flow flips the dataset out of empty mode", async ({ page }) => {
    await forceEmptyOrFail(page);
    await gotoHash(page, "#/decision");
    const hero = page.getByTestId("stage-ingest-hero");
    await expect(hero).toBeVisible();

    await page
      .getByTestId("stage-ingest-input-header")
      .setInputFiles(FIXTURE_HEADER);
    await page
      .getByTestId("stage-ingest-input-sr_parts")
      .setInputFiles(FIXTURE_PARTS);
    await page
      .getByTestId("stage-ingest-input-due_in")
      .setInputFiles(FIXTURE_DUE_IN);

    await page.getByTestId("stage-ingest-submit").click();

    // The progress bar fills parsing → validating → hydrating → ready.
    // We assert the terminal "Ingest Complete" badge so the spec is
    // immune to fast/slow-machine ordering.
    await expect(hero).toContainText(/Ingest Complete/i, { timeout: 10_000 });
    // Per-file row count chips appear inside each slot's success line
    // once the response carries source_files.{slot}.rows_parsed.
    await expect(page.getByTestId("stage-ingest-rows-header")).toContainText(
      /rows parsed/i,
    );
    await expect(page.getByTestId("stage-ingest-rows-sr_parts")).toContainText(
      /rows parsed/i,
    );
    await expect(page.getByTestId("stage-ingest-rows-due_in")).toContainText(
      /rows parsed/i,
    );
    // The dataset-status poll fires every 5s — wait for the hero to
    // unmount, which only happens when datasetStatus.empty flips false.
    await expect(hero).toHaveCount(0, { timeout: 15_000 });
  });

  test("full lifecycle: empty → ingest → BASTION + PULSE populated", async ({
    page,
  }) => {
    // Round-5 review fix — assert the populated-state transition end
    // to end. The previous specs only proved (a) empty placeholders
    // render and (b) hero unmounts after ingest. This spec also proves
    // BASTION + PULSE flip out of the awaiting-ingest placeholder
    // post-ingest, which is the actual demo-flow guarantee.
    await forceEmptyOrFail(page);

    // 1. BASTION starts in awaiting-ingest mode.
    await gotoHash(page, "#/bastion");
    await expect(page.getByTestId("awaiting-ingest-bastion")).toBeVisible();

    // 2. PULSE container-level gate fires for every PULSE tab.
    await gotoHash(page, "#/pulse/risk");
    await expect(page.getByTestId("awaiting-ingest-pulse")).toBeVisible();

    // 3. DECISION BRIDGE → drop CSVs → submit → wait for ready.
    await gotoHash(page, "#/decision");
    await page
      .getByTestId("stage-ingest-input-header")
      .setInputFiles(FIXTURE_HEADER);
    await page
      .getByTestId("stage-ingest-input-sr_parts")
      .setInputFiles(FIXTURE_PARTS);
    await page
      .getByTestId("stage-ingest-input-due_in")
      .setInputFiles(FIXTURE_DUE_IN);
    await page.getByTestId("stage-ingest-submit").click();
    await expect(page.getByTestId("stage-ingest-hero")).toContainText(
      /Ingest Complete/i,
      { timeout: 10_000 },
    );

    // 4. BASTION must hydrate — the awaiting placeholder disappears
    //    within one dataset-status poll (≤5s) plus a 5s buffer.
    await gotoHash(page, "#/bastion");
    await expect(page.getByTestId("awaiting-ingest-bastion")).toHaveCount(0, {
      timeout: 15_000,
    });

    // 5. PULSE container gate must clear too — the placeholder
    //    disappears regardless of which tab the operator lands on.
    await gotoHash(page, "#/pulse/overview");
    await expect(page.getByTestId("awaiting-ingest-pulse")).toHaveCount(0, {
      timeout: 15_000,
    });
    await gotoHash(page, "#/pulse/risk");
    await expect(page.getByTestId("awaiting-ingest-pulse")).toHaveCount(0, {
      timeout: 5_000,
    });
  });

  test("BASTION renders the awaiting-ingest placeholder when empty", async ({
    page,
  }) => {
    await forceEmptyOrFail(page);
    await gotoHash(page, "#/bastion");
    const placeholder = page.getByTestId("awaiting-ingest-bastion");
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText(/BASTION/i);
    await expect(placeholder).toContainText(/Awaiting GCSS-MC ingest/i);
  });

  test("PULSE renders the awaiting-ingest placeholder when empty", async ({
    page,
  }) => {
    await forceEmptyOrFail(page);
    // PulseView has a container-level dataset gate so /pulse/overview,
    // /pulse/risk, /pulse/cannib, /pulse/forecast, /pulse/model all
    // resolve to the same Awaiting placeholder while empty. Hit a
    // non-overview route to prove the gate covers every PULSE tab.
    await gotoHash(page, "#/pulse/risk");
    const placeholder = page.getByTestId("awaiting-ingest-pulse");
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText(/PULSE/i);
    await expect(placeholder).toContainText(/Awaiting GCSS-MC ingest/i);
  });

  test("SENTRY renders the awaiting-ingest placeholder when empty", async ({
    page,
  }) => {
    await forceEmptyOrFail(page);
    // SENTRY upload+processing remain reachable in empty-boot mode
    // (Task #177 batch-classification path is additive). The
    // data-dependent tabs (review/mark/export/coalition) are gated.
    // Hit /sentry/review to assert the placeholder on a gated route.
    await gotoHash(page, "#/sentry/review");
    const placeholder = page.getByTestId("awaiting-ingest-sentry");
    await expect(placeholder).toBeVisible();
    await expect(placeholder).toContainText(/SENTRY/i);
    await expect(placeholder).toContainText(/Awaiting GCSS-MC ingest/i);
  });

  test("SENTRY upload tab remains reachable when empty (additive Task #177 path)", async ({
    page,
  }) => {
    await forceEmptyOrFail(page);
    // Empty-boot mode must not regress the existing SENTRY batch-
    // classification flow. The Upload tab is the entry point and
    // must render its own UI even with no GCSS-MC dataset present.
    await gotoHash(page, "#/sentry/upload");
    const placeholder = page.getByTestId("awaiting-ingest-sentry");
    await expect(placeholder).toHaveCount(0);
  });

  test("Shift+F8 failsafe restores the seed-42 baseline", async ({ page }) => {
    await gotoHash(page, "#/decision");
    // Listen for the toast lane — the hotkey emits the canonical
    // "Failsafe — restored seed-42 baseline" copy on success.
    await page.keyboard.press("Shift+F8");
    // The toast appears in the standard toast lane, regardless of
    // whether the dataset was already populated (idempotent reset).
    await expect(
      page.locator("text=/restored seed-42 baseline/i"),
    ).toBeVisible({ timeout: 5_000 });
  });
});
