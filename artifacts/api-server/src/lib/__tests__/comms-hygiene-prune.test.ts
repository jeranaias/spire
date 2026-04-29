import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db, commsHygieneRunsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { pruneCommsHygieneRuns } from "../comms-hygiene";
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

describe("pruneCommsHygieneRuns", () => {
  // Track every seeded id across the whole file so cleanup never leaks rows
  // even if a previous test threw before its own cleanup ran.
  const seededIds: string[] = [];

  afterEach(async () => {
    if (seededIds.length === 0) return;
    await db
      .delete(commsHygieneRunsTable)
      .where(inArray(commsHygieneRunsTable.id, seededIds));
    seededIds.length = 0;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("deletes rows older than retentionDays and keeps newer rows", async () => {
    const now = Date.now();
    const old = await seedRun(new Date(now - 200 * 24 * 60 * 60 * 1000));
    const recent = await seedRun(new Date(now - 1 * 24 * 60 * 60 * 1000));
    seededIds.push(old, recent);

    await pruneCommsHygieneRuns(180);

    const oldRow = await db
      .select()
      .from(commsHygieneRunsTable)
      .where(eq(commsHygieneRunsTable.id, old));
    const recentRow = await db
      .select()
      .from(commsHygieneRunsTable)
      .where(eq(commsHygieneRunsTable.id, recent));

    expect(oldRow.length).toBe(0);
    expect(recentRow.length).toBe(1);
  });

  it("is a no-op when retentionDays<=0 (retention disabled)", async () => {
    const now = Date.now();
    const ancient = await seedRun(new Date(now - 10_000 * 24 * 60 * 60 * 1000));
    seededIds.push(ancient);

    const removed = await pruneCommsHygieneRuns(0);
    expect(removed).toBe(0);

    const stillThere = await db
      .select()
      .from(commsHygieneRunsTable)
      .where(eq(commsHygieneRunsTable.id, ancient));
    expect(stillThere.length).toBe(1);
  });
});
