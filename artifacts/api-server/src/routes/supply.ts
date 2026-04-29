import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  supplyEntriesTable,
  catalogItemsTable,
  unitsTable,
  activityTable,
  syncOutboxTable,
  resupplyEventsTable,
  supplySnapshotsTable,
  unitSupplyDeletionsTable,
  type UnitSupplyDeletionSnapshot,
} from "@workspace/db";
import {
  GetUnitSupplyParams,
  UpsertUnitSupplyParams,
  UpsertUnitSupplyBody,
  CalculateRequirementsParams,
  CalculateRequirementsBody,
  DeleteUnitSupplyParams,
  RestoreUnitSupplyParams,
  CopySupplyFromUnitParams,
  CopySupplyFromUnitBody,
  UpdateCustomSupplyItemParams,
  UpdateCustomSupplyItemBody,
  PromoteCustomSupplyItemParams,
  UpdateUnitSupplyEntryParams,
  UpdateUnitSupplyEntryBody,
} from "@workspace/api-zod";
import { eq, and, gt, inArray, isNull, or } from "drizzle-orm";
import {
  adjustedDailyRate,
  deriveRequirement,
  buildSupplyEntryResponse,
  round2,
  DOS_CLASSES,
  type Climate,
  type OpTempo,
  type SupplyClass,
} from "../lib/logistics";
import { computeUnitMetrics } from "./units";

const router: IRouter = Router();

