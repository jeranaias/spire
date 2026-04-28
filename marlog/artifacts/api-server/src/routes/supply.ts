import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  supplyEntriesTable,
  catalogItemsTable,
  unitsTable,
  activityTable,
  syncOutboxTable,
  resupplyEventsTable,
} from "@workspace/db";
import {
  GetUnitSupplyParams,
  UpsertUnitSupplyParams,
  UpsertUnitSupplyBody,
  CalculateRequirementsParams,
  CalculateRequirementsBody,
  DeleteUnitSupplyParams,
  CopySupplyFromUnitParams,
  CopySupplyFromUnitBody,
} from "@workspace/api-zod";
import { eq, and, gt, inArray } from "drizzle-orm";
import {
  adjustedDailyRate,
  statusFromDays,
  DOS_CLASSES,
  type Climate,
  type OpTempo,
  type SupplyClass,
} from "../lib/logistics";
import { computeUnitMetrics, round2 } from "./units";

const router: IRouter = Router();

router.get("/units/:unitId/supply", async (req, res) => {
  const { unitId } = GetUnitSupplyParams.parse(req.params);
  const m = await computeUnitMetrics(unitId);
  if (!m) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }
  res.json(m.enriched);
});

router.post("/units/:unitId/supply", async (req, res) => {
  const { unitId } = UpsertUnitSupplyParams.parse(req.params);
  const body = UpsertUnitSupplyBody.parse(req.body);

  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }
  const [item] = await db
    .select()
    .from(catalogItemsTable)
    .where(eq(catalogItemsTable.id, body.itemId));
  if (!item) {
    res.status(404).json({ error: "Catalog item not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(supplyEntriesTable)
    .where(
      and(
        eq(supplyEntriesTable.unitId, unitId),
        eq(supplyEntriesTable.itemId, body.itemId),
      ),
    );

  const op = existing ? "update" : "create";

  const saved = await db.transaction(async (tx) => {
    let row;
    if (existing) {
      [row] = await tx
        .update(supplyEntriesTable)
        .set({ onHand: body.onHand, updatedAt: new Date() })
        .where(eq(supplyEntriesTable.id, existing.id))
        .returning();
    } else {
      [row] = await tx
        .insert(supplyEntriesTable)
        .values({
          unitId,
          itemId: body.itemId,
          onHand: body.onHand,
        })
        .returning();
    }
    if (!row) throw new Error("Failed to save supply entry");

    await tx.insert(activityTable).values({
      kind: "supply_updated",
      message: `${item.name} updated to ${row.onHand} ${item.unit} for ${unit.name}`,
      unitId: unit.id,
      unitName: unit.name,
    });
    await tx.insert(syncOutboxTable).values({
      entityKind: "supply_entry",
      entityId: row.id,
      unitId: unit.id,
      op,
      payload: {
        itemId: body.itemId,
        itemName: item.name,
        unitName: unit.name,
        onHand: body.onHand,
      },
    });
    return row;
  });

  if (!saved) {
    res.status(500).json({ error: "Failed to save supply entry" });
    return;
  }

  const dailyConsumption = adjustedDailyRate(
    item.baseDailyRate,
    item.supplyClass as SupplyClass,
    unit.climate as Climate,
    unit.opTempo as OpTempo,
    unit.personnel,
  );
  const required = dailyConsumption * unit.missionDays;
  const daysOfSupply =
    dailyConsumption > 0 ? saved.onHand / dailyConsumption : 999;
  const shortfall = Math.max(0, required - saved.onHand);
  const status = statusFromDays(daysOfSupply);

  res.json({
    id: saved.id,
    unitId: saved.unitId,
    itemId: saved.itemId,
    item: {
      id: item.id,
      supplyClass: item.supplyClass,
      name: item.name,
      nsn: item.nsn,
      unit: item.unit,
      baseDailyRate: item.baseDailyRate,
      criticality: item.criticality,
      notes: item.notes,
    },
    onHand: saved.onHand,
    dailyConsumption: round2(dailyConsumption),
    daysOfSupply: round2(daysOfSupply),
    required: round2(required),
    shortfall: round2(shortfall),
    status,
    updatedAt: saved.updatedAt.toISOString(),
  });
});

router.post("/units/:unitId/calculate", async (req, res) => {
  const { unitId } = CalculateRequirementsParams.parse(req.params);
  const body = CalculateRequirementsBody.parse(req.body);

  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }
  const personnel = body.personnel ?? unit.personnel;
  const allItems = await db.select().from(catalogItemsTable);
  // Exclude Class IX — repair parts are consumed per-failure, not per-day
  const items = allItems.filter((item) =>
    DOS_CLASSES.includes(item.supplyClass as SupplyClass),
  );

  const lines = items.map((item) => {
    const daily = adjustedDailyRate(
      item.baseDailyRate,
      item.supplyClass as SupplyClass,
      body.climate as Climate,
      body.opTempo as OpTempo,
      personnel,
    );
    return {
      item: {
        id: item.id,
        supplyClass: item.supplyClass,
        name: item.name,
        nsn: item.nsn,
        unit: item.unit,
        baseDailyRate: item.baseDailyRate,
        criticality: item.criticality,
        notes: item.notes,
      },
      dailyConsumption: round2(daily),
      totalRequired: round2(daily * body.days),
    };
  });

  res.json({
    days: body.days,
    personnel,
    climate: body.climate,
    opTempo: body.opTempo,
    lines,
  });
});

router.post("/units/:unitId/supply/copy-from", async (req, res) => {
  const { unitId } = CopySupplyFromUnitParams.parse(req.params);
  const { sourceUnitId } = CopySupplyFromUnitBody.parse(req.body);

  const [targetUnit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!targetUnit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const [sourceUnit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, sourceUnitId));
  if (!sourceUnit) {
    res.status(404).json({ error: "Source unit not found" });
    return;
  }

  const sourceEntries = await db
    .select()
    .from(supplyEntriesTable)
    .where(eq(supplyEntriesTable.unitId, sourceUnitId));

  const targetEntries = await db
    .select()
    .from(supplyEntriesTable)
    .where(eq(supplyEntriesTable.unitId, unitId));

  const alreadyTracked = new Set(targetEntries.map((e) => e.itemId));

  const toAdd = sourceEntries.filter((e) => !alreadyTracked.has(e.itemId));
  const skipped = sourceEntries.length - toAdd.length;

  if (toAdd.length > 0) {
    const itemIds = toAdd.map((e) => e.itemId);
    const catalogItems = await db
      .select()
      .from(catalogItemsTable)
      .where(
        itemIds.length === 1
          ? eq(catalogItemsTable.id, itemIds[0]!)
          : inArray(catalogItemsTable.id, itemIds),
      );
    const itemMap = new Map(catalogItems.map((c) => [c.id, c]));

    await db.transaction(async (tx) => {
      for (const entry of toAdd) {
        const [inserted] = await tx
          .insert(supplyEntriesTable)
          .values({
            unitId,
            itemId: entry.itemId,
            onHand: 0,
          })
          .returning();
        if (!inserted) throw new Error("Failed to insert supply entry");

        const item = itemMap.get(entry.itemId);
        await tx.insert(syncOutboxTable).values({
          entityKind: "supply_entry",
          entityId: inserted.id,
          unitId: targetUnit.id,
          op: "create",
          payload: {
            itemId: entry.itemId,
            itemName: item?.name ?? null,
            unitName: targetUnit.name,
            onHand: 0,
          },
        });
      }

      await tx.insert(activityTable).values({
        kind: "supply_updated",
        message: `Copied ${toAdd.length} supply item${toAdd.length === 1 ? "" : "s"} from ${sourceUnit.name} to ${targetUnit.name}`,
        unitId: targetUnit.id,
        unitName: targetUnit.name,
      });
    });
  }

  res.json({ added: toAdd.length, skipped });
});

router.delete("/units/:unitId/supply/:itemId", async (req, res) => {
  const { unitId, itemId } = DeleteUnitSupplyParams.parse(req.params);

  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const [entry] = await db
    .select()
    .from(supplyEntriesTable)
    .where(
      and(
        eq(supplyEntriesTable.unitId, unitId),
        eq(supplyEntriesTable.itemId, itemId),
      ),
    );
  if (!entry) {
    res.status(404).json({ error: "Supply entry not found" });
    return;
  }

  const [item] = await db
    .select()
    .from(catalogItemsTable)
    .where(eq(catalogItemsTable.id, itemId));

  await db.transaction(async (tx) => {
    await tx
      .delete(supplyEntriesTable)
      .where(eq(supplyEntriesTable.id, entry.id));

    await tx
      .delete(resupplyEventsTable)
      .where(
        and(
          eq(resupplyEventsTable.unitId, unitId),
          eq(resupplyEventsTable.itemId, itemId),
          gt(resupplyEventsTable.scheduledFor, new Date()),
        ),
      );

    await tx.insert(activityTable).values({
      kind: "supply_updated",
      message: `${item?.name ?? itemId} removed from ${unit.name} supply list`,
      unitId: unit.id,
      unitName: unit.name,
    });

    await tx.insert(syncOutboxTable).values({
      entityKind: "supply_entry",
      entityId: entry.id,
      unitId: unit.id,
      op: "delete",
      payload: {
        itemId,
        itemName: item?.name ?? null,
        unitName: unit.name,
      },
    });
  });

  res.status(204).send();
});

export default router;
