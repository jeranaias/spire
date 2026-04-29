import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";
import {
  closeTestPool,
  deleteTestCatalogItem,
  deleteTestUnit,
  seedGlobalCatalogItem,
  seedTestUnit,
} from "../../test/db-helpers";

// Pool teardown is registered at file scope so it runs once after every
// describe block in this file has finished. Registering it inside an
// individual describe would close the pool while later describes still need
// it.
afterAll(async () => {
  await closeTestPool();
});

// Regression tests for the calculator bill math.
//
// The display layer in calculator.tsx renders:
//   {line.dailyConsumption.toFixed(2)}/day
//
// A previous bug (task #209) applied an extra `* result.personnel`
// multiplication to `dailyConsumption` inside the component, inflating the
// displayed value by 40× for the default 40-PAX scenario.  These tests lock
// down the API response so any recurrence is caught before it ships.
//
// Scenario: 40 PAX · 14 days · Temperate · Sustained
//   MRE           baseDailyRate=3.0 → 3.0 × 1.0 (climate) × 1.0 (tempo) × 40 = 120.00/day
//   Potable Water baseDailyRate=1.5 → 1.5 × 1.0 (climate) × 1.0 (tempo) × 40 =  60.00/day

describe("POST /api/units/:unitId/calculate — bill math regression", () => {
  let unitId: string;
  let mreItemId: string;
  let waterItemId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit({ personnel: 40 });
    unitId = unit.id;

    const mreItem = await seedGlobalCatalogItem({
      name: "MRE",
      supplyClass: "I",
      baseDailyRate: 3.0,
      unit: "ea",
    });
    mreItemId = mreItem.id;

    const waterItem = await seedGlobalCatalogItem({
      name: "Potable Water",
      supplyClass: "I",
      baseDailyRate: 1.5,
      unit: "gal",
    });
    waterItemId = waterItem.id;
  });

  afterEach(async () => {
    await deleteTestCatalogItem(waterItemId);
    await deleteTestCatalogItem(mreItemId);
    await deleteTestUnit(unitId);
  });

  it("returns 120.00/day for MRE and 60.00/day for Potable Water (40 PAX, Temperate, Sustained)", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ personnel: 40, days: 14, climate: "temperate", opTempo: "sustained" });

    expect(res.status).toBe(200);
    expect(res.body.personnel).toBe(40);
    expect(res.body.days).toBe(14);

    const lines: Array<{ item: { name: string }; dailyConsumption: number; totalRequired: number }> =
      res.body.lines;

    const mreLine = lines.find((l) => l.item.name === "MRE");
    const waterLine = lines.find((l) => l.item.name === "Potable Water");

    expect(mreLine, "MRE line must appear in the bill").toBeDefined();
    expect(waterLine, "Potable Water line must appear in the bill").toBeDefined();

    // dailyConsumption is the value the component renders as "<x>/day".
    // It must equal baseDailyRate × climate_mult × tempo_mult × personnel,
    // with no additional personnel multiplication.
    expect(mreLine!.dailyConsumption).toBe(120);
    expect(waterLine!.dailyConsumption).toBe(60);

    // totalRequired must be dailyConsumption × days, not anything larger.
    expect(mreLine!.totalRequired).toBe(1680);
    expect(waterLine!.totalRequired).toBe(840);
  });

  it("dailyConsumption scales linearly with personnel — doubling PAX doubles the rate", async () => {
    const res80 = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ personnel: 80, days: 14, climate: "temperate", opTempo: "sustained" });

    expect(res80.status).toBe(200);

    const lines: Array<{ item: { name: string }; dailyConsumption: number }> =
      res80.body.lines;

    const mreLine = lines.find((l) => l.item.name === "MRE");
    expect(mreLine!.dailyConsumption).toBe(240);
  });

  it("climate multipliers are applied to dailyConsumption — arid boosts Class I by 1.6×", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ personnel: 40, days: 14, climate: "arid", opTempo: "sustained" });

    expect(res.status).toBe(200);

    const lines: Array<{ item: { name: string }; dailyConsumption: number }> =
      res.body.lines;

    // arid Class I multiplier is 1.6
    // MRE: 3.0 × 1.6 × 1.0 × 40 = 192.00
    const mreLine = lines.find((l) => l.item.name === "MRE");
    expect(mreLine!.dailyConsumption).toBe(192);
  });
});