// Length of the undo grace window for a unit supply removal. The UI shows a
// ~15-second toast; we add a small buffer so a click at the very end still
// reaches the server in time. Mirrors the catalog delete window.
const RESTORE_WINDOW_MS = 30_000;

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

  // Enforce mutual exclusivity: exactly one of itemId or customItem must be provided
  if (body.itemId && body.customItem) {
    res
      .status(400)
      .json({ error: "Provide either itemId or customItem, not both" });
    return;
  }

  let item: typeof catalogItemsTable.$inferSelect;

  if (body.customItem) {
    // --- Custom item path: auto-create a catalog entry ---
    const ci = body.customItem;
    const scopedUnitId = body.saveToCatalog ? null : unitId;

    const [created] = await db
      .insert(catalogItemsTable)
      .values({
        supplyClass: ci.supplyClass,
        name: ci.name,
        nsn: ci.nsn ?? null,
        unit: ci.unit,
        baseDailyRate: ci.baseDailyRate ?? 0,
        criticality: ci.criticality ?? "low",
        notes: ci.notes ?? null,
        isCustom: true,
        scopedUnitId,
      })
      .returning();
    if (!created) {
      res.status(500).json({ error: "Failed to create custom catalog entry" });
      return;
    }
    item = created;
  } else if (body.itemId) {
    // --- Catalog pick path: enforce scope ---
    // Only allow global items (scopedUnitId IS NULL) or items scoped to this unit.
    // Prevents attaching another unit's custom item via known UUID.
    const [found] = await db
      .select()
      .from(catalogItemsTable)
      .where(
        and(
          eq(catalogItemsTable.id, body.itemId),
          or(
            isNull(catalogItemsTable.scopedUnitId),
            eq(catalogItemsTable.scopedUnitId, unitId),
          ),
        ),
      );
    if (!found) {
      res
        .status(404)
        .json({ error: "Catalog item not found or not accessible for this unit" });
      return;
    }
    item = found;
  } else {
    res
      .status(400)
      .json({ error: "Either itemId or customItem must be provided" });
    return;
  }

  const [existing] = await db
    .select()
    .from(supplyEntriesTable)
    .where(
      and(
        eq(supplyEntriesTable.unitId, unitId),
        eq(supplyEntriesTable.itemId, item.id),
      ),
    );

  const op = existing ? "update" : "create";

  // Determine whether the override is being changed in this request.
  // undefined = not included in body (keep existing), null = clear, number = set.
  const overrideInBody = body.requiredOverride;
  const overrideIsProvided = overrideInBody !== undefined;
  const existingOverride = existing?.requiredOverride ?? null;
  const newOverride = overrideIsProvided ? (overrideInBody ?? null) : existingOverride;
  const overrideChanged = overrideIsProvided && newOverride !== existingOverride;

  const saved = await db.transaction(async (tx) => {
    let row;
    if (existing) {
      [row] = await tx
        .update(supplyEntriesTable)
        .set({
          onHand: body.onHand,
          ...(overrideIsProvided ? { requiredOverride: newOverride } : {}),
          updatedAt: new Date(),
        })
        .where(eq(supplyEntriesTable.id, existing.id))
        .returning();
    } else {
      [row] = await tx
        .insert(supplyEntriesTable)
        .values({
          unitId,
          itemId: item.id,
          onHand: body.onHand,
          requiredOverride: newOverride,
        })
        .returning();
    }
    if (!row) throw new Error("Failed to save supply entry");

    // Activity: describe what actually changed
    const overrideMsg = overrideChanged
      ? newOverride === null
        ? ` Required override cleared (reset to auto-computed).`
        : newOverride === 0
          ? ` Required set to 0 (not a requirement).`
          : ` Required override set to ${newOverride} ${item.unit}.`
      : "";
    await tx.insert(activityTable).values({
      kind: "supply_updated",
      message: `${item.name} updated to ${row.onHand} ${item.unit} for ${unit.name}.${overrideMsg}`,
      unitId: unit.id,
      unitName: unit.name,
    });
    await tx.insert(syncOutboxTable).values({
      entityKind: "supply_entry",
      entityId: row.id,
      unitId: unit.id,
      op,
      payload: {
        itemId: item.id,
        itemName: item.name,
        unitName: unit.name,
        onHand: body.onHand,
        requiredOverride: newOverride,
      },
    });
    await tx.insert(supplySnapshotsTable).values({
      unitId: unit.id,
      itemId: item.id,
      onHand: body.onHand,
      personnel: unit.personnel,
      climate: unit.climate,
      opTempo: unit.opTempo,
      missionDays: unit.missionDays,
      source: "planner_edit",
      actorNote: `${item.name} updated to ${body.onHand} ${item.unit}${overrideMsg}`,
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

  const requirement = deriveRequirement({
    override: saved.requiredOverride,
    onHand: saved.onHand,
    dailyConsumption,
    missionDays: unit.missionDays,
  });

  res.json(
    buildSupplyEntryResponse({
      entry: saved,
      item,
      dailyConsumption,
      requirement,
    }),
  );
});

// Row-scoped, in-place update for an existing supply entry. Use this for
// everyday on-hand and required-override edits from the supply table. Adding
// new tracked items (catalog pick or custom item) still goes through the
// collection POST above, which is the only path that creates rows.
router.patch("/units/:unitId/supply/:itemId", async (req, res) => {
  const { unitId, itemId } = UpdateUnitSupplyEntryParams.parse(req.params);
  const body = UpdateUnitSupplyEntryBody.parse(req.body);

  const onHandProvided = body.onHand !== undefined;
  const overrideProvided = body.requiredOverride !== undefined;
  if (!onHandProvided && !overrideProvided) {
    res.status(400).json({
      error: "Provide at least one of onHand or requiredOverride",
    });
    return;
  }

  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(supplyEntriesTable)
    .where(
      and(
        eq(supplyEntriesTable.unitId, unitId),
        eq(supplyEntriesTable.itemId, itemId),
      ),
    );
  if (!existing) {
    res.status(404).json({ error: "Supply entry not found" });
    return;
  }

  const [item] = await db
    .select()
    .from(catalogItemsTable)
    .where(eq(catalogItemsTable.id, itemId));
  if (!item) {
    res.status(404).json({ error: "Catalog item not found" });
    return;
  }

  const newOnHand = onHandProvided ? body.onHand! : existing.onHand;
  const existingOverride = existing.requiredOverride ?? null;
  const newOverride = overrideProvided
    ? (body.requiredOverride ?? null)
    : existingOverride;
  const overrideChanged = overrideProvided && newOverride !== existingOverride;
  const onHandChanged = onHandProvided && newOnHand !== existing.onHand;

  const saved = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(supplyEntriesTable)
      .set({
        ...(onHandProvided ? { onHand: newOnHand } : {}),
        ...(overrideProvided ? { requiredOverride: newOverride } : {}),
        updatedAt: new Date(),
      })
      .where(eq(supplyEntriesTable.id, existing.id))
      .returning();
    if (!row) throw new Error("Failed to update supply entry");

    const overrideMsg = overrideChanged
      ? newOverride === null
        ? ` Required override cleared (reset to auto-computed).`
        : newOverride === 0
          ? ` Required set to 0 (not a requirement).`
          : ` Required override set to ${newOverride} ${item.unit}.`
      : "";
    const onHandMsg = onHandChanged
      ? `${item.name} updated to ${row.onHand} ${item.unit} for ${unit.name}.`
      : overrideChanged
        ? `${item.name} required quantity updated for ${unit.name}.`
        : `${item.name} updated for ${unit.name}.`;
    await tx.insert(activityTable).values({
      kind: "supply_updated",
      message: `${onHandMsg}${overrideMsg}`,
      unitId: unit.id,
      unitName: unit.name,
    });
    await tx.insert(syncOutboxTable).values({
      entityKind: "supply_entry",
      entityId: row.id,
      unitId: unit.id,
      op: "update",
      payload: {
        itemId: item.id,
        itemName: item.name,
        unitName: unit.name,
        onHand: row.onHand,
        requiredOverride: newOverride,
      },
    });
    if (onHandChanged) {
      await tx.insert(supplySnapshotsTable).values({
        unitId: unit.id,
        itemId: item.id,
        onHand: row.onHand,
        personnel: unit.personnel,
        climate: unit.climate,
        opTempo: unit.opTempo,
        missionDays: unit.missionDays,
        source: "planner_edit",
        actorNote: `${onHandMsg}${overrideMsg}`,
      });
    }
    return row;
  });

  if (!saved) {
    res.status(500).json({ error: "Failed to update supply entry" });
    return;
  }

  const dailyConsumption = adjustedDailyRate(
    item.baseDailyRate,
    item.supplyClass as SupplyClass,
    unit.climate as Climate,
    unit.opTempo as OpTempo,
    unit.personnel,
  );
  const daysOfSupply =
    dailyConsumption > 0 ? saved.onHand / dailyConsumption : 999;
  const savedOverride = saved.requiredOverride ?? null;

  const { required, isRequirement, shortfall, status } = deriveRequirement({
    override: savedOverride,
    onHand: saved.onHand,
    dailyConsumption,
    missionDays: unit.missionDays,
  });

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
      isCustom: item.isCustom,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    },
    onHand: saved.onHand,
    dailyConsumption: round2(dailyConsumption),
    daysOfSupply: round2(daysOfSupply),
    required: round2(required),
    shortfall: round2(shortfall),
    status,
    requiredOverride: savedOverride,
    isRequirement,
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
  const allItems = await db
    .select()
    .from(catalogItemsTable)
    .where(isNull(catalogItemsTable.scopedUnitId));
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
        isCustom: item.isCustom,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
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

  // Skip unit-scoped custom items from the source (they belong to source only)
  const sourceItemIds = sourceEntries.map((e) => e.itemId);
  const catalogItems =
    sourceItemIds.length > 0
      ? await db
          .select()
          .from(catalogItemsTable)
          .where(
            sourceItemIds.length === 1
              ? eq(catalogItemsTable.id, sourceItemIds[0]!)
              : inArray(catalogItemsTable.id, sourceItemIds),
          )
      : [];
  const scopedToSource = new Set(
    catalogItems
      .filter((c) => c.isCustom && c.scopedUnitId === sourceUnitId)
      .map((c) => c.id),
  );

  const toAdd = sourceEntries.filter(
    (e) => !alreadyTracked.has(e.itemId) && !scopedToSource.has(e.itemId),
  );
  const skipped = sourceEntries.length - toAdd.length;

  if (toAdd.length > 0) {
    const itemIds = toAdd.map((e) => e.itemId);
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

router.patch(
  "/units/:unitId/supply/:itemId/custom-item",
  async (req, res) => {
    const { unitId, itemId } = UpdateCustomSupplyItemParams.parse(req.params);
    const body = UpdateCustomSupplyItemBody.parse(req.body);

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
    if (!item) {
      res.status(404).json({ error: "Catalog item not found" });
      return;
    }

    // Only unit-scoped custom items can be edited via this endpoint.
    // Standard catalog items and globally-saved custom items are read-only here.
    if (!item.isCustom || item.scopedUnitId !== unitId) {
      res
        .status(400)
        .json({ error: "Only custom items scoped to this unit can be edited" });
      return;
    }

    const { updatedItem, updatedEntry } = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(catalogItemsTable)
        .set({
          name: body.name,
          supplyClass: body.supplyClass,
          unit: body.unit,
          nsn: body.nsn ?? null,
          baseDailyRate: body.baseDailyRate ?? 0,
          criticality: body.criticality,
          notes: body.notes ?? null,
          updatedAt: new Date(),
        })
        .where(eq(catalogItemsTable.id, itemId))
        .returning();
      if (!row) throw new Error("Failed to update catalog item");

      const [entryRow] = await tx
        .update(supplyEntriesTable)
        .set({ updatedAt: new Date() })
        .where(eq(supplyEntriesTable.id, entry.id))
        .returning();
      if (!entryRow) throw new Error("Failed to touch supply entry");

      await tx.insert(activityTable).values({
        kind: "supply_updated",
        message: `${row.name} details edited on ${unit.name}`,
        unitId: unit.id,
        unitName: unit.name,
      });

      await tx.insert(syncOutboxTable).values({
        entityKind: "supply_entry",
        entityId: entry.id,
        unitId: unit.id,
        op: "update",
        payload: {
          itemId: row.id,
          itemName: row.name,
          unitName: unit.name,
          onHand: entry.onHand,
        },
      });

      return { updatedItem: row, updatedEntry: entryRow };
    });

    const dailyConsumption = adjustedDailyRate(
      updatedItem.baseDailyRate,
      updatedItem.supplyClass as SupplyClass,
      unit.climate as Climate,
      unit.opTempo as OpTempo,
      unit.personnel,
    );
    const requirement = deriveRequirement({
      override: updatedEntry.requiredOverride,
      onHand: updatedEntry.onHand,
      dailyConsumption,
      missionDays: unit.missionDays,
    });

    res.json(
      buildSupplyEntryResponse({
        entry: updatedEntry,
        item: updatedItem,
        dailyConsumption,
        requirement,
      }),
    );
  },
);

