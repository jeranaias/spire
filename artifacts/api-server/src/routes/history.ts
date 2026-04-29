import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  supplySnapshotsTable,
  supplyBaselinesTable,
  prePlannedSchedulesTable,
  resupplyEventsTable,
  unitsTable,
  catalogItemsTable,
  activityTable,
  syncOutboxTable,
} from "@workspace/db";
import { eq, and, desc, asc, gte, lte, inArray, notInArray } from "drizzle-orm";
import {
  adjustedDailyRate,
  DOS_CLASSES,
  type Climate,
  type OpTempo,
  type SupplyClass,
} from "../lib/logistics";
import { computeUnitMetrics, round2 } from "./units";
import { z } from "zod";
import { randomUUID } from "crypto";

const router: IRouter = Router();

const UnitIdParam = z.object({ unitId: z.string().uuid() });
const BaselineIdParam = z.object({ baselineId: z.string().uuid() });
const ScheduleIdParam = z.object({ scheduleId: z.string().uuid() });

router.get("/units/:unitId/supply/history", async (req, res) => {
  const { unitId } = UnitIdParam.parse(req.params);
  const { itemId, days } = z
    .object({ itemId: z.string().uuid().optional(), days: z.coerce.number().default(30) })
    .parse(req.query);

  const [unit] = await db.select().from(unitsTable).where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const q = db
    .select({
      snap: supplySnapshotsTable,
      item: catalogItemsTable,
    })
    .from(supplySnapshotsTable)
    .innerJoin(catalogItemsTable, eq(supplySnapshotsTable.itemId, catalogItemsTable.id))
    .where(
      and(
        eq(supplySnapshotsTable.unitId, unitId),
        gte(supplySnapshotsTable.snapshotAt, since),
        ...(itemId ? [eq(supplySnapshotsTable.itemId, itemId)] : []),
      ),
    )
    .orderBy(asc(supplySnapshotsTable.snapshotAt));

  const rows = await q;

  const grouped: Record<string, {
    itemId: string;
    itemName: string;
    supplyClass: string;
    unit: string;
    baseDailyRate: number;
    criticality: string;
    series: { snapshotAt: string; onHand: number; source: string; actorNote: string | null }[];
    observedBurnRate: number | null;
    doctrinaRate: number;
    burnRateDelta: number | null;
    lastConfirmedAt: string | null;
  }> = {};

  for (const { snap, item } of rows) {
    if (!grouped[item.id]) {
      grouped[item.id] = {
        itemId: item.id,
        itemName: item.name,
        supplyClass: item.supplyClass,
        unit: item.unit,
        baseDailyRate: item.baseDailyRate,
        criticality: item.criticality,
        series: [],
        observedBurnRate: null,
        doctrinaRate: 0,
        burnRateDelta: null,
        lastConfirmedAt: null,
      };
    }
    grouped[item.id]!.series.push({
      snapshotAt: snap.snapshotAt.toISOString(),
      onHand: snap.onHand,
      source: snap.source,
      actorNote: snap.actorNote,
    });
  }

  for (const entry of Object.values(grouped)) {
    const doctrinaRate = adjustedDailyRate(
      entry.baseDailyRate,
      entry.supplyClass as SupplyClass,
      unit.climate as Climate,
      unit.opTempo as OpTempo,
      unit.personnel,
    );
    entry.doctrinaRate = round2(doctrinaRate);

    const series = entry.series;
    if (series.length >= 2) {
      const observed = computeObservedBurn(series);
      entry.observedBurnRate = round2(observed);
      entry.burnRateDelta = round2(observed - doctrinaRate);
    }
    entry.lastConfirmedAt = series[series.length - 1]?.snapshotAt ?? null;
  }

  res.json(Object.values(grouped));
});

function computeObservedBurn(
  series: { snapshotAt: string; onHand: number; source: string }[],
): number {
  if (series.length < 2) return 0;

  let totalConsumption = 0;
  let totalDays = 0;

  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!;
    const curr = series[i]!;
    const daysDiff =
      (new Date(curr.snapshotAt).getTime() - new Date(prev.snapshotAt).getTime()) /
      (1000 * 60 * 60 * 24);
    if (daysDiff <= 0) continue;

    const delta = prev.onHand - curr.onHand;
    if (curr.source === "resupply_event" || delta < 0) {
      continue;
    }

    totalConsumption += delta;
    totalDays += daysDiff;
  }

  if (totalDays <= 0) return 0;
  return totalConsumption / totalDays;
}

