import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  catalogItemsTable,
  catalogItemDeletionsTable,
  supplyEntriesTable,
  unitsTable,
  activityTable,
  syncOutboxTable,
  resupplyEventsTable,
  type CatalogItemDeletionSnapshot,
} from "@workspace/db";
import {
  UpdateCatalogItemParams,
  UpdateCatalogItemBody,
  DeleteCatalogItemParams,
  RestoreCatalogItemParams,
} from "@workspace/api-zod";
import { and, asc, eq, gt, isNull, inArray, lte } from "drizzle-orm";

const router: IRouter = Router();

// Length of the undo grace window for a catalog item deletion. The UI shows a
// ~15-second toast; we add a small buffer so a click at the very end still
// reaches the server in time.
const RESTORE_WINDOW_MS = 30_000;

// Opportunistic sweep of expired deletion snapshots. Called at the top of the
// DELETE and restore handlers so the catalog_item_deletions table stays
// roughly proportional to recent deletes only. Without this, a snapshot
// that's never undone and never re-attempted would sit in the table forever,
// holding stale supply / resupply JSONB for long-gone items.
async function purgeExpiredCatalogItemDeletions(): Promise<void> {
  try {
    await db
      .delete(catalogItemDeletionsTable)
      .where(lte(catalogItemDeletionsTable.expiresAt, new Date()));
  } catch (err) {
    // Cleanup is best-effort; failure must never break the caller's request.
    console.error("Failed to purge expired catalog item deletions", err);
  }
}

router.get("/catalog/items", async (_req, res) => {
  const items = await db
    .select()
    .from(catalogItemsTable)
    .where(isNull(catalogItemsTable.scopedUnitId))
    .orderBy(asc(catalogItemsTable.supplyClass), asc(catalogItemsTable.name));

  // Build a map of itemId -> [{id, name}] of units that currently track each
  // catalog item, so the catalog management UI can warn planners exactly which
  // units will be impacted before they delete an item.
  const usageRows = await db
    .select({
      itemId: supplyEntriesTable.itemId,
      unitId: unitsTable.id,
      unitName: unitsTable.name,
    })
    .from(supplyEntriesTable)
    .innerJoin(unitsTable, eq(unitsTable.id, supplyEntriesTable.unitId));

  const usageByItem = new Map<string, { id: string; name: string }[]>();
  for (const row of usageRows) {
    const list = usageByItem.get(row.itemId);
    const entry = { id: row.unitId, name: row.unitName };
    if (list) {
      list.push(entry);
    } else {
      usageByItem.set(row.itemId, [entry]);
    }
  }
  for (const list of usageByItem.values()) {
    list.sort((a, b) => a.name.localeCompare(b.name));
  }

  res.json(
    items.map((item) => {
      const usedByUnits = usageByItem.get(item.id) ?? [];
      return {
        id: item.id,
        supplyClass: item.supplyClass,
        name: item.name,
        nsn: item.nsn,
        unit: item.unit,
        baseDailyRate: item.baseDailyRate,
        criticality: item.criticality,
        notes: item.notes,
        isCustom: item.isCustom,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        usedByUnitCount: usedByUnits.length,
        usedByUnits,
      };
    }),
  );
});

