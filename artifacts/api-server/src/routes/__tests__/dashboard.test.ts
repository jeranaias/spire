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

// Integration coverage for the dashboard read endpoints. The handlers query
// every unit + every supply row, so we seed a single isolated unit and assert
// it shows up in the aggregate output. The numeric totals are exercised in
// finer-grained unit tests; here we focus on response shape and the most
// important error path (the class-route's 400 on an unknown supply class).
describe("dashboard routes", () => {
  let unitId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit({ personnel: 100, missionDays: 30 });
    unitId = unit.id;
    const item = await seedTestCatalogItem(unitId, {
      name: "TEST_DASH_ITEM",
      supplyClass: "I",
      baseDailyRate: 1.0,
      criticality: "critical",
    });
    // 100 personnel × 30 days × 1.0 = 3000 required, on hand 30 → severe red.
    await seedTestSupplyEntry(unitId, item.id, 30, null);
  });

  afterEach(async () => {
    if (unitId) await deleteTestUnit(unitId);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("GET /dashboard/summary returns the aggregate shape", async () => {
    const res = await request(app).get("/api/dashboard/summary");
    expect(res.status).toBe(200);
    expect(typeof res.body.unitCount).toBe("number");
    expect(typeof res.body.personnelCount).toBe("number");
    expect(typeof res.body.readinessAvg).toBe("number");
    expect(typeof res.body.deficiencyCount).toBe("number");
    expect(Array.isArray(res.body.classBreakdown)).toBe(true);
    // Our seeded unit's personnel must be included in the global total.
    expect(res.body.personnelCount).toBeGreaterThanOrEqual(100);
  });

  it("GET /dashboard/class/:supplyClass returns the per-class shape", async () => {
    const res = await request(app).get("/api/dashboard/class/I");
    expect(res.status).toBe(200);
    expect(res.body.supplyClass).toBe("I");
    expect(typeof res.body.label).toBe("string");
    expect(Array.isArray(res.body.units)).toBe(true);
    expect(Array.isArray(res.body.items)).toBe(true);
    // Our seeded unit must appear in the per-class units listing.
    const unit = (res.body.units as Array<{ unitId: string }>).find(
      (u) => u.unitId === unitId,
    );
    expect(unit).toBeDefined();
  });

  it("GET /dashboard/class/:supplyClass returns 400 for an unknown class", async () => {
    const res = await request(app).get("/api/dashboard/class/ZZZ");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown supply class/i);
  });

  it("GET /dashboard/comms-hygiene-stats returns the documented shape", async () => {
    const res = await request(app).get("/api/dashboard/comms-hygiene-stats");
    expect(res.status).toBe(200);
    // Required fields on the CommsHygieneStats schema. The dev DB may have
    // any number of rows from prior runs (including zero), so we don't pin
    // the count; we just assert the shape and type contracts.
    expect(typeof res.body.totalRuns).toBe("number");
    expect(res.body.totalRuns).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.retentionDays).toBe("number");
    expect(res.body.retentionDays).toBeGreaterThanOrEqual(0);

    // Near-expiry fields are always present (per the schema), even when
    // there are no rows or retention is off — the FE renders nothing in
    // those cases but it still expects the keys to exist.
    expect(typeof res.body.nearExpiryWindowDays).toBe("number");
    expect(res.body.nearExpiryWindowDays).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.nearExpiryCount).toBe("number");
    expect(res.body.nearExpiryCount).toBeGreaterThanOrEqual(0);

    if (res.body.totalRuns === 0) {
      // Empty-table case: both timestamp fields must be null and nothing
      // can possibly be near expiry.
      expect(res.body.oldestRanAt).toBeNull();
      expect(res.body.oldestExpiresAt).toBeNull();
      expect(res.body.nearExpiryCount).toBe(0);
    } else {
      // Non-empty: oldestRanAt is always present, and oldestExpiresAt
      // tracks retentionDays — null only when retention is disabled.
      expect(typeof res.body.oldestRanAt).toBe("string");
      if (res.body.retentionDays === 0) {
        expect(res.body.oldestExpiresAt).toBeNull();
        // Retention off → window collapses to 0 and nothing is near expiry.
        expect(res.body.nearExpiryWindowDays).toBe(0);
        expect(res.body.nearExpiryCount).toBe(0);
      } else {
        expect(typeof res.body.oldestExpiresAt).toBe("string");
        const oldest = new Date(res.body.oldestRanAt as string).getTime();
        const expires = new Date(res.body.oldestExpiresAt as string).getTime();
        expect(expires - oldest).toBe(
          res.body.retentionDays * 24 * 60 * 60 * 1000,
        );
      }
    }
  });
});