router.get("/units/:unitId/baselines", async (req, res) => {
  const { unitId } = UnitIdParam.parse(req.params);

  const [unit] = await db.select().from(unitsTable).where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const baselines = await db
    .select()
    .from(supplyBaselinesTable)
    .where(eq(supplyBaselinesTable.unitId, unitId))
    .orderBy(desc(supplyBaselinesTable.frozenAt));

  res.json(
    baselines.map((b) => ({
      id: b.id,
      label: b.label,
      notes: b.notes,
      unitId: b.unitId,
      frozenAt: b.frozenAt.toISOString(),
      createdAt: b.createdAt.toISOString(),
      snapshotData: b.snapshotData,
    })),
  );
});

router.post("/units/:unitId/baselines", async (req, res) => {
  const { unitId } = UnitIdParam.parse(req.params);
  const body = z
    .object({ label: z.string().min(1), notes: z.string().optional() })
    .parse(req.body);

  const m = await computeUnitMetrics(unitId);
  if (!m) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const snapshotData = {
    unitId: m.unit.id,
    unitName: m.unit.name,
    personnel: m.unit.personnel,
    climate: m.unit.climate,
    opTempo: m.unit.opTempo,
    missionDays: m.unit.missionDays,
    items: m.enriched.map((e) => ({
      itemId: e.itemId,
      itemName: e.item.name,
      supplyClass: e.item.supplyClass,
      unit: e.item.unit,
      onHand: e.onHand,
      dailyConsumption: e.dailyConsumption,
      daysOfSupply: e.daysOfSupply,
      status: e.status,
    })),
  };

  const [baseline] = await db
    .insert(supplyBaselinesTable)
    .values({
      label: body.label,
      notes: body.notes ?? null,
      unitId,
      snapshotData,
    })
    .returning();

  if (!baseline) {
    res.status(500).json({ error: "Failed to create baseline" });
    return;
  }

  await db.insert(activityTable).values({
    kind: "supply_updated",
    message: `Baseline "${body.label}" saved for ${m.unit.name}`,
    unitId,
    unitName: m.unit.name,
  });

  await db.insert(syncOutboxTable).values({
    entityKind: "supply_baseline",
    entityId: baseline.id,
    unitId,
    op: "create",
    payload: { label: body.label, unitName: m.unit.name },
  });

  res.status(201).json({
    id: baseline.id,
    label: baseline.label,
    notes: baseline.notes,
    unitId: baseline.unitId,
    frozenAt: baseline.frozenAt.toISOString(),
    createdAt: baseline.createdAt.toISOString(),
    snapshotData: baseline.snapshotData,
  });
});

router.get("/baselines/:baselineId", async (req, res) => {
  const { baselineId } = BaselineIdParam.parse(req.params);

  const [baseline] = await db
    .select()
    .from(supplyBaselinesTable)
    .where(eq(supplyBaselinesTable.id, baselineId));

  if (!baseline) {
    res.status(404).json({ error: "Baseline not found" });
    return;
  }

  res.json({
    id: baseline.id,
    label: baseline.label,
    notes: baseline.notes,
    unitId: baseline.unitId,
    frozenAt: baseline.frozenAt.toISOString(),
    createdAt: baseline.createdAt.toISOString(),
    snapshotData: baseline.snapshotData,
  });
});

