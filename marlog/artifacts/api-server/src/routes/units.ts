import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  unitsTable,
  catalogItemsTable,
  supplyEntriesTable,
  resupplyEventsTable,
  activityTable,
} from "@workspace/db";
import {
  CreateUnitBody,
  GetUnitParams,
  UpdateUnitParams,
  UpdateUnitBody,
  DeleteUnitParams,
} from "@workspace/api-zod";
import { eq, desc, asc, and, gte } from "drizzle-orm";
import {
  adjustedDailyRate,
  statusFromDays,
  CLASS_LABELS,
  CLASS_ORDER,
  DOS_CLASSES,
  type Climate,
  type OpTempo,
  type SupplyClass,
} from "../lib/logistics";

const router: IRouter = Router();

function serializeUnitBase(
  u: typeof unitsTable.$inferSelect,
  readiness: number,
  deficiencyCount: number,
) {
  return {
    id: u.id,
    name: u.name,
    callsign: u.callsign,
    echelon: u.echelon,
    personnel: u.personnel,
    commander: u.commander,
    location: u.location,
    climate: u.climate,
    opTempo: u.opTempo,
    missionDays: u.missionDays,
    readiness,
    deficiencyCount,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

async function computeUnitMetrics(unitId: string) {
  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!unit) return null;

  const entries = await db
    .select({
      entry: supplyEntriesTable,
      item: catalogItemsTable,
    })
    .from(supplyEntriesTable)
    .innerJoin(
      catalogItemsTable,
      eq(supplyEntriesTable.itemId, catalogItemsTable.id),
    )
    .where(eq(supplyEntriesTable.unitId, unitId))
    .orderBy(asc(catalogItemsTable.supplyClass), asc(catalogItemsTable.name), asc(catalogItemsTable.id));

  const climate = unit.climate as Climate;
  const opTempo = unit.opTempo as OpTempo;
  const personnel = unit.personnel;
  const days = unit.missionDays;

  const enriched = entries.map(({ entry, item }) => {
    const dailyConsumption = adjustedDailyRate(
      item.baseDailyRate,
      item.supplyClass as SupplyClass,
      climate,
      opTempo,
      personnel,
    );
    const required = dailyConsumption * days;
    const onHand = entry.onHand;
    const daysOfSupply = dailyConsumption > 0 ? onHand / dailyConsumption : 999;
    const shortfall = Math.max(0, required - onHand);
    const status = statusFromDays(daysOfSupply);
    return {
      id: entry.id,
      unitId: entry.unitId,
      itemId: entry.itemId,
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
      onHand,
      dailyConsumption: round2(dailyConsumption),
      daysOfSupply: round2(daysOfSupply),
      required: round2(required),
      shortfall: round2(shortfall),
      status,
      updatedAt: entry.updatedAt.toISOString(),
    };
  });

  // Readiness: weight by criticality. red entries hurt most.
  // Class IX (repair parts) is excluded — it's consumed per-failure, not per-day.
  let readinessScore = 100;
  let deficiencyCount = 0;
  for (const e of enriched) {
    if (!DOS_CLASSES.includes(e.item.supplyClass as SupplyClass)) continue;
    const weight =
      e.item.criticality === "critical"
        ? 25
        : e.item.criticality === "high"
          ? 15
          : e.item.criticality === "medium"
            ? 8
            : 4;
    if (e.status === "red") {
      readinessScore -= weight;
      deficiencyCount += 1;
    } else if (e.status === "amber") {
      readinessScore -= weight * 0.4;
      deficiencyCount += 1;
    }
  }
  const readiness = Math.max(0, Math.min(100, Math.round(readinessScore)));

  return { unit, enriched, readiness, deficiencyCount };
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

router.get("/units", async (_req, res) => {
  const units = await db
    .select()
    .from(unitsTable)
    .orderBy(asc(unitsTable.name));

  const out = await Promise.all(
    units.map(async (u) => {
      const m = await computeUnitMetrics(u.id);
      return serializeUnitBase(u, m?.readiness ?? 100, m?.deficiencyCount ?? 0);
    }),
  );
  res.json(out);
});

router.post("/units", async (req, res) => {
  const body = CreateUnitBody.parse(req.body);
  const [u] = await db
    .insert(unitsTable)
    .values({
      name: body.name,
      callsign: body.callsign ?? null,
      echelon: body.echelon,
      personnel: body.personnel,
      commander: body.commander ?? null,
      location: body.location ?? null,
      climate: body.climate,
      opTempo: body.opTempo,
      missionDays: body.missionDays,
    })
    .returning();
  if (!u) {
    res.status(500).json({ error: "Failed to create unit" });
    return;
  }

  await db.insert(activityTable).values({
    kind: "unit_created",
    message: `${u.name} (${u.echelon}) created with ${u.personnel} Marines`,
    unitId: u.id,
    unitName: u.name,
  });

  res.status(201).json(serializeUnitBase(u, 100, 0));
});

router.get("/units/:unitId", async (req, res) => {
  const { unitId } = GetUnitParams.parse(req.params);
  const m = await computeUnitMetrics(unitId);
  if (!m) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const supplyByClass = DOS_CLASSES.map((cls) => {
    const inClass = m.enriched.filter((e) => e.item.supplyClass === cls);
    if (inClass.length === 0) {
      return {
        supplyClass: cls,
        label: CLASS_LABELS[cls],
        itemCount: 0,
        worstDaysOfSupply: 999,
        status: "green" as const,
      };
    }
    const worst = inClass.reduce(
      (acc, e) => Math.min(acc, e.daysOfSupply),
      Infinity,
    );
    return {
      supplyClass: cls,
      label: CLASS_LABELS[cls],
      itemCount: inClass.length,
      worstDaysOfSupply: round2(worst === Infinity ? 999 : worst),
      status: statusFromDays(worst),
    };
  });

  const upcomingResupply = await db
    .select({
      ev: resupplyEventsTable,
      item: catalogItemsTable,
    })
    .from(resupplyEventsTable)
    .leftJoin(
      catalogItemsTable,
      eq(resupplyEventsTable.itemId, catalogItemsTable.id),
    )
    .where(
      and(
        eq(resupplyEventsTable.unitId, unitId),
        gte(resupplyEventsTable.scheduledFor, new Date()),
      ),
    )
    .orderBy(asc(resupplyEventsTable.scheduledFor));

  res.json({
    unit: serializeUnitBase(m.unit, m.readiness, m.deficiencyCount),
    supplyByClass,
    entries: m.enriched,
    upcomingResupply: upcomingResupply.map(({ ev, item }) => ({
      id: ev.id,
      unitId: ev.unitId,
      unitName: m.unit.name,
      supplyClass: ev.supplyClass,
      itemId: ev.itemId,
      itemName: item?.name ?? null,
      quantity: ev.quantity,
      unit: ev.unit,
      scheduledFor: ev.scheduledFor.toISOString(),
      status: ev.status,
      assignedTo: ev.assignedTo,
      notes: ev.notes,
      createdAt: ev.createdAt.toISOString(),
    })),
  });
});

router.patch("/units/:unitId", async (req, res) => {
  const { unitId } = UpdateUnitParams.parse(req.params);
  const body = UpdateUnitBody.parse(req.body);
  const [u] = await db
    .update(unitsTable)
    .set({
      name: body.name,
      callsign: body.callsign ?? null,
      echelon: body.echelon,
      personnel: body.personnel,
      commander: body.commander ?? null,
      location: body.location ?? null,
      climate: body.climate,
      opTempo: body.opTempo,
      missionDays: body.missionDays,
      updatedAt: new Date(),
    })
    .where(eq(unitsTable.id, unitId))
    .returning();
  if (!u) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }
  const m = await computeUnitMetrics(unitId);
  res.json(serializeUnitBase(u, m?.readiness ?? 100, m?.deficiencyCount ?? 0));
});

router.delete("/units/:unitId", async (req, res) => {
  const { unitId } = DeleteUnitParams.parse(req.params);
  await db.delete(unitsTable).where(eq(unitsTable.id, unitId));
  res.status(204).send();
});

export { router as unitsRouter, computeUnitMetrics, round2 };
export default router;
