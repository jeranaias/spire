import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";
import {
  closeTestPool,
  deleteTestUnit,
  seedTestUnit,
} from "../../test/db-helpers";
import { db, unitsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Integration coverage for the route handlers in `units.ts`. The
// computeUnitMetrics function is already covered separately in
// units.compute-metrics.test.ts; this file targets the HTTP surface
// (POST/GET/PATCH/DELETE) that the metrics function feeds into.
describe("units routes — HTTP surface", () => {
  // Track unit ids created via the API so we can clean up even when a test
  // fails partway through.
  const createdUnitIds: string[] = [];

  afterEach(async () => {
    while (createdUnitIds.length > 0) {
      const id = createdUnitIds.pop()!;
      await deleteTestUnit(id).catch(() => {
        /* swallow — unit may already be gone via DELETE under test */
      });
    }
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("creates a unit, returns it from list + detail, then deletes it", async () => {
    // Use a unique name so this test can run alongside other test fixtures
    // without colliding on listing assertions.
    const name = `TEST_UNIT_HTTP_${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    // 1) POST creates and returns the new unit at full readiness with no
    //    deficiencies (empty supply table).
    const createRes = await request(app).post("/api/units").send({
      name,
      echelon: "company",
      personnel: 100,
      climate: "temperate",
      opTempo: "sustained",
      missionDays: 30,
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.name).toBe(name);
    expect(createRes.body.readiness).toBe(100);
    expect(createRes.body.deficiencyCount).toBe(0);
    const unitId = createRes.body.id as string;
    createdUnitIds.push(unitId);

    // 2) GET /units returns the new row alongside any others.
    const listRes = await request(app).get("/api/units");
    expect(listRes.status).toBe(200);
    const listed = (listRes.body as Array<{ id: string; name: string }>).find(
      (u) => u.id === unitId,
    );
    expect(listed?.name).toBe(name);

    // 3) GET /units/:id returns the supply-by-class shape and an empty
    //    entries / weapons array for a freshly-seeded unit.
    const detailRes = await request(app).get(`/api/units/${unitId}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.unit.id).toBe(unitId);
    expect(detailRes.body.entries).toEqual([]);
    expect(detailRes.body.weapons).toEqual([]);
    expect(Array.isArray(detailRes.body.supplyByClass)).toBe(true);

    // 4) DELETE removes the unit; afterEach won't double-delete because the
    //    pop-and-cleanup just no-ops if the row is gone.
    const delRes = await request(app).delete(`/api/units/${unitId}`);
    expect(delRes.status).toBe(204);

    const [stillThere] = await db
      .select()
      .from(unitsTable)
      .where(eq(unitsTable.id, unitId));
    expect(stillThere).toBeUndefined();
  });

  it("returns 404 from GET /units/:unitId when the unit does not exist", async () => {
    // Random-but-valid uuid that's never been inserted.
    const res = await request(app).get(
      "/api/units/00000000-0000-0000-0000-000000000000",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unit not found");
  });

  it("PATCH /units/:unitId updates fields and returns the new metrics", async () => {
    const seeded = await seedTestUnit({ personnel: 50, missionDays: 10 });
    createdUnitIds.push(seeded.id);

    const res = await request(app)
      .patch(`/api/units/${seeded.id}`)
      .send({
        name: seeded.name,
        echelon: "battalion",
        personnel: 200,
        climate: "arid",
        opTempo: "high",
        missionDays: 14,
      });

    expect(res.status).toBe(200);
    expect(res.body.echelon).toBe("battalion");
    expect(res.body.personnel).toBe(200);
    expect(res.body.climate).toBe("arid");
    expect(res.body.missionDays).toBe(14);
  });
});