router.post("/units/:unitId/comms-denied/forecast", async (req, res) => {
  const { unitId } = UnitIdParam.parse(req.params);
  const body = z
    .object({
      baselineId: z.string().uuid().optional(),
      horizonDays: z.coerce.number().min(1).max(365).default(14),
      burnModel: z.enum(["doctrinal", "observed", "worst-of-both"]).default("worst-of-both"),
      safetyMarginDays: z.coerce.number().min(0).max(30).default(2),
      resupplyLeadDays: z.coerce.number().min(0).max(30).default(2),
    })
    .parse(req.body);

  let startData: {
    unitId: string;
    unitName: string;
    personnel: number;
    climate: string;
    opTempo: string;
    missionDays: number;
    items: Array<{
      itemId: string;
      itemName: string;
      supplyClass: string;
      unit: string;
      onHand: number;
      dailyConsumption: number;
      daysOfSupply: number;
      status: string;
    }>;
  };

  if (body.baselineId) {
    const [baseline] = await db
      .select()
      .from(supplyBaselinesTable)
      .where(eq(supplyBaselinesTable.id, body.baselineId));
    if (!baseline) {
      res.status(404).json({ error: "Baseline not found" });
      return;
    }
    startData = baseline.snapshotData as typeof startData;
  } else {
    const m = await computeUnitMetrics(unitId);
    if (!m) {
      res.status(404).json({ error: "Unit not found" });
      return;
    }
    startData = {
      unitId: m.unit.id,
      unitName: m.unit.name,
      personnel: m.unit.personnel,
      climate: m.unit.climate,
      opTempo: m.unit.opTempo,
      missionDays: m.unit.missionDays,
      items: m.enriched.map((e) => ({
        itemId: e.itemId,
        itemName: e.item.name,
        supplyClass: e.item.supplyClass,
        unit: e.item.unit,
        onHand: e.onHand,
        dailyConsumption: e.dailyConsumption,
        daysOfSupply: e.daysOfSupply,
        status: e.status,
      })),
    };
  }

  const historyWindow = 30;
  const since = new Date(Date.now() - historyWindow * 24 * 60 * 60 * 1000);
  const snapshots = await db
    .select({
      snap: supplySnapshotsTable,
      item: catalogItemsTable,
    })
    .from(supplySnapshotsTable)
    .innerJoin(catalogItemsTable, eq(supplySnapshotsTable.itemId, catalogItemsTable.id))
    .where(
      and(
        eq(supplySnapshotsTable.unitId, unitId),
        gte(supplySnapshotsTable.snapshotAt, since),
      ),
    )
    .orderBy(asc(supplySnapshotsTable.snapshotAt));

  const observedByItem: Record<string, number> = {};
  const snapshotsByItem: Record<string, { snapshotAt: string; onHand: number; source: string }[]> =
    {};
  for (const { snap, item } of snapshots) {
    if (!snapshotsByItem[item.id]) snapshotsByItem[item.id] = [];
    snapshotsByItem[item.id]!.push({
      snapshotAt: snap.snapshotAt.toISOString(),
      onHand: snap.onHand,
      source: snap.source,
    });
  }
  for (const [itemId, series] of Object.entries(snapshotsByItem)) {
    observedByItem[itemId] = computeObservedBurn(series);
  }

  const planningDate = new Date();
  const forecastLines = startData.items
    .filter((item) => DOS_CLASSES.includes(item.supplyClass as SupplyClass))
    .map((item) => {
      const doctrinalRate = item.dailyConsumption;
      const observedRate = observedByItem[item.itemId] ?? null;

      let effectiveRate: number;
      if (body.burnModel === "doctrinal") {
        effectiveRate = doctrinalRate;
      } else if (body.burnModel === "observed" && observedRate !== null) {
        effectiveRate = observedRate;
      } else {
        effectiveRate = Math.max(doctrinalRate, observedRate ?? doctrinalRate);
      }

      const projectedDaysUntilStockout =
        effectiveRate > 0 ? item.onHand / effectiveRate : 999;

      const stockoutDate =
        projectedDaysUntilStockout >= 999
          ? null
          : new Date(planningDate.getTime() + projectedDaysUntilStockout * 86400000).toISOString();

      const needsResupply = projectedDaysUntilStockout < body.horizonDays + body.safetyMarginDays;

      const recommendedQty = needsResupply
        ? round2(effectiveRate * body.horizonDays - item.onHand + effectiveRate * body.safetyMarginDays)
        : 0;

      const deliveryDate = new Date(
        planningDate.getTime() +
          Math.max(0, projectedDaysUntilStockout - body.resupplyLeadDays - body.safetyMarginDays) *
            86400000,
      ).toISOString();

      return {
        itemId: item.itemId,
        itemName: item.itemName,
        supplyClass: item.supplyClass,
        unit: item.unit,
        startingOnHand: item.onHand,
        doctrinalDailyRate: round2(doctrinalRate),
        observedDailyRate: observedRate !== null ? round2(observedRate) : null,
        effectiveDailyRate: round2(effectiveRate),
        projectedDaysUntilStockout: round2(Math.min(projectedDaysUntilStockout, 999)),
        projectedStockoutDate: stockoutDate,
        needsResupply,
        recommendedQuantity: Math.max(0, recommendedQty),
        recommendedDeliveryDate: needsResupply ? deliveryDate : null,
      };
    });

  res.json({
    unitId: startData.unitId,
    unitName: startData.unitName,
    baselineId: body.baselineId ?? null,
    baselineLabel: null,
    planningDate: planningDate.toISOString(),
    horizonDays: body.horizonDays,
    burnModel: body.burnModel,
    safetyMarginDays: body.safetyMarginDays,
    resupplyLeadDays: body.resupplyLeadDays,
    lines: forecastLines,
  });
});

