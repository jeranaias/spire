import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { catalogItemsTable } from "@workspace/db";
import { asc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/catalog/items", async (_req, res) => {
  const items = await db
    .select()
    .from(catalogItemsTable)
    .orderBy(asc(catalogItemsTable.supplyClass), asc(catalogItemsTable.name));
  res.json(
    items.map((item) => ({
      id: item.id,
      supplyClass: item.supplyClass,
      name: item.name,
      nsn: item.nsn,
      unit: item.unit,
      baseDailyRate: item.baseDailyRate,
      criticality: item.criticality,
      notes: item.notes,
    })),
  );
});

export default router;
