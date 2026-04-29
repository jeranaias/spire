import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import app from "../../app";
import {
  closeTestPool,
  deleteTestCatalogItem,
  deleteTestUnit,
  seedGlobalCatalogItem,
  seedTestCatalogItem,
  seedTestUnit,
} from "../../test/db-helpers";

// Integration coverage for routes/catalog.ts. The DELETE/restore round-trip
// is covered separately at the e2e level; here we exercise the canonical
// request/response shapes plus the most important guard rail — refusing to
// edit a unit-scoped (non-global) catalog item.
describe("catalog routes", () => {
  const createdUnitIds: string[] = [];
  const createdGlobalItemIds: string[] = [];

  afterEach(async () => {
    while (createdUnitIds.length > 0) {
      const id = createdUnitIds.pop()!;
      await deleteTestUnit(id).catch(() => {});
    }
    while (createdGlobalItemIds.length > 0) {
      const id = createdGlobalItemIds.pop()!;
      await deleteTestCatalogItem(id).catch(() => {});
    }
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it("lists global catalog items including a freshly seeded one", async () => {
    const item = await seedGlobalCatalogItem({
      name: "TEST_CATALOG_LIST_ITEM",
      supplyClass: "II",
      baseDailyRate: 0.5,
    });
    createdGlobalItemIds.push(item.id);

    const res = await request(app).get("/api/catalog/items");
    expect(res.status).toBe(200);
    const found = (res.body as Array<{ id: string; name: string }>).find(
      (i) => i.id === item.id,
    );
    expect(found?.name).toBe("TEST_CATALOG_LIST_ITEM");
  });

  it("PATCH /catalog/items/:id updates a global custom item", async () => {
    const item = await seedGlobalCatalogItem({
      name: "TEST_CATALOG_PATCH_ITEM",
      criticality: "low",
    });
    createdGlobalItemIds.push(item.id);

    const res = await request(app)
      .patch(`/api/catalog/items/${item.id}`)
      .send({
        name: "TEST_CATALOG_PATCH_ITEM_RENAMED",
        criticality: "critical",
      });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("TEST_CATALOG_PATCH_ITEM_RENAMED");
    expect(res.body.criticality).toBe("critical");
  });

  it("PATCH /catalog/items/:id rejects edits on a unit-scoped item with 400", async () => {
    // Unit-scoped catalog items are doctrinally read-only at the catalog
    // route — they're owned by the supply route. The handler returns 400 so
    // the planner UI can surface a clear error rather than appearing to save.
    const unit = await seedTestUnit();
    createdUnitIds.push(unit.id);
    const scopedItem = await seedTestCatalogItem(unit.id, {
      name: "TEST_CATALOG_SCOPED_ITEM",
    });

    const res = await request(app)
      .patch(`/api/catalog/items/${scopedItem.id}`)
      .send({ name: "TEST_CATALOG_SCOPED_RENAMED" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/global custom catalog items/i);
  });
});
