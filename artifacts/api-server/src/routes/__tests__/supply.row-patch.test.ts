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

// Integration coverage for PATCH /api/units/:unitId/supply/:itemId, the
// row-scoped, in-place update for a single tracked supply row. The collection
// POST is still the only path that creates rows; this PATCH only updates an
// existing entry's onHand and/or requiredOverride.

describe("PATCH /api/units/:unitId/supply/:itemId — single-row update", () => {
  let unitId: string;
  let itemId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit();
    unitId = unit.id;
    // baseDailyRate=1.0 + 100 personnel + 30 mission days = 3000 auto-required
    const item = await seedTestCatalogItem(unitId, {
      name: "TEST_PATCH_MRE",
      baseDailyRate: 1.0,
    });
    itemId = item.id;
    await seedTestSupplyEntry(unitId, itemId, 250, null);
  });

  afterEach(async () => {
    if (unitId) await deleteTestUnit(unitId);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("updates onHand only and leaves the override untouched", async () => {
    const res = await request(app)
      .patch(`/api/units/${unitId}/supply/${itemId}`)
      .send({ onHand: 500 });

    expect(res.status).toBe(200);
    expect(res.body.onHand).toBe(500);
    // Override was null at seed time and the PATCH did not touch it, so the
    // response must still report no planner override and the auto-computed
    // requirement (1.0 daily * 100 personnel * 30 mission days = 3000).
    expect(res.body.requiredOverride).toBeNull();
    expect(res.body.required).toBe(3000);
    expect(res.body.isRequirement).toBe(true);
    expect(res.body.daysOfSupply).toBe(5);
  });

  it("sets a planner override and clears it on a follow-up PATCH", async () => {
    // 1) Set a positive override. onHand is intentionally omitted — the prior
    //    seeded value (250) must be preserved.
    const setRes = await request(app)
      .patch(`/api/units/${unitId}/supply/${itemId}`)
      .send({ requiredOverride: 1000 });
    expect(setRes.status).toBe(200);
    expect(setRes.body.onHand).toBe(250);
    expect(setRes.body.requiredOverride).toBe(1000);
    expect(setRes.body.required).toBe(1000);
    expect(setRes.body.shortfall).toBe(750);
    expect(setRes.body.status).toBe("red");

    // 2) Clear the override (null) — required reverts to auto-computed.
    const clearRes = await request(app)
      .patch(`/api/units/${unitId}/supply/${itemId}`)
      .send({ requiredOverride: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.onHand).toBe(250);
    expect(clearRes.body.requiredOverride).toBeNull();
    expect(clearRes.body.required).toBe(3000);
    expect(clearRes.body.daysOfSupply).toBe(2.5);
  });

  it("rejects an empty payload with 400 instead of silently no-oping", async () => {
    const res = await request(app)
      .patch(`/api/units/${unitId}/supply/${itemId}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/onHand|requiredOverride/);
  });

  it("returns 404 when the supply entry does not exist on this unit", async () => {
    const otherUnit = await seedTestUnit();
    try {
      // The catalog item exists, but no supply entry ties it to otherUnit.
      const res = await request(app)
        .patch(`/api/units/${otherUnit.id}/supply/${itemId}`)
        .send({ onHand: 1 });
      expect(res.status).toBe(404);
    } finally {
      await deleteTestUnit(otherUnit.id);
    }
  });
});
