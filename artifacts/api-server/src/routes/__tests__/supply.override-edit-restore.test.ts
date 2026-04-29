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

// Close the pg pool once after every test in this file has run. Putting this
// in each describe's `afterAll` would close the pool after the first block,
// leaving later blocks with an unusable connection.
afterAll(async () => {
  await closeTestPool();
});

// Integration coverage for the two endpoints that recompute
// required/shortfall/status from `requiredOverride` *without* taking the
// override itself as input — both could drift from the upsert path during a
// refactor and silently serve stale or wrong values:
//
//   * PATCH /api/units/:unitId/supply/:itemId/custom-item
//       Edits the underlying custom catalog row (name, baseDailyRate, etc.)
//       and re-derives the response from the *existing* entry's override.
//
//   * POST  /api/units/:unitId/supply/:itemId/restore
//       Re-inserts the soft-deleted entry from a snapshot. The restored row
//       must preserve the original `requiredOverride` and re-derive
//       shortfall/status/isRequirement from it.
//
// Test fixtures use the seedTestUnit defaults (temperate / sustained / 100
// personnel / 30 mission days) so multipliers in adjustedDailyRate collapse to
// 1.0 and the math is easy to assert.

describe("PATCH /api/units/:unitId/supply/:itemId/custom-item — override behavior", () => {
  let unitId: string;
  let itemId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit();
    unitId = unit.id;
    // Custom item, scoped to this unit so the PATCH endpoint will accept it.
    const item = await seedTestCatalogItem(unitId, {
      name: "TEST_PATCH_MRE",
      baseDailyRate: 1.0,
      criticality: "critical",
    });
    itemId = item.id;
  });

  afterEach(async () => {
    if (unitId) await deleteTestUnit(unitId);
  });

  it('keeps override=0 ("not a requirement") in the response after editing the catalog row', async () => {
    // Seed an entry that the planner has flagged as "not a requirement".
    await seedTestSupplyEntry(unitId, itemId, 0, 0);

    // Edit the catalog metadata — name, baseDailyRate, criticality. The
    // endpoint itself does not touch the override, but the response recomputes
    // required/shortfall/status from it.
    const res = await request(app)
      .patch(`/api/units/${unitId}/supply/${itemId}/custom-item`)
      .send({
        name: "TEST_PATCH_MRE_RENAMED",
        supplyClass: "I",
        unit: "ea",
        baseDailyRate: 2.0,
        criticality: "high",
      });
    expect(res.status).toBe(200);
    // Catalog edits applied.
    expect(res.body.item.name).toBe("TEST_PATCH_MRE_RENAMED");
    expect(res.body.item.baseDailyRate).toBe(2.0);
    expect(res.body.item.criticality).toBe("high");
    // Override semantics preserved: even though the new baseDailyRate would
    // auto-compute to 2 × 100 × 30 = 6000, override=0 must win.
    expect(res.body.requiredOverride).toBe(0);
    expect(res.body.isRequirement).toBe(false);
    expect(res.body.required).toBe(0);
    expect(res.body.shortfall).toBe(0);
    expect(res.body.status).toBe("green");
  });

  it("re-derives shortfall and status from override>0 after editing the catalog row", async () => {
    // override=400, onHand=100 → coverage 25% → red, shortfall=300.
    await seedTestSupplyEntry(unitId, itemId, 100, 400);

    // Bump baseDailyRate as part of the edit. Auto-computed required would now
    // be 3 × 100 × 30 = 9000, but the override of 400 must continue to drive
    // required/shortfall/status.
    const res = await request(app)
      .patch(`/api/units/${unitId}/supply/${itemId}/custom-item`)
      .send({
        name: "TEST_PATCH_MRE",
        supplyClass: "I",
        unit: "ea",
        baseDailyRate: 3.0,
        criticality: "critical",
      });
    expect(res.status).toBe(200);
    expect(res.body.item.baseDailyRate).toBe(3.0);
    expect(res.body.requiredOverride).toBe(400);
    expect(res.body.isRequirement).toBe(true);
    expect(res.body.required).toBe(400);
    expect(res.body.shortfall).toBe(300);
    expect(res.body.status).toBe("red");
    // dailyConsumption reflects the new baseDailyRate (3 × 100 = 300/day),
    // confirming the catalog edit took effect even though required is pinned.
    expect(res.body.dailyConsumption).toBe(300);
  });

  it("recomputes required from the new baseDailyRate when override is null (auto-mode)", async () => {
    // No override: required must follow auto-compute rules (daily × missionDays)
    // and pick up the freshly edited baseDailyRate immediately.
    await seedTestSupplyEntry(unitId, itemId, 200, null);

    // Bumping baseDailyRate from 1.0 → 2.0 doubles the daily burn:
    //   daily = 2.0 × 100 personnel = 200/day
    //   required = 200 × 30 missionDays = 6000
    //   shortfall = 6000 - 200 = 5800
    //   daysOfSupply = 200 / 200 = 1.0  → red (< 2 days)
    const res = await request(app)
      .patch(`/api/units/${unitId}/supply/${itemId}/custom-item`)
      .send({
        name: "TEST_PATCH_MRE",
        supplyClass: "I",
        unit: "ea",
        baseDailyRate: 2.0,
        criticality: "critical",
      });
    expect(res.status).toBe(200);
    expect(res.body.item.baseDailyRate).toBe(2.0);
    // Override stays null and the response must report it as such.
    expect(res.body.requiredOverride).toBeNull();
    expect(res.body.isRequirement).toBe(true);
    // Required reflects the new daily burn, *not* the old one (which would be 3000).
    expect(res.body.dailyConsumption).toBe(200);
    expect(res.body.required).toBe(6000);
    expect(res.body.shortfall).toBe(5800);
    expect(res.body.daysOfSupply).toBe(1);
    expect(res.body.status).toBe("red");
  });
});

