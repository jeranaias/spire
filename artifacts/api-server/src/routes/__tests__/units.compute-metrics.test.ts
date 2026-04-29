import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeUnitMetrics } from "../units";
import {
  closeTestPool,
  deleteTestUnit,
  seedTestCatalogItem,
  seedTestSupplyEntry,
  seedTestUnit,
} from "../../test/db-helpers";

// These tests exercise the required-quantity override branches of
// computeUnitMetrics:
//   * override === null      -> auto-computed required from daily burn × days
//   * override === 0         -> "not a requirement" (excluded from readiness)
//   * override > 0           -> coverage-based status (green/amber/red)
//
// Test fixtures use temperate climate + sustained tempo so all multipliers in
// adjustedDailyRate collapse to 1.0, making the math easy to assert.
//
// 100 personnel × 30 mission days × 1.0 base daily rate = 3000 expected
// required units when no override is set.

describe("computeUnitMetrics — required-quantity override", () => {
  let unitId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit();
    unitId = unit.id;
  });

  afterEach(async () => {
    if (unitId) await deleteTestUnit(unitId);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  describe("no override (auto-computed)", () => {
    it("derives required from daily burn × mission days", async () => {
      const item = await seedTestCatalogItem(unitId, {
        name: "TEST_AUTO_MRE",
        baseDailyRate: 1.0,
        criticality: "critical",
      });
      // onHand 1500: 50% coverage of the 3000 auto-computed requirement.
      // Daily burn = 100/day → 15 days of supply → status green.
      await seedTestSupplyEntry(unitId, item.id, 1500, null);

      const m = await computeUnitMetrics(unitId);
      expect(m).not.toBeNull();
      const e = m!.enriched.find((row) => row.itemId === item.id);
      expect(e).toBeDefined();
      expect(e!.requiredOverride).toBeNull();
      expect(e!.isRequirement).toBe(true);
      expect(e!.dailyConsumption).toBe(100);
      expect(e!.required).toBe(3000);
      expect(e!.shortfall).toBe(1500);
      expect(e!.daysOfSupply).toBe(15);
      expect(e!.status).toBe("green");
    });

    it("counts auto-computed deficits in readiness when on hand is depleted", async () => {
      const item = await seedTestCatalogItem(unitId, {
        name: "TEST_AUTO_DEPLETED",
        baseDailyRate: 1.0,
        criticality: "critical",
      });
      // 50 on hand at 100/day = 0.5 DOS → red, deducts critical weight (25)
      // from the readiness baseline of 100.
      await seedTestSupplyEntry(unitId, item.id, 50, null);

      const m = await computeUnitMetrics(unitId);
      expect(m).not.toBeNull();
      expect(m!.deficiencyCount).toBe(1);
      expect(m!.readiness).toBe(75);
    });
  });

  describe("override === 0 (not a requirement)", () => {
    it("marks the entry as non-requirement with green status and zero shortfall", async () => {
      const item = await seedTestCatalogItem(unitId, {
        name: "TEST_OVERRIDE_ZERO",
        baseDailyRate: 1.0,
        criticality: "critical",
      });
      // Even with on hand = 0, override = 0 should report green / zero
      // shortfall because the planner declared this isn't a requirement.
      await seedTestSupplyEntry(unitId, item.id, 0, 0);

      const m = await computeUnitMetrics(unitId);
      expect(m).not.toBeNull();
      const e = m!.enriched.find((row) => row.itemId === item.id);
      expect(e).toBeDefined();
      expect(e!.requiredOverride).toBe(0);
      expect(e!.isRequirement).toBe(false);
      expect(e!.required).toBe(0);
      expect(e!.shortfall).toBe(0);
      expect(e!.status).toBe("green");
    });

    it("excludes the entry from readiness even when on hand is depleted", async () => {
      const item = await seedTestCatalogItem(unitId, {
        name: "TEST_OVERRIDE_ZERO_READINESS",
        baseDailyRate: 1.0,
        criticality: "critical",
      });
      // Without the override, an empty critical Class I bin would tank
      // readiness. With override=0 the row must not contribute at all.
      await seedTestSupplyEntry(unitId, item.id, 0, 0);

      const m = await computeUnitMetrics(unitId);
      expect(m).not.toBeNull();
      expect(m!.readiness).toBe(100);
      expect(m!.deficiencyCount).toBe(0);
    });
  });

  describe("override > 0 (coverage-based status)", () => {
    it("returns green when on hand fully covers the override", async () => {
      const item = await seedTestCatalogItem(unitId, {
        name: "TEST_OVERRIDE_GREEN",
        baseDailyRate: 1.0,
      });
      // override=200, onHand=200 → coverage 100% → green, zero shortfall.
      await seedTestSupplyEntry(unitId, item.id, 200, 200);

      const m = await computeUnitMetrics(unitId);
      const e = m!.enriched.find((row) => row.itemId === item.id);
      expect(e).toBeDefined();
      expect(e!.requiredOverride).toBe(200);
      expect(e!.isRequirement).toBe(true);
      expect(e!.required).toBe(200);
      expect(e!.shortfall).toBe(0);
      expect(e!.status).toBe("green");
    });

    it("returns amber when coverage is between 40% and 100%", async () => {
      const item = await seedTestCatalogItem(unitId, {
        name: "TEST_OVERRIDE_AMBER",
        baseDailyRate: 1.0,
      });
      // override=200, onHand=100 → coverage 50% → amber, shortfall=100.
      await seedTestSupplyEntry(unitId, item.id, 100, 200);

      const m = await computeUnitMetrics(unitId);
      const e = m!.enriched.find((row) => row.itemId === item.id);
      expect(e).toBeDefined();
      expect(e!.requiredOverride).toBe(200);
      expect(e!.required).toBe(200);
      expect(e!.shortfall).toBe(100);
      expect(e!.status).toBe("amber");
    });

    it("returns red when coverage is below 40%", async () => {
      const item = await seedTestCatalogItem(unitId, {
        name: "TEST_OVERRIDE_RED",
        baseDailyRate: 1.0,
      });
      // override=200, onHand=50 → coverage 25% → red, shortfall=150.
      await seedTestSupplyEntry(unitId, item.id, 50, 200);

      const m = await computeUnitMetrics(unitId);
      const e = m!.enriched.find((row) => row.itemId === item.id);
      expect(e).toBeDefined();
      expect(e!.requiredOverride).toBe(200);
      expect(e!.required).toBe(200);
      expect(e!.shortfall).toBe(150);
      expect(e!.status).toBe("red");
    });

    it("uses the override to drive shortfall regardless of mission days", async () => {
      const item = await seedTestCatalogItem(unitId, {
        name: "TEST_OVERRIDE_DECOUPLED",
        baseDailyRate: 1.0,
      });
      // Auto-computed would be 100/day × 30d = 3000, but the planner override
      // of 500 supersedes it: required must be 500, not 3000.
      await seedTestSupplyEntry(unitId, item.id, 500, 500);

      const m = await computeUnitMetrics(unitId);
      const e = m!.enriched.find((row) => row.itemId === item.id);
      expect(e).toBeDefined();
      expect(e!.required).toBe(500);
      expect(e!.shortfall).toBe(0);
      expect(e!.status).toBe("green");
    });
  });
});