router.patch("/catalog/items/:itemId", async (req, res) => {
  const { itemId } = UpdateCatalogItemParams.parse(req.params);
  const body = UpdateCatalogItemBody.parse(req.body);

  const [existing] = await db
    .select()
    .from(catalogItemsTable)
    .where(eq(catalogItemsTable.id, itemId));
  if (!existing) {
    res.status(404).json({ error: "Catalog item not found" });
    return;
  }
  if (!existing.isCustom || existing.scopedUnitId !== null) {
    res.status(400).json({
      error: "Only global custom catalog items can be edited",
    });
    return;
  }

  const updates: Partial<typeof catalogItemsTable.$inferInsert> = {
    name: body.name,
  };
  if (body.notes !== undefined) updates.notes = body.notes;
  if (body.criticality !== undefined) updates.criticality = body.criticality;
  if (body.baseDailyRate !== undefined)
    updates.baseDailyRate = body.baseDailyRate;
  if (body.supplyClass !== undefined) updates.supplyClass = body.supplyClass;
  if (body.unit !== undefined) updates.unit = body.unit;
  if (body.nsn !== undefined) updates.nsn = body.nsn;

  const [updated] = await db
    .update(catalogItemsTable)
    .set(updates)
    .where(eq(catalogItemsTable.id, itemId))
    .returning();
  if (!updated) {
    res.status(500).json({ error: "Failed to update catalog item" });
    return;
  }

  // Choose the most informative activity message: a pure rename gets the
  // familiar "renamed" copy, otherwise summarize as a generic edit.
  const renamed = existing.name !== updated.name;
  const otherChange =
    existing.supplyClass !== updated.supplyClass ||
    existing.unit !== updated.unit ||
    (existing.nsn ?? null) !== (updated.nsn ?? null) ||
    existing.baseDailyRate !== updated.baseDailyRate ||
    existing.criticality !== updated.criticality ||
    (existing.notes ?? null) !== (updated.notes ?? null);

  let message: string;
  if (renamed && !otherChange) {
    message = `Custom catalog item renamed: ${existing.name} → ${updated.name}`;
  } else if (renamed && otherChange) {
    message = `Custom catalog item edited: ${existing.name} → ${updated.name}`;
  } else {
    message = `Custom catalog item edited: ${updated.name}`;
  }

  await db.insert(activityTable).values({
    kind: "supply_updated",
    message,
    unitId: null,
    unitName: null,
  });

  res.json({
    id: updated.id,
    supplyClass: updated.supplyClass,
    name: updated.name,
    nsn: updated.nsn,
    unit: updated.unit,
    baseDailyRate: updated.baseDailyRate,
    criticality: updated.criticality,
    notes: updated.notes,
    isCustom: updated.isCustom,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  });
});