router.post("/units/:unitId/comms-denied/publish", async (req, res) => {
  const { unitId } = UnitIdParam.parse(req.params);
  const body = z
    .object({
      label: z.string().min(1),
      baselineId: z.string().uuid().optional(),
      horizonDays: z.coerce.number().min(1).max(365).default(14),
      burnModel: z.enum(["doctrinal", "observed", "worst-of-both"]).default("worst-of-both"),
      safetyMarginDays: z.coerce.number().min(0).max(30).default(2),
      resupplyLeadDays: z.coerce.number().min(0).max(30).default(2),
      lines: z.array(
        z.object({
          itemId: z.string().uuid(),
          itemName: z.string(),
          supplyClass: z.string(),
          unit: z.string(),
          recommendedQuantity: z.number(),
          recommendedDeliveryDate: z.string().nullable(),
        }),
      ),
    })
    .parse(req.body);

  const [unit] = await db.select().from(unitsTable).where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const shareToken = randomUUID();

  const [schedule] = await db
    .insert(prePlannedSchedulesTable)
    .values({
      unitId,
      baselineId: body.baselineId ?? null,
      label: body.label,
      horizonDays: String(body.horizonDays),
      burnModel: body.burnModel,
      safetyMarginDays: String(body.safetyMarginDays),
      resupplyLeadDays: String(body.resupplyLeadDays),
      publishedAt: new Date(),
      shareToken,
    })
    .returning();

  if (!schedule) {
    res.status(500).json({ error: "Failed to create schedule" });
    return;
  }

  const resupplyEvents = [];
  for (const line of body.lines) {
    if (!line.recommendedDeliveryDate || line.recommendedQuantity <= 0) continue;
    const [ev] = await db
      .insert(resupplyEventsTable)
      .values({
        unitId,
        supplyClass: line.supplyClass,
        itemId: line.itemId,
        quantity: line.recommendedQuantity,
        unit: line.unit,
        scheduledFor: new Date(line.recommendedDeliveryDate),
        status: "planned",
        notes: `Pre-coordinated: ${body.label}`,
        baselineId: body.baselineId ?? null,
        scheduleId: schedule.id,
      })
      .returning();
    if (ev) {
      resupplyEvents.push(ev);

      await db.insert(syncOutboxTable).values({
        entityKind: "resupply_event",
        entityId: ev.id,
        unitId,
        op: "create",
        payload: {
          itemName: line.itemName,
          unitName: unit.name,
          scheduleId: schedule.id,
          scheduleLabel: body.label,
          quantity: line.recommendedQuantity,
        },
      });
    }
  }

  await db.insert(activityTable).values({
    kind: "resupply_planned",
    message: `Pre-coordinated schedule "${body.label}" published for ${unit.name} — ${resupplyEvents.length} push(es) planned`,
    unitId,
    unitName: unit.name,
  });

  res.status(201).json({
    id: schedule.id,
    label: schedule.label,
    unitId: schedule.unitId,
    baselineId: schedule.baselineId,
    horizonDays: Number(schedule.horizonDays),
    burnModel: schedule.burnModel,
    safetyMarginDays: Number(schedule.safetyMarginDays),
    resupplyLeadDays: Number(schedule.resupplyLeadDays),
    publishedAt: schedule.publishedAt?.toISOString() ?? null,
    shareToken: schedule.shareToken,
    eventsCreated: resupplyEvents.length,
  });
});

