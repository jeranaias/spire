import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  unitsTable,
  catalogItemsTable,
  supplyEntriesTable,
  resupplyEventsTable,
  activityTable,
} from "@workspace/db";
import { gte, asc, desc, eq, count } from "drizzle-orm";
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

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

async function gatherEnrichedAll() {
  const units = await db.select().from(unitsTable);
  const items = await db.select().from(catalogItemsTable);
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const entries = await db.select().from(supplyEntriesTable);

  const unitMap = new Map<string, typeof units[number]>();
  for (const u of units) unitMap.set(u.id, u);

  const enriched = entries.map((e) => {
    const item = itemsById.get(e.itemId)!;
    const unit = unitMap.get(e.unitId)!;
    if (!item || !unit) return null;
    const daily = adjustedDailyRate(
      item.baseDailyRate,
      item.supplyClass as SupplyClass,
      unit.climate as Climate,
      unit.opTempo as OpTempo,
      unit.personnel,
    );
    const required = daily * unit.missionDays;
    const days = daily > 0 ? e.onHand / daily : 999;
    const shortfall = Math.max(0, required - e.onHand);
    return {
      entry: e,
      item,
      unit,
      daily,
      required,
      days,
      shortfall,
      status: statusFromDays(days),
    };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  return { units, items, enriched };
}

router.get("/dashboard/summary", async (_req, res) => {
  const { units, enriched } = await gatherEnrichedAll();

  // per-unit deficiency + readiness
  let totalReadiness = 0;
  const unitDef = new Map<string, number>();
  for (const u of units) unitDef.set(u.id, 0);

  // Class IX excluded from DOS readiness — consumed per-failure, not per-day
  const dosEnriched = enriched.filter((e) =>
    DOS_CLASSES.includes(e.item.supplyClass as SupplyClass),
  );

  for (const e of dosEnriched) {
    if (e.status !== "green") {
      unitDef.set(e.unit.id, (unitDef.get(e.unit.id) ?? 0) + 1);
    }
  }
  // Compute per-unit readiness
  for (const u of units) {
    const inUnit = dosEnriched.filter((e) => e.unit.id === u.id);
    let r = 100;
    for (const e of inUnit) {
      const w =
        e.item.criticality === "critical"
          ? 25
          : e.item.criticality === "high"
            ? 15
            : e.item.criticality === "medium"
              ? 8
              : 4;
      if (e.status === "red") r -= w;
      else if (e.status === "amber") r -= w * 0.4;
    }
    totalReadiness += Math.max(0, Math.min(100, r));
  }

  let deficiencyCount = 0;
  let critical = 0;
  for (const e of dosEnriched) {
    if (e.status !== "green") {
      deficiencyCount += 1;
      if (
        e.status === "red" &&
        (e.item.criticality === "critical" || e.item.criticality === "high")
      ) {
        critical += 1;
      }
    }
  }

  // class breakdown — DOS classes only (Class IX excluded)
  const classBreakdown = DOS_CLASSES.map((cls) => {
    const inClass = dosEnriched.filter((e) => e.item.supplyClass === cls);
    const green = inClass.filter((e) => e.status === "green").length;
    const amber = inClass.filter((e) => e.status === "amber").length;
    const red = inClass.filter((e) => e.status === "red").length;
    return {
      supplyClass: cls,
      label: CLASS_LABELS[cls],
      green,
      amber,
      red,
    };
  });

  const upcomingResupply = await db
    .select({ value: count() })
    .from(resupplyEventsTable)
    .where(gte(resupplyEventsTable.scheduledFor, new Date()));

  const personnelCount = units.reduce((acc, u) => acc + u.personnel, 0);

  res.json({
    unitCount: units.length,
    personnelCount,
    readinessAvg: round2(units.length > 0 ? totalReadiness / units.length : 100),
    deficiencyCount,
    criticalDeficiencyCount: critical,
    upcomingResupplyCount: upcomingResupply[0]?.value ?? 0,
    classBreakdown,
  });
});

router.get("/dashboard/deficiencies", async (_req, res) => {
  const { enriched } = await gatherEnrichedAll();
  const deficiencies = enriched
    .filter((e) => e.status !== "green" && DOS_CLASSES.includes(e.item.supplyClass as SupplyClass))
    .sort((a, b) => a.days - b.days)
    .map((e) => ({
      id: e.entry.id,
      unitId: e.unit.id,
      unitName: e.unit.name,
      supplyClass: e.item.supplyClass,
      itemName: e.item.name,
      daysOfSupply: round2(e.days),
      shortfall: round2(e.shortfall),
      unit: e.item.unit,
      severity: e.status === "red" ? "red" : "amber",
      flaggedAt: e.entry.updatedAt.toISOString(),
    }));
  res.json(deficiencies);
});

router.get("/dashboard/forecast", async (_req, res) => {
  const { enriched } = await gatherEnrichedAll();
  const now = Date.now();
  const forecast = enriched
    .filter((e) => e.daily > 0 && e.days < 14 && DOS_CLASSES.includes(e.item.supplyClass as SupplyClass))
    .sort((a, b) => a.days - b.days)
    .slice(0, 25)
    .map((e) => ({
      unitId: e.unit.id,
      unitName: e.unit.name,
      supplyClass: e.item.supplyClass,
      itemName: e.item.name,
      projectedStockoutDate: new Date(
        now + e.days * 24 * 60 * 60 * 1000,
      ).toISOString(),
      daysUntilStockout: round2(e.days),
      recommendedQuantity: round2(
        Math.max(e.required - e.entry.onHand, e.daily * 7),
      ),
      unit: e.item.unit,
    }));
  res.json(forecast);
});

router.get("/dashboard/activity", async (_req, res) => {
  const rows = await db
    .select()
    .from(activityTable)
    .orderBy(desc(activityTable.timestamp))
    .limit(30);
  res.json(
    rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      message: r.message,
      unitId: r.unitId,
      unitName: r.unitName,
      timestamp: r.timestamp.toISOString(),
    })),
  );
});

export default router;