// Input validation regression tests.
//
// The calculator handler runs body.parse() through Zod before any DB work.
// Any payload that fails the schema must surface as a structured 400 from the
// shared error middleware, never a 500. These tests lock that contract down so
// bad data from the planner UI (or a misbehaving client) is rejected cleanly
// instead of crashing the request.
describe("POST /api/units/:unitId/calculate — input validation", () => {
  let unitId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit({ personnel: 40 });
    unitId = unit.id;
  });

  afterEach(async () => {
    await deleteTestUnit(unitId);
  });

  function expectValidationError(
    res: { status: number; body: { error?: string; issues?: unknown } },
    pathContains: string,
  ) {
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("ValidationError");
    expect(Array.isArray(res.body.issues)).toBe(true);
    const issues = res.body.issues as Array<{ path: string; message: string; code: string }>;
    expect(
      issues.some((i) => i.path === pathContains),
      `expected a ValidationError issue on path "${pathContains}", got: ${JSON.stringify(issues)}`,
    ).toBe(true);
  }

  it("rejects an unknown climate string with a 400 ValidationError", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 14, personnel: 40, climate: "swampy", opTempo: "sustained" });

    expectValidationError(res, "climate");
  });

  it("rejects an unknown opTempo string with a 400 ValidationError", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 14, personnel: 40, climate: "temperate", opTempo: "frantic" });

    expectValidationError(res, "opTempo");
  });

  it("rejects a missing days field with a 400 ValidationError", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ personnel: 40, climate: "temperate", opTempo: "sustained" });

    expectValidationError(res, "days");
  });

  it("rejects a missing climate field with a 400 ValidationError", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 14, personnel: 40, opTempo: "sustained" });

    expectValidationError(res, "climate");
  });

  it("rejects a missing opTempo field with a 400 ValidationError", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 14, personnel: 40, climate: "temperate" });

    expectValidationError(res, "opTempo");
  });

  it("rejects a non-numeric personnel value with a 400 ValidationError", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({
        days: 14,
        personnel: "forty",
        climate: "temperate",
        opTempo: "sustained",
      });

    expectValidationError(res, "personnel");
  });

  it("rejects a non-integer (fractional) personnel value with a 400 ValidationError", async () => {
    // Headcount is physically an integer — 1.5 marines does not exist.
    // openapi.yaml declares `personnel` as `type: integer`, and the
    // post-codegen step in lib/api-spec/scripts/zod-int-postprocess.mjs
    // tightens the generated CalculateRequirementsBody Zod schema to
    // call `.int()` so fractional values never reach the bill math.
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 14, personnel: 1.5, climate: "temperate", opTempo: "sustained" });

    expectValidationError(res, "personnel");
  });

  it("rejects personnel below the minimum (0) with a 400 ValidationError", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 14, personnel: 0, climate: "temperate", opTempo: "sustained" });

    expectValidationError(res, "personnel");
  });

  it("rejects a non-integer (fractional) days value with a 400 ValidationError", async () => {
    // Mission-day counts are also integers, so the generated schema
    // rejects fractional days the same way it rejects fractional
    // personnel — see the personnel test above for the codegen path.
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 1.5, personnel: 40, climate: "temperate", opTempo: "sustained" });

    expectValidationError(res, "days");
  });

  it("rejects days below the minimum (0) with a 400 ValidationError", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 0, personnel: 40, climate: "temperate", opTempo: "sustained" });

    expectValidationError(res, "days");
  });

  it("accepts the boundary values personnel=1 and days=1 with a 200 response", async () => {
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 1, personnel: 1, climate: "temperate", opTempo: "sustained" });

    expect(res.status).toBe(200);
    expect(res.body.days).toBe(1);
    expect(res.body.personnel).toBe(1);
    expect(res.body.climate).toBe("temperate");
    expect(res.body.opTempo).toBe("sustained");
    expect(Array.isArray(res.body.lines)).toBe(true);
  });

  it("falls back to the unit's personnel when personnel is omitted (intentional what-if override slot)", async () => {
    // The OpenAPI spec marks `personnel` as a nullable, optional override —
    // it is NOT a required field. Omitting it lets a planner re-run the
    // calculator against the saved unit headcount (a what-if without
    // overriding). This test locks down that fallback so a future schema
    // tightening doesn't accidentally break the "use my unit's personnel"
    // workflow.
    const res = await request(app)
      .post(`/api/units/${unitId}/calculate`)
      .send({ days: 7, climate: "temperate", opTempo: "sustained" });

    expect(res.status).toBe(200);
    expect(res.body.personnel).toBe(40);
    expect(res.body.days).toBe(7);
  });
});