router.post(
  "/units/:unitId/supply/:itemId/custom-item/promote",
  async (req, res) => {
    const { unitId, itemId } = PromoteCustomSupplyItemParams.parse(req.params);

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
    if (!item) {
      res.status(404).json({ error: "Catalog item not found" });
      return;
    }

    // Only unit-scoped custom items belonging to this unit can be promoted.
    if (!item.isCustom || item.scopedUnitId !== unitId) {
      res.status(400).json({
        error: "Only custom items scoped to this unit can be promoted",
      });
      return;
    }

    const promoted = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(catalogItemsTable)
        .set({ scopedUnitId: null })
        .where(eq(catalogItemsTable.id, itemId))
        .returning();
      if (!row) throw new Error("Failed to promote catalog item");

      await tx.insert(activityTable).values({
        kind: "supply_updated",
        message: `${row.name} promoted to shared catalog from ${unit.name}`,
        unitId: unit.id,
        unitName: unit.name,
      });

      await tx.insert(syncOutboxTable).values({
        entityKind: "catalog_item",
        entityId: row.id,
        unitId: unit.id,
        op: "update",
        payload: {
          itemId: row.id,
          itemName: row.name,
          unitName: unit.name,
          promotedToCatalog: true,
        },
      });

      return row;
    });

    res.json({
      id: promoted.id,
      supplyClass: promoted.supplyClass,
      name: promoted.name,
      nsn: promoted.nsn,
      unit: promoted.unit,
      baseDailyRate: promoted.baseDailyRate,
      criticality: promoted.criticality,
      notes: promoted.notes,
      isCustom: promoted.isCustom,
    });
  },
);

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

  // Capture future resupply events with full fields so a restore can
  // re-create them exactly as they were before the cascade dropped them.
  const futureResupplies = await db
    .select()
    .from(resupplyEventsTable)
    .where(
      and(
        eq(resupplyEventsTable.unitId, unitId),
        eq(resupplyEventsTable.itemId, itemId),
        gt(resupplyEventsTable.scheduledFor, new Date()),
      ),
    );

  const isUnitScopedCustom =
    !!item && item.isCustom && item.scopedUnitId === unitId;
  const expiresAt = new Date(Date.now() + RESTORE_WINDOW_MS);
  const itemName = item?.name ?? itemId;

  await db.transaction(async (tx) => {
    if (futureResupplies.length > 0) {
      await tx
        .delete(resupplyEventsTable)
        .where(
          and(
            eq(resupplyEventsTable.unitId, unitId),
            eq(resupplyEventsTable.itemId, itemId),
            gt(resupplyEventsTable.scheduledFor, new Date()),
          ),
        );
    }

    await tx
      .delete(supplyEntriesTable)
      .where(eq(supplyEntriesTable.id, entry.id));

    if (isUnitScopedCustom) {
      await tx
        .delete(catalogItemsTable)
        .where(eq(catalogItemsTable.id, itemId));
    }

    // Capture the audit / sync row IDs we write below so a restore within the
    // grace window can wipe them — the planner caught the mistake, so leaving
    // a "removed then restored" pair in the audit log would be noise, and the
    // outbox push for a delete that's no longer real shouldn't ship.
    const [activity] = await tx
      .insert(activityTable)
      .values({
        kind: "supply_updated",
        message: `${itemName} removed from ${unit.name} supply list`,
        unitId: unit.id,
        unitName: unit.name,
      })
      .returning({ id: activityTable.id });

    const [outbox] = await tx
      .insert(syncOutboxTable)
      .values({
        entityKind: "supply_entry",
        entityId: entry.id,
        unitId: unit.id,
        op: "delete",
        payload: {
          itemId,
          itemName: item?.name ?? null,
          unitName: unit.name,
        },
      })
      .returning({ id: syncOutboxTable.id });

    const snapshot: UnitSupplyDeletionSnapshot = {
      supplyEntry: {
        id: entry.id,
        unitId: entry.unitId,
        itemId: entry.itemId,
        onHand: entry.onHand,
        requiredOverride: entry.requiredOverride ?? null,
        updatedAt: entry.updatedAt.toISOString(),
      },
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
      catalogItem: isUnitScopedCustom && item
        ? {
            id: item.id,
            supplyClass: item.supplyClass,
            name: item.name,
            nsn: item.nsn,
            unit: item.unit,
            baseDailyRate: item.baseDailyRate,
            criticality: item.criticality,
            notes: item.notes,
            isCustom: item.isCustom,
            scopedUnitId: item.scopedUnitId,
            createdAt: item.createdAt.toISOString(),
            updatedAt: item.updatedAt.toISOString(),
          }
        : null,
      activityIds: activity ? [activity.id] : [],
      outboxIds: outbox ? [outbox.id] : [],
    };

    // Drop any prior snapshot for this (unit, item) — e.g. a stale row from an
    // earlier delete + re-create cycle that the planner never undid — before
    // inserting a fresh one. The unique index would otherwise reject the row.
    await tx
      .delete(unitSupplyDeletionsTable)
      .where(
        and(
          eq(unitSupplyDeletionsTable.unitId, unitId),
          eq(unitSupplyDeletionsTable.itemId, itemId),
        ),
      );
    await tx.insert(unitSupplyDeletionsTable).values({
      unitId,
      itemId,
      snapshot,
      expiresAt,
    });
  });

  res.json({
    unitId,
    removedItemId: itemId,
    removedItemName: itemName,
    hadOnHand: entry.onHand,
    cancelledResupplyEvents: futureResupplies.length,
    removedCatalogItem: isUnitScopedCustom,
    restoreExpiresAt: expiresAt.toISOString(),
  });
});

