import { test, expect, request, APIRequestContext } from "@playwright/test";

const HEADER_COLS = [
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
];

function splitCsvHeader(text: string): string[] {
  const firstLine = text.split(/\r?\n/, 1)[0];
  return firstLine.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
}

async function authed(): Promise<APIRequestContext> {
  const ctx = await request.newContext({
    baseURL: process.env.SPIRE_E2E_BASE_URL ?? "http://127.0.0.1:8000",
  });
  const r = await ctx.post("/api/auth/login", {
    data: { dodid: "1234567890", pin: "123456" },
  });
  expect(r.ok()).toBeTruthy();
  return ctx;
}

test.describe("GCSS-MC export routes", () => {
  test("sr_header.csv emits 12 real-shape columns at /api/gcss/export", async () => {
    const ctx = await authed();
    const resp = await ctx.get("/api/gcss/export/sr_header.csv?limit=5");
    expect(resp.status()).toBe(200);
    expect(splitCsvHeader(await resp.text())).toEqual(HEADER_COLS);
  });

  test("sr_parts.csv has 6 columns and due_in.csv has 82 columns", async () => {
    const ctx = await authed();
    const parts = await ctx.get("/api/gcss/export/sr_parts.csv?limit=3");
    const dueIn = await ctx.get("/api/gcss/export/due_in.csv?limit=3");
    expect(parts.status()).toBe(200);
    expect(dueIn.status()).toBe(200);
    expect(splitCsvHeader(await parts.text()).length).toBe(6);
    expect(splitCsvHeader(await dueIn.text()).length).toBe(82);
  });

  test("export routes mirror at /api/integrations/gcss-mc/export prefix", async () => {
    const ctx = await authed();
    const a = await ctx.get("/api/gcss/export/sr_header.csv?limit=2");
    const b = await ctx.get(
      "/api/integrations/gcss-mc/export/sr_header.csv?limit=2",
    );
    expect(await a.text()).toBe(await b.text());
  });

  test("WP-5: header line is byte-equal to the real GCSS-MC export", async () => {
    // Acceptance: `curl /api/gcss/export/sr_header.csv | head -1` matches
    // the real `hashed_header.csv` header byte-for-byte (no quoting,
    // Unix line endings, exact column order).
    const ctx = await authed();
    const resp = await ctx.get("/api/gcss/export/sr_header.csv?limit=1");
    expect(resp.status()).toBe(200);
    const body = await resp.text();
    const headerLine = body.split("\n", 1)[0];
    const expected = HEADER_COLS.join(",");
    expect(headerLine).toBe(expected);
    // No double quotes anywhere on the header line.
    expect(headerLine.includes('"')).toBe(false);
  });
});