router.get("/units/:unitId/schedules", async (req, res) => {
  const { unitId } = UnitIdParam.parse(req.params);

  const [unit] = await db.select().from(unitsTable).where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const schedules = await db
    .select()
    .from(prePlannedSchedulesTable)
    .where(eq(prePlannedSchedulesTable.unitId, unitId))
    .orderBy(desc(prePlannedSchedulesTable.createdAt));

  res.json(
    schedules.map((s) => ({
      id: s.id,
      label: s.label,
      unitId: s.unitId,
      baselineId: s.baselineId,
      horizonDays: Number(s.horizonDays),
      burnModel: s.burnModel,
      safetyMarginDays: Number(s.safetyMarginDays),
      resupplyLeadDays: Number(s.resupplyLeadDays),
      publishedAt: s.publishedAt?.toISOString() ?? null,
      shareToken: s.shareToken,
      createdAt: s.createdAt.toISOString(),
    })),
  );
});

router.get("/dashboard/opsec-pushes", async (_req, res) => {
  const schedules = await db
    .select({
      schedule: prePlannedSchedulesTable,
      unit: unitsTable,
    })
    .from(prePlannedSchedulesTable)
    .innerJoin(unitsTable, eq(prePlannedSchedulesTable.unitId, unitsTable.id))
    .where(
      and(
        ...[],
      ),
    )
    .orderBy(desc(prePlannedSchedulesTable.publishedAt));

  const scheduleIds = schedules.map((s) => s.schedule.id);

  const upcomingEvents =
    scheduleIds.length > 0
      ? await db
          .select()
          .from(resupplyEventsTable)
          .where(
            and(
              inArray(resupplyEventsTable.scheduleId, scheduleIds),
              gte(resupplyEventsTable.scheduledFor, new Date()),
              notInArray(resupplyEventsTable.status, ["delivered", "cancelled"]),
            ),
          )
          .orderBy(asc(resupplyEventsTable.scheduledFor))
      : [];

  const eventsBySchedule: Record<string, typeof upcomingEvents> = {};
  for (const ev of upcomingEvents) {
    const sid = ev.scheduleId!;
    if (!eventsBySchedule[sid]) eventsBySchedule[sid] = [];
    eventsBySchedule[sid]!.push(ev);
  }

  const result = schedules
    .map(({ schedule, unit }) => {
      const events = eventsBySchedule[schedule.id] ?? [];
      const nextPush = events[0]?.scheduledFor?.toISOString() ?? null;
      return {
        scheduleId: schedule.id,
        scheduleLabel: schedule.label,
        unitId: unit.id,
        unitName: unit.name,
        publishedAt: schedule.publishedAt?.toISOString() ?? null,
        horizonDays: Number(schedule.horizonDays),
        nextPushDate: nextPush,
        totalPushes: events.length,
        shareToken: schedule.shareToken,
      };
    })
    .filter((tile) => tile.totalPushes > 0);

  res.json(result);
});

async function buildScheduleDetail(scheduleRow: {
  schedule: typeof prePlannedSchedulesTable.$inferSelect;
  unit: typeof unitsTable.$inferSelect;
}) {
  const events = await db
    .select({ ev: resupplyEventsTable, item: catalogItemsTable })
    .from(resupplyEventsTable)
    .leftJoin(catalogItemsTable, eq(resupplyEventsTable.itemId, catalogItemsTable.id))
    .where(eq(resupplyEventsTable.scheduleId, scheduleRow.schedule.id))
    .orderBy(asc(resupplyEventsTable.scheduledFor));

  return {
    id: scheduleRow.schedule.id,
    label: scheduleRow.schedule.label,
    unitId: scheduleRow.unit.id,
    unitName: scheduleRow.unit.name,
    unitEchelon: scheduleRow.unit.echelon ?? null,
    unitLocation: scheduleRow.unit.location ?? null,
    unitClimate: scheduleRow.unit.climate ?? null,
    unitOpTempo: scheduleRow.unit.opTempo ?? null,
    unitAmmoPosture: scheduleRow.unit.ammoPosture ?? null,
    unitDistroEmails: scheduleRow.unit.distroEmails ?? [],
    unitDistroCcEmails: scheduleRow.unit.distroCcEmails ?? [],
    unitDistroBccEmails: scheduleRow.unit.distroBccEmails ?? [],
    baselineId: scheduleRow.schedule.baselineId,
    horizonDays: Number(scheduleRow.schedule.horizonDays),
    burnModel: scheduleRow.schedule.burnModel,
    safetyMarginDays: Number(scheduleRow.schedule.safetyMarginDays),
    resupplyLeadDays: Number(scheduleRow.schedule.resupplyLeadDays),
    publishedAt: scheduleRow.schedule.publishedAt?.toISOString() ?? null,
    shareToken: scheduleRow.schedule.shareToken,
    createdAt: scheduleRow.schedule.createdAt.toISOString(),
    events: events.map(({ ev, item }) => ({
      id: ev.id,
      supplyClass: ev.supplyClass,
      itemId: ev.itemId,
      itemName: item?.name ?? null,
      quantity: ev.quantity,
      unit: ev.unit,
      scheduledFor: ev.scheduledFor.toISOString(),
      status: ev.status,
      assignedTo: ev.assignedTo,
      notes: ev.notes,
    })),
  };
}

