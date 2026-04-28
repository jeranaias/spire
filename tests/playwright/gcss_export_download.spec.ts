import { test, expect } from "@playwright/test";
import { signIn } from "./_helpers";

const BACKEND = process.env.SPIRE_E2E_BASE_URL ?? "http://127.0.0.1:8000";

test("WP-9: export download trigger serves the real-shape sanitized CSV", async ({
  page,
}) => {
  // The integrations page documents the export curl recipe; download the
  // file directly through the same backend route the operator would hit
  // and verify the shape demanded by the stage rehearsal: 12 columns,
  // pre-hashed sensitive fields, multiple rows. Uses `page.request` so
  // the auth cookie set by signIn is carried with the download.
  await signIn(page);

  const resp = await page.request.get(
    `${BACKEND}/api/gcss/export/sr_header.csv?limit=10`,
  );
  expect(resp.status()).toBe(200);
  expect(resp.headers()["content-type"]).toMatch(/text\/csv/);

  const lines = (await resp.text()).split(/\r?\n/).filter((l) => l.length > 0);
  expect(lines.length).toBeGreaterThanOrEqual(2);

  const header = lines[0].split(",").map((c) => c.replace(/^"|"$/g, ""));
  expect(header).toEqual([
    "SERVICE_REQUEST_TYPE",
    "SR_NUMBER",
    "DEFECT_CODE",
    "PROBLEM_SUMMARY",
    "DATE_RECEIVED_IN_SHOP",
    "ECHELON_OF_MAINT",
    "SERIAL_NUMBER",
    "TAMCN",
    "DEADLINED_DATE",
    "MASTER_PRIORITY_CODE",
    "OWNER_UNIT_ADDRESS_CODE",
    "JOB_STATUS_DATE",
  ]);

  // Every emitted row must have all four sensitive fields in canonical
  // pre-hashed form; the export download path must NEVER ship clear
  // values to the operator.
  for (const line of lines.slice(1)) {
    expect(line).toMatch(/sr_number_[A-Za-z0-9_\-]{20}/);
    expect(line).toMatch(/serial_number_[A-Za-z0-9_\-]{20}/);
    expect(line).toMatch(/tamcn_[A-Za-z0-9_\-]{20}/);
    expect(line).toMatch(/owner_unit_address_code_[A-Za-z0-9_\-]{20}/);
  }
});
