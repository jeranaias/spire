import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";
import {
  closeTestPool,
  deleteTestUnit,
  deleteTestWeaponSystem,
  seedTestUnit,
  seedTestWeaponSystem,
} from "../../test/db-helpers";

// Integration coverage for routes/weapons.ts. Covers:
//   * GET    /weapon-systems              — global list
//   * POST   /units/:unitId/weapons       — assign a weapon to a unit
//   * GET    /units/:unitId/weapons       — list a unit's weapons
//   * DELETE /units/:unitId/weapons/:id   — remove an assignment
// Plus the most important error path: 404 when the targeted unit does not
// exist on the assignment POST.
describe("weapons routes", () => {
  const createdUnitIds: string[] = [];
  const createdWeaponIds: string[] = [];

  afterEach(async () => {
    while (createdUnitIds.length > 0) {
      const id = createdUnitIds.pop()!;
      await deleteTestUnit(id).catch(() => {});
    }
    while (createdWeaponIds.length > 0) {
      const id = createdWeaponIds.pop()!;
      await deleteTestWeaponSystem(id).catch(() => {});
    }
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("lists weapon systems and assigns one to a unit", async () => {
    const weapon = await seedTestWeaponSystem({
      name: "TEST_M27_IAR",
      tamcn: "TEST-TAMCN-001",
    });
    createdWeaponIds.push(weapon.id);
    const unit = await seedTestUnit();
    createdUnitIds.push(unit.id);

    // 1) /weapon-systems must include our seeded row.
    const wsRes = await request(app).get("/api/weapon-systems");
    expect(wsRes.status).toBe(200);
    const found = (wsRes.body as Array<{ id: string }>).find(
      (w) => w.id === weapon.id,
    );
    expect(found).toBeDefined();

    // 2) POST assigns the weapon to a unit and returns the joined view.
    const assignRes = await request(app)
      .post(`/api/units/${unit.id}/weapons`)
      .send({ weaponSystemId: weapon.id, quantity: 12 });
    expect(assignRes.status).toBe(201);
    expect(assignRes.body.weaponSystemId).toBe(weapon.id);
    expect(assignRes.body.weaponName).toBe("TEST_M27_IAR");
    expect(assignRes.body.quantity).toBe(12);
    const entryId = assignRes.body.id as string;

    // 3) GET on the unit returns the assignment we just made.
    const listRes = await request(app).get(`/api/units/${unit.id}/weapons`);
    expect(listRes.status).toBe(200);
    expect(
      (listRes.body as Array<{ id: string }>).some((e) => e.id === entryId),
    ).toBe(true);

    // 4) DELETE removes the assignment cleanly.
    const delRes = await request(app).delete(
      `/api/units/${unit.id}/weapons/${entryId}`,
    );
    expect(delRes.status).toBe(204);
  });

  it("returns 404 when assigning a weapon to a missing unit", async () => {
    const weapon = await seedTestWeaponSystem({ name: "TEST_M4_404" });
    createdWeaponIds.push(weapon.id);

    const res = await request(app)
      .post("/api/units/00000000-0000-0000-0000-000000000000/weapons")
      .send({ weaponSystemId: weapon.id, quantity: 1 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Unit not found");
  });
});