describe("POST /api/units/:unitId/supply/:itemId/restore — override behavior", () => {
  let unitId: string;
  let itemId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit();
    unitId = unit.id;
    const item = await seedTestCatalogItem(unitId, {
      name: "TEST_RESTORE_MRE",
      baseDailyRate: 1.0,
      criticality: "critical",
    });
    itemId = item.id;
  });

  afterEach(async () => {
    if (unitId) await deleteTestUnit(unitId);
  });

  it("preserves requiredOverride>0 across a soft-delete + restore and re-derives shortfall/status", async () => {
    // override=500, onHand=200 → coverage 40% → amber boundary, shortfall=300.
    await seedTestSupplyEntry(unitId, itemId, 200, 500);

    const delRes = await request(app).delete(
      `/api/units/${unitId}/supply/${itemId}`,
    );
    expect(delRes.status).toBe(200);
    // Custom item is unit-scoped, so the catalog row was also dropped and
    // will be re-created from the snapshot on restore.
    expect(delRes.body.removedCatalogItem).toBe(true);

    const restoreRes = await request(app).post(
      `/api/units/${unitId}/supply/${itemId}/restore`,
    );
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.restoredCatalogItem).toBe(true);

    const entry = restoreRes.body.restoredEntry;
    expect(entry.requiredOverride).toBe(500);
    expect(entry.isRequirement).toBe(true);
    expect(entry.required).toBe(500);
    expect(entry.onHand).toBe(200);
    // Shortfall and status come from the override + on-hand, not from
    // mission-days × daily-burn (which would give required=3000 and red).
    expect(entry.shortfall).toBe(300);
    expect(entry.status).toBe("amber");
  });

  it('preserves override=0 ("not a requirement") across a soft-delete + restore', async () => {
    // Even with on-hand=0, a restored override=0 must still report as a
    // non-requirement with green status — exactly like the original entry.
    await seedTestSupplyEntry(unitId, itemId, 0, 0);

    const delRes = await request(app).delete(
      `/api/units/${unitId}/supply/${itemId}`,
    );
    expect(delRes.status).toBe(200);

    const restoreRes = await request(app).post(
      `/api/units/${unitId}/supply/${itemId}/restore`,
    );
    expect(restoreRes.status).toBe(200);

    const entry = restoreRes.body.restoredEntry;
    expect(entry.requiredOverride).toBe(0);
    expect(entry.isRequirement).toBe(false);
    expect(entry.required).toBe(0);
    expect(entry.shortfall).toBe(0);
    expect(entry.status).toBe("green");
  });

  it("preserves a null override (auto-mode) across a soft-delete + restore", async () => {
    // No planner override: required must be auto-derived from daily × missionDays.
    //   daily = 1.0 × 100 personnel = 100/day
    //   required = 100 × 30 missionDays = 3000
    //   shortfall = 3000 - 600 = 2400
    //   daysOfSupply = 600 / 100 = 6 → green (≥ 5 days)
    await seedTestSupplyEntry(unitId, itemId, 600, null);

    const delRes = await request(app).delete(
      `/api/units/${unitId}/supply/${itemId}`,
    );
    expect(delRes.status).toBe(200);
    expect(delRes.body.removedCatalogItem).toBe(true);

    const restoreRes = await request(app).post(
      `/api/units/${unitId}/supply/${itemId}/restore`,
    );
    expect(restoreRes.status).toBe(200);
    expect(restoreRes.body.restoredCatalogItem).toBe(true);

    const entry = restoreRes.body.restoredEntry;
    // The snapshot must round-trip a null override as null — not as 0, which
    // would silently flip the entry to "not a requirement" on restore.
    expect(entry.requiredOverride).toBeNull();
    expect(entry.isRequirement).toBe(true);
    expect(entry.onHand).toBe(600);
    // Required + shortfall + status come from the auto-compute path.
    expect(entry.required).toBe(3000);
    expect(entry.shortfall).toBe(2400);
    expect(entry.daysOfSupply).toBe(6);
    expect(entry.status).toBe("green");
  });
});