router.delete("/catalog/items/:itemId", async (req, res) => {
  const { itemId } = DeleteCatalogItemParams.parse(req.params);

  // Sweep any expired snapshots before writing a new one so the table stays
  // bounded even on systems that mostly delete-and-forget without ever
  // attempting a restore.
  await purgeExpiredCatalogItemDeletions();

  const [existing] = await db
    .select()
    .from(catalogItemsTable)
    .where(eq(catalogItemsTable.id, itemId));
  if (!existing) {
    res.status(404).json({ error: "Catalog item not found" });
    return;
  }
  if (!existing.isCustom || existing.scopedUnitId !== null) {
    res.status(400).json({
      error: "Only global custom catalog items can be deleted",
    });
    return;
  }

  // Find every unit currently tracking this item so we can write activity
  // and outbox records before the cascade deletes the supply entries.
  const affected = await db
    .select({
      entryId: supplyEntriesTable.id,
      unitId: supplyEntriesTable.unitId,
      onHand: supplyEntriesTable.onHand,
      updatedAt: supplyEntriesTable.updatedAt,
    })
    .from(supplyEntriesTable)
    .where(eq(supplyEntriesTable.itemId, itemId));

  const unitIds = Array.from(new Set(affected.map((a) => a.unitId)));
  const units = unitIds.length
    ? await db
        .select({ id: unitsTable.id, name: unitsTable.name })
        .from(unitsTable)
        .where(inArray(unitsTable.id, unitIds))
    : [];
  const unitNameById = new Map(units.map((u) => [u.id, u.name]));

  // Capture future resupply events with full fields so a restore can
  // re-create them exactly as they were before the cascade dropped them.
  const futureResupplies = await db
    .select()
    .from(resupplyEventsTable)
    .where(
      and(
        eq(resupplyEventsTable.itemId, itemId),
        gt(resupplyEventsTable.scheduledFor, new Date()),
      ),
    );

  const expiresAt = new Date(Date.now() + RESTORE_WINDOW_MS);

  await db.transaction(async (tx) => {
    // Cancel any future resupply events tied to this item so the UI's
    // "future resupply events will be cancelled" warning stays truthful.
    if (futureResupplies.length > 0) {
      await tx
        .delete(resupplyEventsTable)
        .where(
          and(
            eq(resupplyEventsTable.itemId, itemId),
            gt(resupplyEventsTable.scheduledFor, new Date()),
          ),
        );
    }

    // Write outbox + activity entries for every unit losing the item before
    // deletion. We capture the inserted IDs into the deletion snapshot so a
    // restore within the grace window can wipe these audit / sync rows
    // (otherwise the audit log would show a confusing "deleted then restored"
    // pair, and the outbox would push a delete that's no longer real).
    const outboxIds: string[] = [];
    for (const a of affected) {
      const unitName = unitNameById.get(a.unitId) ?? null;
      const [row] = await tx
        .insert(syncOutboxTable)
        .values({
          entityKind: "supply_entry",
          entityId: a.entryId,
          unitId: a.unitId,
          op: "delete",
          payload: {
            itemId,
            itemName: existing.name,
            unitName,
          },
        })
        .returning({ id: syncOutboxTable.id });
      if (row) outboxIds.push(row.id);
    }

    const activityIds: string[] = [];
    if (unitIds.length > 0) {
      for (const id of unitIds) {
        const unitName = unitNameById.get(id) ?? null;
        const [row] = await tx
          .insert(activityTable)
          .values({
            kind: "supply_updated",
            message: `${existing.name} removed from ${unitName ?? "unit"} (catalog item deleted)`,
            unitId: id,
            unitName,
          })
          .returning({ id: activityTable.id });
        if (row) activityIds.push(row.id);
      }
    }

    const [summary] = await tx
      .insert(activityTable)
      .values({
        kind: "supply_updated",
        message: `Custom catalog item deleted: ${existing.name}${
          unitIds.length
            ? ` (cleared from ${unitIds.length} unit${unitIds.length === 1 ? "" : "s"})`
            : ""
        }`,
        unitId: null,
        unitName: null,
      })
      .returning({ id: activityTable.id });
    if (summary) activityIds.push(summary.id);

    // Cascades to supply_entries (FK onDelete: cascade) and nulls
    // resupply_events.itemId (FK onDelete: set null) — though we already
    // hard-deleted the future ones above for restore fidelity.
    await tx.delete(catalogItemsTable).where(eq(catalogItemsTable.id, itemId));

    const snapshot: CatalogItemDeletionSnapshot = {
      item: {
        id: existing.id,
        supplyClass: existing.supplyClass,
        name: existing.name,
        nsn: existing.nsn,
        unit: existing.unit,
        baseDailyRate: existing.baseDailyRate,
        criticality: existing.criticality,
        notes: existing.notes,
        isCustom: existing.isCustom,
        scopedUnitId: existing.scopedUnitId,
        createdAt: existing.createdAt.toISOString(),
        updatedAt: existing.updatedAt.toISOString(),
      },
      supplyEntries: affected.map((a) => ({
        id: a.entryId,
        unitId: a.unitId,
        onHand: a.onHand,
        updatedAt: a.updatedAt.toISOString(),
      })),
      resupplyEvents: futureResupplies.map((r) => ({
        id: r.id,
        unitId: r.unitId,
        supplyClass: r.supplyClass,
        quantity: r.quantity,
        unit: r.unit,
        scheduledFor: r.scheduledFor.toISOString(),
        status: r.status,
        assignedTo: r.assignedTo,
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
      })),
      activityIds,
      outboxIds,
    };

    // Drop any prior snapshot for this id (e.g. a stale row from an earlier
    // delete + re-create cycle that never got cleaned up) before inserting.
    await tx
      .delete(catalogItemDeletionsTable)
      .where(eq(catalogItemDeletionsTable.id, itemId));
    await tx.insert(catalogItemDeletionsTable).values({
      id: itemId,
      snapshot,
      expiresAt,
    });
  });

  res.json({
    deletedItemId: itemId,
    affectedUnits: unitIds.length,
    removedSupplyEntries: affected.length,
    cancelledResupplyEvents: futureResupplies.length,
    restoreToken: itemId,
    restoreExpiresAt: expiresAt.toISOString(),
  });
});