router.post("/schedules/:scheduleId/share/revoke", async (req, res) => {
  const { scheduleId } = ScheduleIdParam.parse(req.params);

  const [existing] = await db
    .select({ schedule: prePlannedSchedulesTable, unit: unitsTable })
    .from(prePlannedSchedulesTable)
    .innerJoin(unitsTable, eq(prePlannedSchedulesTable.unitId, unitsTable.id))
    .where(eq(prePlannedSchedulesTable.id, scheduleId));

  if (!existing) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }

  await db
    .update(prePlannedSchedulesTable)
    .set({ shareToken: null })
    .where(eq(prePlannedSchedulesTable.id, scheduleId));

  await db.insert(activityTable).values({
    kind: "resupply_planned",
    message: `Share link revoked for schedule "${existing.schedule.label}" (${existing.unit.name})`,
    unitId: existing.unit.id,
    unitName: existing.unit.name,
  });

  res.json({
    scheduleId,
    shareToken: null,
    revoked: true,
  });
});

router.post("/schedules/:scheduleId/share/rotate", async (req, res) => {
  const { scheduleId } = ScheduleIdParam.parse(req.params);

  const [existing] = await db
    .select({ schedule: prePlannedSchedulesTable, unit: unitsTable })
    .from(prePlannedSchedulesTable)
    .innerJoin(unitsTable, eq(prePlannedSchedulesTable.unitId, unitsTable.id))
    .where(eq(prePlannedSchedulesTable.id, scheduleId));

  if (!existing) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }

  const newToken = randomUUID();

  await db
    .update(prePlannedSchedulesTable)
    .set({ shareToken: newToken })
    .where(eq(prePlannedSchedulesTable.id, scheduleId));

  await db.insert(activityTable).values({
    kind: "resupply_planned",
    message: `New share link issued for schedule "${existing.schedule.label}" (${existing.unit.name})`,
    unitId: existing.unit.id,
    unitName: existing.unit.name,
  });

  res.json({
    scheduleId,
    shareToken: newToken,
  });
});

router.get("/schedules/share/:shareToken", async (req, res) => {
  const { shareToken } = z
    .object({ shareToken: z.string().min(1) })
    .parse(req.params);

  const [schedule] = await db
    .select({ schedule: prePlannedSchedulesTable, unit: unitsTable })
    .from(prePlannedSchedulesTable)
    .innerJoin(unitsTable, eq(prePlannedSchedulesTable.unitId, unitsTable.id))
    .where(eq(prePlannedSchedulesTable.shareToken, shareToken));

  if (!schedule) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }

  res.json(await buildScheduleDetail(schedule));
});

router.get("/schedules/:scheduleId", async (req, res) => {
  const { scheduleId } = ScheduleIdParam.parse(req.params);

  const [schedule] = await db
    .select({ schedule: prePlannedSchedulesTable, unit: unitsTable })
    .from(prePlannedSchedulesTable)
    .innerJoin(unitsTable, eq(prePlannedSchedulesTable.unitId, unitsTable.id))
    .where(eq(prePlannedSchedulesTable.id, scheduleId));

  if (!schedule) {
    res.status(404).json({ error: "Schedule not found" });
    return;
  }

  res.json(await buildScheduleDetail(schedule));
});

export { router as historyRouter };
export default router;