router.post("/units/:unitId/supply/:itemId/restore", async (req, res) => {
  const { unitId, itemId } = RestoreUnitSupplyParams.parse(req.params);

  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const [deletion] = await db
    .select()
    .from(unitSupplyDeletionsTable)
    .where(
      and(
        eq(unitSupplyDeletionsTable.unitId, unitId),
        eq(unitSupplyDeletionsTable.itemId, itemId),
      ),
    );
  if (!deletion) {
    res
      .status(404)
      .json({ error: "No restore record for this unit's supply entry" });
    return;
  }
  if (deletion.expiresAt.getTime() <= Date.now()) {
    // Clean up the expired snapshot opportunistically so it doesn't linger.
    await db
      .delete(unitSupplyDeletionsTable)
      .where(eq(unitSupplyDeletionsTable.id, deletion.id));
    res.status(410).json({ error: "Restore window has expired" });
    return;
  }

  const snapshot = deletion.snapshot;

  const restored = await db.transaction(async (tx) => {
    // For unit-scoped custom items, the catalog row was deleted alongside the
    // supply entry — re-create it first so the supply entry's FK can resolve.
    if (snapshot.catalogItem) {
      await tx.insert(catalogItemsTable).values({
        id: snapshot.catalogItem.id,
        supplyClass: snapshot.catalogItem.supplyClass,
        name: snapshot.catalogItem.name,
        nsn: snapshot.catalogItem.nsn,
        unit: snapshot.catalogItem.unit,
        baseDailyRate: snapshot.catalogItem.baseDailyRate,
        criticality: snapshot.catalogItem.criticality,
        notes: snapshot.catalogItem.notes,
        isCustom: snapshot.catalogItem.isCustom,
        scopedUnitId: snapshot.catalogItem.scopedUnitId,
        createdAt: new Date(snapshot.catalogItem.createdAt),
        updatedAt: new Date(snapshot.catalogItem.updatedAt),
      });
    }

    // Re-insert the supply entry with its original id so existing references
    // (e.g. sync mappings keyed by entityId) keep pointing at the same row.
    const [entryRow] = await tx
      .insert(supplyEntriesTable)
      .values({
        id: snapshot.supplyEntry.id,
        unitId: snapshot.supplyEntry.unitId,
        itemId: snapshot.supplyEntry.itemId,
        onHand: snapshot.supplyEntry.onHand,
        requiredOverride: snapshot.supplyEntry.requiredOverride ?? null,
        updatedAt: new Date(snapshot.supplyEntry.updatedAt),
      })
      .returning();
    if (!entryRow) throw new Error("Failed to restore supply entry");

    if (snapshot.resupplyEvents.length > 0) {
      await tx.insert(resupplyEventsTable).values(
        snapshot.resupplyEvents.map((r) => ({
          id: r.id,
          unitId: r.unitId,
          supplyClass: r.supplyClass,
          itemId: snapshot.supplyEntry.itemId,
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
    // no trace of the would-be delete in the audit log or pending outbox.
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

    // Single audit entry recording the undo so planners can see in the recent
    // activity feed that the supply entry was restored.
    const itemName = snapshot.catalogItem?.name;
    let resolvedName = itemName;
    if (!resolvedName) {
      const [it] = await tx
        .select({ name: catalogItemsTable.name })
        .from(catalogItemsTable)
        .where(eq(catalogItemsTable.id, snapshot.supplyEntry.itemId));
      resolvedName = it?.name ?? snapshot.supplyEntry.itemId;
    }
    await tx.insert(activityTable).values({
      kind: "supply_updated",
      message: `${resolvedName} restored to ${unit.name} supply list (undo)`,
      unitId: unit.id,
      unitName: unit.name,
    });

    await tx
      .delete(unitSupplyDeletionsTable)
      .where(eq(unitSupplyDeletionsTable.id, deletion.id));

    return entryRow;
  });

  // Build the full enriched SupplyEntry shape the UI expects, mirroring the
  // POST /units/:unitId/supply response.
  const [item] = await db
    .select()
    .from(catalogItemsTable)
    .where(eq(catalogItemsTable.id, restored.itemId));
  if (!item) {
    res
      .status(500)
      .json({ error: "Restored entry references a missing catalog item" });
    return;
  }

  const dailyConsumption = adjustedDailyRate(
    item.baseDailyRate,
    item.supplyClass as SupplyClass,
    unit.climate as Climate,
    unit.opTempo as OpTempo,
    unit.personnel,
  );
  const requirement = deriveRequirement({
    override: restored.requiredOverride,
    onHand: restored.onHand,
    dailyConsumption,
    missionDays: unit.missionDays,
  });

  res.json({
    restoredEntry: buildSupplyEntryResponse({
      entry: restored,
      item,
      dailyConsumption,
      requirement,
    }),
    restoredResupplyEvents: snapshot.resupplyEvents.length,
    restoredCatalogItem: !!snapshot.catalogItem,
  });
});

export default router;