router.post("/catalog/items/:itemId/restore", async (req, res) => {
  const { itemId } = RestoreCatalogItemParams.parse(req.params);

  const [deletion] = await db
    .select()
    .from(catalogItemDeletionsTable)
    .where(eq(catalogItemDeletionsTable.id, itemId));
  if (!deletion) {
    res.status(404).json({ error: "No restore record for this item" });
    return;
  }
  if (deletion.expiresAt.getTime() <= Date.now()) {
    // Clean up the expired snapshot opportunistically so it doesn't linger,
    // and sweep any other expired snapshots while we're at it — a planner
    // bumping into the expiry path is a strong signal there are likely other
    // stale rows to clear.
    await purgeExpiredCatalogItemDeletions();
    res.status(410).json({ error: "Restore window has expired" });
    return;
  }

  const snapshot = deletion.snapshot;

  const restoredItem = await db.transaction(async (tx) => {
    // Re-insert the catalog item with its original id so existing references
    // (e.g. weapon_dodic_rates.catalogItemId, sync mappings) keep pointing
    // at the same row as before the delete.
    const [item] = await tx
      .insert(catalogItemsTable)
      .values({
        id: snapshot.item.id,
        supplyClass: snapshot.item.supplyClass,
        name: snapshot.item.name,
        nsn: snapshot.item.nsn,
        unit: snapshot.item.unit,
        baseDailyRate: snapshot.item.baseDailyRate,
        criticality: snapshot.item.criticality,
        notes: snapshot.item.notes,
        isCustom: snapshot.item.isCustom,
        scopedUnitId: snapshot.item.scopedUnitId,
        createdAt: new Date(snapshot.item.createdAt),
        updatedAt: new Date(snapshot.item.updatedAt),
      })
      .returning();
    if (!item) throw new Error("Failed to restore catalog item");

    if (snapshot.supplyEntries.length > 0) {
      await tx.insert(supplyEntriesTable).values(
        snapshot.supplyEntries.map((e) => ({
          id: e.id,
          unitId: e.unitId,
          itemId: snapshot.item.id,
          onHand: e.onHand,
          updatedAt: new Date(e.updatedAt),
        })),
      );
    }

    if (snapshot.resupplyEvents.length > 0) {
      await tx.insert(resupplyEventsTable).values(
        snapshot.resupplyEvents.map((r) => ({
          id: r.id,
          unitId: r.unitId,
          supplyClass: r.supplyClass,
          itemId: snapshot.item.id,
          quantity: r.quantity,
          unit: r.unit,
          scheduledFor: new Date(r.scheduledFor),
          status: r.status,
          assignedTo: r.assignedTo,
          notes: r.notes,
          createdAt: new Date(r.createdAt),
        })),
      );
    }

    // Wipe the audit / sync rows the original DELETE wrote so the undo leaves
    // no trace of the would-be delete in the audit log or in pending outbox
    // pushes — the planner caught it within the grace window.
    if (snapshot.activityIds.length > 0) {
      await tx
        .delete(activityTable)
        .where(inArray(activityTable.id, snapshot.activityIds));
    }
    if (snapshot.outboxIds.length > 0) {
      await tx
        .delete(syncOutboxTable)
        .where(inArray(syncOutboxTable.id, snapshot.outboxIds));
    }

    // Single audit entry recording the undo so planners can see in the
    // recent activity feed that the catalog item was restored.
    await tx.insert(activityTable).values({
      kind: "supply_updated",
      message: `Custom catalog item restored: ${snapshot.item.name} (undo)`,
      unitId: null,
      unitName: null,
    });

    await tx
      .delete(catalogItemDeletionsTable)
      .where(eq(catalogItemDeletionsTable.id, itemId));

    return item;
  });

  res.json({
    restoredItem: {
      id: restoredItem.id,
      supplyClass: restoredItem.supplyClass,
      name: restoredItem.name,
      nsn: restoredItem.nsn,
      unit: restoredItem.unit,
      baseDailyRate: restoredItem.baseDailyRate,
      criticality: restoredItem.criticality,
      notes: restoredItem.notes,
      isCustom: restoredItem.isCustom,
      createdAt: restoredItem.createdAt.toISOString(),
      updatedAt: restoredItem.updatedAt.toISOString(),
    },
    restoredSupplyEntries: snapshot.supplyEntries.length,
    restoredResupplyEvents: snapshot.resupplyEvents.length,
  });
});

export default router;
