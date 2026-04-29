import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";
import { closeTestPool } from "../../test/db-helpers";
import { db, syncOutboxTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Integration coverage for routes/sync.ts. We avoid the network-dependent
// performSync run here on purpose — that path is exercised end-to-end against
// a real SPIRE simulator at deploy time. These tests cover the pure-DB sync
// surface (status, outbox CRUD) which is the routes file's largest portion
// and the most sensitive to silent regressions.
describe("sync routes", () => {
  // Track outbox rows we created so cleanup is bounded even if a test fails.
  const createdOutboxIds: string[] = [];

  afterEach(async () => {
    while (createdOutboxIds.length > 0) {
      const id = createdOutboxIds.pop()!;
      await db
        .delete(syncOutboxTable)
        .where(eq(syncOutboxTable.id, id))
        .catch(() => {});
    }
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("GET /sync/status returns the canonical state shape", async () => {
    // The handler ensures a default sync_state row exists, so this works
    // even on a fresh database.
    const res = await request(app).get("/api/sync/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("connected");
    expect(res.body).toHaveProperty("upstreamSystem", "SPIRE");
    expect(res.body).toHaveProperty("pendingChanges");
    expect(res.body).toHaveProperty("autoSyncEnabled");
    expect(res.body).toHaveProperty("autoSyncIntervalMinutes");
    expect(typeof res.body.pendingChanges).toBe("number");
  });

  it("POST /sync/outbox/:id/retry flips a failed row back to pending", async () => {
    // Seed a failed outbox row directly so we don't depend on a real upstream
    // push to produce one.
    const [row] = await db
      .insert(syncOutboxTable)
      .values({
        entityKind: "supply_entry",
        entityId: "00000000-0000-0000-0000-000000000000",
        unitId: null,
        op: "create",
        status: "failed",
        lastError: "synthetic test failure",
        payload: { itemName: "TEST_RETRY_ITEM", unitName: "TEST_RETRY_UNIT" },
      })
      .returning();
    if (!row) throw new Error("failed to seed outbox row");
    createdOutboxIds.push(row.id);

    const res = await request(app).post(`/api/sync/outbox/${row.id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(row.id);
    expect(res.body.status).toBe("pending");
    expect(res.body.lastError).toBeNull();
  });

  it("DELETE /sync/outbox/:id returns 404 when the record does not exist", async () => {
    const res = await request(app).delete(
      "/api/sync/outbox/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Record not found");
  });
});
