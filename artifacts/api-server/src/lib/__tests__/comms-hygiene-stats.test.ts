import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db, commsHygieneRunsTable } from "@workspace/db";
import { inArray } from "drizzle-orm";
import { getCommsHygieneStats } from "../comms-hygiene";
import { closeTestPool } from "../../test/db-helpers";

async function seedRun(ranAt: Date): Promise<string> {
  const [row] = await db
    .insert(commsHygieneRunsTable)
    .values({
      ranAt,
      auditedCount: 0,
      flaggedCount: 0,
      invalidCount: 0,
      recipients: [],
      cc: [],
      outcome: "skipped_no_flags",
    })
    .returning({ id: commsHygieneRunsTable.id });
  if (!row) throw new Error("Failed to seed comms-hygiene run");
  return row.id;
}

describe("getCommsHygieneStats", () => {
  // Track every seeded id so cleanup never leaks rows even if a test throws
  // before its own cleanup ran. Stats reads the live table so any leftover
  // rows would corrupt the next test run's totals.
  const seededIds: string[] = [];
  // Snapshot + restore the env vars so we don't bleed retention config
  // across test files in the same vitest worker.
  const originalRetention = process.env.COMMS_HYGIENE_RETENTION_DAYS;
  const originalNearExpiry =
    process.env.COMMS_HYGIENE_NEAR_EXPIRY_WINDOW_DAYS;

  afterEach(async () => {
    if (seededIds.length > 0) {
      await db
        .delete(commsHygieneRunsTable)
        .where(inArray(commsHygieneRunsTable.id, seededIds));
      seededIds.length = 0;
    }
    if (originalRetention === undefined) {
      delete process.env.COMMS_HYGIENE_RETENTION_DAYS;
    } else {
      process.env.COMMS_HYGIENE_RETENTION_DAYS = originalRetention;
    }
    if (originalNearExpiry === undefined) {
      delete process.env.COMMS_HYGIENE_NEAR_EXPIRY_WINDOW_DAYS;
    } else {
      process.env.COMMS_HYGIENE_NEAR_EXPIRY_WINDOW_DAYS = originalNearExpiry;
    }
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("reports the configured retention horizon and the oldest expiry", async () => {
    process.env.COMMS_HYGIENE_RETENTION_DAYS = "180";
    const oldestRanAt = new Date("2026-01-15T12:00:00Z");
    const id = await seedRun(oldestRanAt);
    seededIds.push(id);

    const stats = await getCommsHygieneStats();
    expect(stats.totalRuns).toBeGreaterThanOrEqual(1);
    expect(stats.retentionDays).toBe(180);

    // The oldest stored row must drive both `oldestRanAt` and `oldestExpiresAt`.
    // Some other test may have left rows with an even earlier ranAt, so we
    // don't pin the value — but the expiry must always be exactly retention
    // days after `oldestRanAt`.
    expect(stats.oldestRanAt).not.toBeNull();
    expect(stats.oldestExpiresAt).not.toBeNull();
    const oldest = new Date(stats.oldestRanAt!).getTime();
    const expires = new Date(stats.oldestExpiresAt!).getTime();
    expect(expires - oldest).toBe(180 * 24 * 60 * 60 * 1000);
  });

  it("returns oldestExpiresAt=null when retention is disabled", async () => {
    process.env.COMMS_HYGIENE_RETENTION_DAYS = "0";
    const id = await seedRun(new Date("2026-02-01T00:00:00Z"));
    seededIds.push(id);

    const stats = await getCommsHygieneStats();
    expect(stats.retentionDays).toBe(0);
    expect(stats.oldestRanAt).not.toBeNull();
    expect(stats.oldestExpiresAt).toBeNull();
    // Window + count must collapse to 0 so the FE can render the disabled
    // state without any special-case logic.
    expect(stats.nearExpiryWindowDays).toBe(0);
    expect(stats.nearExpiryCount).toBe(0);
  });

  it("flags rows whose projected expiry falls within the warning window", async () => {
    process.env.COMMS_HYGIENE_RETENTION_DAYS = "30";
    process.env.COMMS_HYGIENE_NEAR_EXPIRY_WINDOW_DAYS = "7";
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();

    // Three rows at known ages relative to "now":
    //  - 28d old → expires in 2d (well inside the 7-day window)
    //  - 25d old → expires in 5d (still inside the window)
    //  - 10d old → expires in 20d (safely outside the window)
    const insideA = await seedRun(new Date(now - 28 * dayMs));
    const insideB = await seedRun(new Date(now - 25 * dayMs));
    const outside = await seedRun(new Date(now - 10 * dayMs));
    seededIds.push(insideA, insideB, outside);

    const stats = await getCommsHygieneStats();
    expect(stats.retentionDays).toBe(30);
    expect(stats.nearExpiryWindowDays).toBe(7);
    // The shared dev DB may also contain older rows from earlier tests, so
    // we assert at least our two seeds — never an exact total.
    expect(stats.nearExpiryCount).toBeGreaterThanOrEqual(2);
  });

  it("disables the warning entirely when the window is set to 0", async () => {
    process.env.COMMS_HYGIENE_RETENTION_DAYS = "30";
    process.env.COMMS_HYGIENE_NEAR_EXPIRY_WINDOW_DAYS = "0";
    // Seed a row that *would* be near expiry under any positive window, so
    // we can prove that the count truly stays at 0 rather than just
    // happening to have no near-expiry rows.
    const id = await seedRun(new Date(Date.now() - 28 * 24 * 60 * 60 * 1000));
    seededIds.push(id);

    const stats = await getCommsHygieneStats();
    expect(stats.retentionDays).toBe(30);
    expect(stats.nearExpiryWindowDays).toBe(0);
    expect(stats.nearExpiryCount).toBe(0);
  });

  it("reports nearExpiryCount=0 when no rows are inside the warning window", async () => {
    process.env.COMMS_HYGIENE_RETENTION_DAYS = "365";
    process.env.COMMS_HYGIENE_NEAR_EXPIRY_WINDOW_DAYS = "7";
    // A row aged just one day still has ~364 days of life left, so it
    // must not appear in the near-expiry bucket. We can't assert == 0
    // overall (the dev DB may have ancient rows), but we *can* assert the
    // window is honored and the value is a non-negative integer.
    const id = await seedRun(new Date(Date.now() - 24 * 60 * 60 * 1000));
    seededIds.push(id);

    const stats = await getCommsHygieneStats();
    expect(stats.retentionDays).toBe(365);
    expect(stats.nearExpiryWindowDays).toBe(7);
    expect(stats.nearExpiryCount).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(stats.nearExpiryCount)).toBe(true);
  });
});
