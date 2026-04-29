import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";
import {
  closeTestPool,
  deleteTestUnit,
  seedTestCatalogItem,
  seedTestUnit,
} from "../../test/db-helpers";

// Integration coverage for routes/resupply.ts:
//   * GET   /units/:unitId/resupply   — list per unit
//   * POST  /units/:unitId/resupply   — plan a new event (writes outbox + activity)
//   * PATCH /resupply/:eventId        — update status (delivered branch logs activity)
// Plus the most important error path: 404 when the unit does not exist on
// either the GET or POST handler — both early-return on missing unit before
// touching the resupply table.
describe("resupply routes", () => {
  let unitId: string;
  let itemId: string;

  beforeEach(async () => {
    const unit = await seedTestUnit();
    unitId = unit.id;
    const item = await seedTestCatalogItem(unitId, {
      name: "TEST_RESUPPLY_MRE",
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

  it("plans a resupply, lists it, then marks it delivered", async () => {
    // 1) POST creates a planned event and returns the serialized payload.
    const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const createRes = await request(app)
      .post(`/api/units/${unitId}/resupply`)
      .send({
        supplyClass: "I",
        itemId,
        quantity: 200,
        unit: "ea",
        scheduledFor,
      });
    expect(createRes.status).toBe(201);
    expect(createRes.body.status).toBe("planned");
    expect(createRes.body.quantity).toBe(200);
    expect(createRes.body.itemId).toBe(itemId);
    const eventId = createRes.body.id as string;

    // 2) GET returns the just-created event in the unit's resupply list.
    const listRes = await request(app).get(`/api/units/${unitId}/resupply`);
    expect(listRes.status).toBe(200);
    const listed = (listRes.body as Array<{ id: string }>).find(
      (e) => e.id === eventId,
    );
    expect(listed).toBeDefined();

    // 3) PATCH transitions the event to delivered. The handler also writes an
    //    activity row in this branch, but the response itself is the contract
    //    the UI consumes — assert the status flip.
    const patchRes = await request(app)
      .patch(`/api/resupply/${eventId}`)
      .send({ status: "delivered" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe("delivered");
  });

  it("returns 404 when posting a resupply event for a missing unit", async () => {
    const res = await request(app)
      .post("/api/units/00000000-0000-0000-0000-000000000000/resupply")
      .send({
        supplyClass: "I",
        itemId,
        quantity: 50,
        unit: "ea",
        scheduledFor: new Date().toISOString(),
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unit not found");
  });
});
