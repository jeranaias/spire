import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";
import {
  closeTestPool,
  deleteTestUnit,
  seedTestCatalogItem,
  seedTestSupplyEntry,
  seedTestUnit,
} from "../../test/db-helpers";

// Integration coverage for routes/history.ts. The handlers in this file are
// the planner's "what changed / what's coming" view, so we test the most
// load-bearing read (history series) and the create-then-read round-trip on
// baselines, plus the most important error path: 404 when a baseline is
// queried by an id that doesn't exist.
describe("history routes", () => {
  let unitId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit();
    unitId = unit.id;
    const item = await seedTestCatalogItem(unitId, {
      name: "TEST_HISTORY_ITEM",
      baseDailyRate: 1.0,
    });
    await seedTestSupplyEntry(unitId, item.id, 250, null);
  });

  afterEach(async () => {
    if (unitId) await deleteTestUnit(unitId);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("GET /units/:unitId/supply/history returns an array (empty before snapshots)", async () => {
    // No snapshots have been written yet for this unit, so the handler must
    // return an empty array — not 404, not undefined.
    const res = await request(app).get(`/api/units/${unitId}/supply/history`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([]);
  });

  it("creates a baseline and reads it back through GET /baselines/:id", async () => {
    // 1) POST creates a baseline snapshot of the current supply state.
    const createRes = await request(app)
      .post(`/api/units/${unitId}/baselines`)
      .send({ label: "TEST_HISTORY_BASELINE", notes: "from integration test" });
    expect(createRes.status).toBe(201);
    expect(createRes.body.label).toBe("TEST_HISTORY_BASELINE");
    const baselineId = createRes.body.id as string;

    // 2) The baseline shows up in the unit's baseline list.
    const listRes = await request(app).get(`/api/units/${unitId}/baselines`);
    expect(listRes.status).toBe(200);
    expect(
      (listRes.body as Array<{ id: string }>).some((b) => b.id === baselineId),
    ).toBe(true);

    // 3) The single-baseline read-back returns the snapshotData payload that
    //    the planner UI relies on for restoring older states.
    const detailRes = await request(app).get(`/api/baselines/${baselineId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.id).toBe(baselineId);
    expect(detailRes.body.snapshotData).toBeDefined();
    expect(detailRes.body.snapshotData.unitId).toBe(unitId);
  });

  it("GET /baselines/:baselineId returns 404 for a missing baseline", async () => {
    const res = await request(app).get(
      "/api/baselines/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Baseline not found");
  });
});
