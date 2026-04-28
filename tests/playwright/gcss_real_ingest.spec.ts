import { test, expect } from "@playwright/test";
import { signIn, gotoHash, SECURITY_MANAGER_DODID } from "./_helpers";

const BACKEND = process.env.SPIRE_E2E_BASE_URL ?? "http://127.0.0.1:8000";

test("WP-9: real GCSS-MC sanitized export ingests through the SENTRY upload tab", async ({
  page,
}) => {
  // SENTRY is scope-gated to {data_custodian, security_manager}; sign in
  // as Park (security_manager) so the upload tab actually renders.
  await signIn(page, SECURITY_MANAGER_DODID);
  await gotoHash(page, "#/sentry/upload");
  await expect(page.locator("body")).toContainText(/upload/i, { timeout: 10_000 });

  // Pull a slice of the canonical sanitized export from the backend, then
  // upload it through the same form the operator uses on stage. Use
  // `page.request` so the auth cookie set by signIn is carried.
  const exportResp = await page.request.get(
    `${BACKEND}/api/gcss/export/sr_header.csv?limit=25`,
  );
  expect(exportResp.status()).toBe(200);
  const csv = await exportResp.text();

  // The hidden file input is the actual upload control on the SENTRY
  // upload tab; the visible button forwards to it.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: "attached", timeout: 5_000 });
  await fileInput.setInputFiles({
    name: "gcss_sanitized_slice.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf-8"),
  });

  // After the upload completes the page renders the GCSS-MC summary
  // panel, including the hashing-gate banner.
  await expect(page.locator("body")).toContainText(/GCSS-MC schema detected/i, {
    timeout: 15_000,
  });
  await expect(page.locator("body")).toContainText(/Hashing-gate PASS/i);
  // The four sanitized field names should all be name-checked in the banner.
  await expect(page.locator("body")).toContainText(/SR_NUMBER/);
  await expect(page.locator("body")).toContainText(/SERIAL_NUMBER/);
  await expect(page.locator("body")).toContainText(/TAMCN/);
  await expect(page.locator("body")).toContainText(/OWNER_UNIT_ADDRESS_CODE/);
});
