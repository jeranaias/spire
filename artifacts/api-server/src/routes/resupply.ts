import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  resupplyEventsTable,
  unitsTable,
  catalogItemsTable,
  activityTable,
  syncOutboxTable,
} from "@workspace/db";
import {
  ListUnitResupplyParams,
  CreateResupplyEventParams,
  CreateResupplyEventBody,
  UpdateResupplyEventParams,
  UpdateResupplyEventBody,
} from "@workspace/api-zod";
import { eq, asc } from "drizzle-orm";

const router: IRouter = Router();

function serializeEvent(
  ev: typeof resupplyEventsTable.$inferSelect,
  unitName: string,
  itemName: string | null,
) {
  return {
    id: ev.id,
    unitId: ev.unitId,
    unitName,
    supplyClass: ev.supplyClass,
    itemId: ev.itemId,
    itemName,
    quantity: ev.quantity,
    unit: ev.unit,
    scheduledFor: ev.scheduledFor.toISOString(),
    status: ev.status,
    assignedTo: ev.assignedTo,
    notes: ev.notes,
    createdAt: ev.createdAt.toISOString(),
  };
}

router.get("/units/:unitId/resupply", async (req, res) => {
  const { unitId } = ListUnitResupplyParams.parse(req.params);
  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }
  const rows = await db
    .select({
      ev: resupplyEventsTable,
      item: catalogItemsTable,
    })
    .from(resupplyEventsTable)
    .leftJoin(
      catalogItemsTable,
      eq(resupplyEventsTable.itemId, catalogItemsTable.id),
    )
    .where(eq(resupplyEventsTable.unitId, unitId))
    .orderBy(asc(resupplyEventsTable.scheduledFor));

  res.json(
    rows.map(({ ev, item }) =>
      serializeEvent(ev, unit.name, item?.name ?? null),
    ),
  );
});

router.post("/units/:unitId/resupply", async (req, res) => {
  const { unitId } = CreateResupplyEventParams.parse(req.params);
  const body = CreateResupplyEventBody.parse(req.body);
  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  let itemName: string | null = null;
  if (body.itemId) {
    const [item] = await db
      .select()
      .from(catalogItemsTable)
      .where(eq(catalogItemsTable.id, body.itemId));
    itemName = item?.name ?? null;
  }

  const ev = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(resupplyEventsTable)
      .values({
        unitId,
        supplyClass: body.supplyClass,
        itemId: body.itemId ?? null,
        quantity: body.quantity,
        unit: body.unit,
        scheduledFor: new Date(body.scheduledFor),
        status: "planned",
        assignedTo: body.assignedTo ?? null,
        notes: body.notes ?? null,
      })
      .returning();
    if (!row) throw new Error("Failed to create resupply event");

    await tx.insert(activityTable).values({
      kind: "resupply_planned",
      message: `Resupply planned for ${unit.name}: ${body.quantity} ${body.unit} of Class ${body.supplyClass}${itemName ? ` (${itemName})` : ""}`,
      unitId: unit.id,
      unitName: unit.name,
    });
    await tx.insert(syncOutboxTable).values({
      entityKind: "resupply_event",
      entityId: row.id,
      unitId: unit.id,
      op: "create",
      payload: {
        supplyClass: body.supplyClass,
        quantity: body.quantity,
        unit: body.unit,
        itemName: itemName,
        unitName: unit.name,
      },
    });
    return row;
  });

  if (!ev) {
    res.status(500).json({ error: "Failed to create event" });
    return;
  }

  res.status(201).json(serializeEvent(ev, unit.name, itemName));
});

router.patch("/resupply/:eventId", async (req, res) => {
  const { eventId } = UpdateResupplyEventParams.parse(req.params);
  const body = UpdateResupplyEventBody.parse(req.body);
  const updates: { status: typeof body.status; assignedTo?: string | null } = {
    status: body.status,
  };
  if (body.assignedTo !== undefined) {
    updates.assignedTo = body.assignedTo;
  }
  const [ev] = await db
    .update(resupplyEventsTable)
    .set(updates)
    .where(eq(resupplyEventsTable.id, eventId))
    .returning();
  if (!ev) {
    res.status(404).json({ error: "Resupply event not found" });
    return;
  }
  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, ev.unitId));
  let itemName: string | null = null;
  if (ev.itemId) {
    const [item] = await db
      .select()
      .from(catalogItemsTable)
      .where(eq(catalogItemsTable.id, ev.itemId));
    itemName = item?.name ?? null;
  }

  if (body.status === "delivered" && unit) {
    await db.insert(activityTable).values({
      kind: "resupply_delivered",
      message: `Resupply delivered to ${unit.name}: ${ev.quantity} ${ev.unit} (Class ${ev.supplyClass})`,
      unitId: unit.id,
      unitName: unit.name,
    });
  }

  res.json(serializeEvent(ev, unit?.name ?? "", itemName));
});

export default router;
