import { test, expect, request } from "@playwright/test";

const BASE = process.env.SPIRE_E2E_BASE_URL ?? "http://127.0.0.1:8000";

test("sanitization gate accepts pre-hashed GCSS-MC export", async () => {
  const ctx = await request.newContext({ baseURL: BASE });
  await ctx.post("/api/auth/login", {
    data: { dodid: "1234567890", pin: "123456" },
  });

  // Pull a small slice of the canonical export, then re-upload it
  // through the SENTRY ingest endpoint. Because the export is already
  // sanitized, the hash gate must PASS and the batch must be created.
  const exportResp = await ctx.get("/api/gcss/export/sr_header.csv?limit=20");
  expect(exportResp.status()).toBe(200);
  const csv = await exportResp.text();

  const upload = await ctx.post("/api/sentry/upload", {
    multipart: {
      file: {
        name: "gcss_sanitized_slice.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv, "utf-8"),
      },
    },
  });
  expect(upload.status()).toBe(200);
  const batch = await upload.json();
  expect(batch.batch_id).toBeTruthy();
  expect(batch.gcss_ingest_report).toBeTruthy();
  expect(batch.gcss_ingest_report.sanitization_gate).toBe("enforced");
  expect(batch.gcss_ingest_report.unsanitized_field_counts).toEqual({});
  expect(batch.provenance).toBe("GCSS-MC sanitized export");
});

test("sanitization gate rejects clear (un-hashed) sensitive fields", async () => {
  const ctx = await request.newContext({ baseURL: BASE });
  await ctx.post("/api/auth/login", {
    data: { dodid: "1234567890", pin: "123456" },
  });

  // A minimal CSV with the GCSS-MC schema but raw clear values in
  // every sensitive field. The hash gate must reject this with HTTP 400.
  const HEADER = [
    "SERVICE_REQUEST_TYPE",
    "SR_NUMBER",
    "DEFECT_CODE",
    "PROBLEM_SUMMARY",
    "OPEN_DATE",
    "ECHELON_OF_MAINT",
    "SERIAL_NUMBER",
    "TAMCN",
    "DEADLINED_DATE",
    "MASTER_PRIORITY_CODE",
    "OWNER_UNIT_ADDRESS_CODE",
    "JOB_STATUS_DATE",
  ].join(",");
  const ROW = [
    "Maintenance - CM",
    "M21670-5117-0001",
    "FCON.CBB",
    "Test row",
    "01-MAR-26",
    "2",
    "12345678",
    "D11234A1",
    "",
    "13 C-Routine",
    "M67399",
    "05-MAR-26",
  ].join(",");
  const csv = `${HEADER}\n${ROW}\n`;

  const upload = await ctx.post("/api/sentry/upload", {
    multipart: {
      file: {
        name: "gcss_unsanitized.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv, "utf-8"),
      },
    },
  });
  expect(upload.status()).toBe(400);
  const body = await upload.json();
  expect(body.detail).toContain("Sanitization gate");
});
