import { test, expect, type BrowserContext } from "@playwright/test";
import { signIn, SECURITY_MANAGER_DODID, gotoHash } from "./_helpers";

// Task #176 — the operator's current SENTRY batch_id / job_id must
// survive a hard reload (and a fresh tab) so a DDIL refresh doesn't
// drop them on the empty "No active job" screen. The persisted IDs
// must also be cleared after a successful export so the next session
// doesn't replay a batch that's already been shipped.

const SENTRY_BATCH_KEY = "spire.sentryBatch";

test.describe("SENTRY active-batch persistence (Task #176)", () => {
  test("batch_id/job_id persist across hard reload, are cleared after export", async ({
    browser,
  }) => {
    const ctx: BrowserContext = await browser.newContext();
    const page = await ctx.newPage();

    // Sign in as Park (security_manager — has access to /sentry/* and to
    // the Export tab).
    await signIn(page, SECURITY_MANAGER_DODID);

    // Land on Upload, wait for the canonical demo batch to auto-seed.
    await gotoHash(page, "#/sentry/upload");
    await page.waitForSelector("text=Process batch", { timeout: 15_000 });

    // Capture the batch_id off the localStorage entry the store wrote
    // when the seed call's response landed. setSentryBatch persists
    // {batchId, jobId:null} immediately after auto-seed (UploadTab
    // calls ctx.setBatch(b.batch_id) before the operator clicks
    // Process batch).
    const batchAfterSeed = await page.evaluate(
      (k) => window.localStorage.getItem(k),
      SENTRY_BATCH_KEY,
    );
    expect(batchAfterSeed, "auto-seed should persist batchId").not.toBeNull();
    const seedParsed = JSON.parse(batchAfterSeed as string);
    expect(typeof seedParsed.batchId).toBe("string");
    const batchId: string = seedParsed.batchId;
    expect(batchId).toMatch(/^BATCH-/);

    // Kick off processing. UploadTab navigates to /sentry/processing
    // after the engine pass returns.
    await page.getByRole("button", { name: /process batch/i }).click();
    await page.waitForFunction(
      () => window.location.hash === "#/sentry/processing",
      null,
      { timeout: 15_000 },
    );

    // Both batchId AND jobId should now be persisted.
    const persistedAfterProcess = await page.evaluate(
      (k) => window.localStorage.getItem(k),
      SENTRY_BATCH_KEY,
    );
    expect(persistedAfterProcess).not.toBeNull();
    const procParsed = JSON.parse(persistedAfterProcess as string);
    expect(procParsed.batchId).toBe(batchId);
    expect(typeof procParsed.jobId).toBe("string");
    const jobId: string = procParsed.jobId;
    expect(jobId.length).toBeGreaterThan(0);

    // Sanity — the live processing view rendered (not the "No active
    // job" empty state). The header shows "Batch <id> · Job <id>".
    await expect(page.locator("body")).not.toContainText(/No active job/i);
    await expect(page.locator("body")).toContainText(batchId);

    // -------------------------------------------------------------------
    // Hard reload — the core regression test. Before Task #176 this lost
    // the batch / job and dropped the operator on the empty state.
    // -------------------------------------------------------------------
    await page.reload({ waitUntil: "networkidle" });
    expect(page.url()).toMatch(/#\/sentry\/processing$/);
    await expect(page.locator("body")).not.toContainText(/No active job/i);
    await expect(page.locator("body")).toContainText(batchId);

    // -------------------------------------------------------------------
    // Walk to Export and run a successful US_ONLY / XLSX export. After
    // the success panel renders, the persisted IDs should be cleared.
    // -------------------------------------------------------------------
    await gotoHash(page, "#/sentry/export");
    const exportBtn = page.getByRole("button", {
      name: /Export Sanitized Bundle/i,
    });
    await exportBtn.waitFor({ state: "visible", timeout: 10_000 });
    await exportBtn.click();
    // The success panel header is "Export Prepared".
    await page.waitForSelector("text=Export Prepared", { timeout: 20_000 });

    const persistedAfterExport = await page.evaluate(
      (k) => window.localStorage.getItem(k),
      SENTRY_BATCH_KEY,
    );
    expect(
      persistedAfterExport,
      "successful export should clear the persisted batch handles",
    ).toBeNull();

    // Reload + revisit /sentry/processing — it should now show the
    // empty state, because the persisted batch was cleared.
    await page.reload({ waitUntil: "networkidle" });
    await gotoHash(page, "#/sentry/processing");
    await expect(page.locator("body")).toContainText(/No active job/i);

    await ctx.close();
  });
});
