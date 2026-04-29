import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";
import {
  closeTestPool,
  deleteTestUnit,
  seedTestCatalogItem,
  seedTestUnit,
} from "../../test/db-helpers";

// Integration coverage for POST /api/units/:unitId/supply, focused on the
// requiredOverride lifecycle. Three semantics matter:
//   * a numeric value (>0) sets a planner override
//   * 0 means "not a requirement for this unit"
//   * null clears the override and reverts to auto-computed
//   * omitting the field entirely keeps the existing override in place

describe("POST /api/units/:unitId/supply — required-quantity override", () => {
  let unitId: string;
  let itemId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit();
    unitId = unit.id;
    // baseDailyRate=1.0 + 100 personnel + 30 mission days = 3000 auto-required
    const item = await seedTestCatalogItem(unitId, {
      name: "TEST_UPSERT_MRE",
      baseDailyRate: 1.0,
    });
    itemId = item.id;
  });

  afterEach(async () => {
    if (unitId) await deleteTestUnit(unitId);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("sets, updates, and clears the override across successive calls", async () => {
    // 1) Create the entry with an initial positive override.
    const setRes = await request(app)
      .post(`/api/units/${unitId}/supply`)
      .send({ itemId, onHand: 250, requiredOverride: 500 });
    expect(setRes.status).toBe(200);
    expect(setRes.body.requiredOverride).toBe(500);
    expect(setRes.body.required).toBe(500);
    expect(setRes.body.isRequirement).toBe(true);
    // 250 / 500 = 50% coverage → amber per the upsert handler's coverage rule
    expect(setRes.body.shortfall).toBe(250);
    expect(setRes.body.status).toBe("amber");

    // 2) Update the override to a higher value with the same on-hand. The
    //    handler should overwrite the override and recompute coverage.
    const updateRes = await request(app)
      .post(`/api/units/${unitId}/supply`)
      .send({ itemId, onHand: 250, requiredOverride: 1000 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.requiredOverride).toBe(1000);
    expect(updateRes.body.required).toBe(1000);
    // 250 / 1000 = 25% coverage → red
    expect(updateRes.body.shortfall).toBe(750);
    expect(updateRes.body.status).toBe("red");

    // 3) Clear the override (null) — required must revert to auto-computed.
    const clearRes = await request(app)
      .post(`/api/units/${unitId}/supply`)
      .send({ itemId, onHand: 250, requiredOverride: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.requiredOverride).toBeNull();
    expect(clearRes.body.isRequirement).toBe(true);
    expect(clearRes.body.required).toBe(3000);
    // Daily burn 100, on hand 250 → DOS = 2.5 → amber
    expect(clearRes.body.shortfall).toBe(2750);
    expect(clearRes.body.daysOfSupply).toBe(2.5);
    expect(clearRes.body.status).toBe("amber");
  });

  it('treats override=0 as "not a requirement"', async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/supply`)
      .send({ itemId, onHand: 0, requiredOverride: 0 });
    expect(res.status).toBe(200);
    expect(res.body.requiredOverride).toBe(0);
    expect(res.body.isRequirement).toBe(false);
    expect(res.body.required).toBe(0);
    expect(res.body.shortfall).toBe(0);
    expect(res.body.status).toBe("green");
  });

  it("preserves the existing override when the field is omitted from a follow-up update", async () => {
    // Seed with an explicit override.
    const initial = await request(app)
      .post(`/api/units/${unitId}/supply`)
      .send({ itemId, onHand: 100, requiredOverride: 400 });
    expect(initial.status).toBe(200);
    expect(initial.body.requiredOverride).toBe(400);

    // Update on hand only — requiredOverride is intentionally absent.
    const followUp = await request(app)
      .post(`/api/units/${unitId}/supply`)
      .send({ itemId, onHand: 200 });
    expect(followUp.status).toBe(200);
    // The handler treats `undefined` as "leave alone", so the prior override
    // must still be present.
    expect(followUp.body.requiredOverride).toBe(400);
    expect(followUp.body.required).toBe(400);
    expect(followUp.body.onHand).toBe(200);
  });
});
