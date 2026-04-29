import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  unitsTable,
  catalogItemsTable,
  supplyEntriesTable,
  resupplyEventsTable,
  activityTable,
  weaponDodicRatesTable,
  unitWeaponsTable,
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
import { runDistroAudit } from "../lib/distro-audit";
import {
  buildDigest,
  runCommsHygieneOnce,
  getLatestCommsHygieneRun,
  getLatestSuccessfulCommsHygieneSend,
  listCommsHygieneRuns,
  getCommsHygieneStats,
  getCommsHygieneSettings,
  setCommsHygieneRetentionOverride,
} from "../lib/comms-hygiene";
import { UpdateCommsHygieneSettingsBody } from "@workspace/api-zod";

const router: IRouter = Router();

type AmmoPosture = "combat_load" | "assault" | "sustain";

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

type RateByItem = Map<string, { assault: number; sustain: number; combatLoad: number }>;

async function buildAllWeaponRates(): Promise<{
  byUnit: Map<string, RateByItem>;
  byUnitNg: Map<string, RateByItem>;
}> {
  const rows = await db
    .select({ rate: weaponDodicRatesTable, uw: unitWeaponsTable })
    .from(weaponDodicRatesTable)
    .innerJoin(
      unitWeaponsTable,
      eq(weaponDodicRatesTable.weaponSystemId, unitWeaponsTable.weaponSystemId),
    );

  const byUnit = new Map<string, RateByItem>();
  const byUnitNg = new Map<string, RateByItem>();

  for (const { rate: r, uw } of rows) {
    const unitId = uw.unitId;

    // GCE map
    if (!byUnit.has(unitId)) byUnit.set(unitId, new Map());
    const gceMap = byUnit.get(unitId)!;
    const gceEntry = gceMap.get(r.catalogItemId) ?? { assault: 0, sustain: 0, combatLoad: 0 };
    gceEntry.assault    += uw.quantity * r.gceAssaultRate;
    gceEntry.sustain    += uw.quantity * r.gceSustainRate;
    gceEntry.combatLoad += uw.quantity * r.gceCombatLoad;
    gceMap.set(r.catalogItemId, gceEntry);

    // Non-GCE map
    if (!byUnitNg.has(unitId)) byUnitNg.set(unitId, new Map());
    const ngMap = byUnitNg.get(unitId)!;
    const ngEntry = ngMap.get(r.catalogItemId) ?? { assault: 0, sustain: 0, combatLoad: 0 };
    ngEntry.assault    += uw.quantity * r.nonGceAssaultRate;
    ngEntry.sustain    += uw.quantity * r.nonGceSustainRate;
    ngEntry.combatLoad += uw.quantity * r.nonGceCombatLoad;
    ngMap.set(r.catalogItemId, ngEntry);
  }

  return { byUnit, byUnitNg };
}

async function gatherEnrichedAll() {
  const units = await db.select().from(unitsTable);
  const items = await db.select().from(catalogItemsTable);
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const entries = await db.select().from(supplyEntriesTable);
  const { byUnit, byUnitNg } = await buildAllWeaponRates();

  const unitMap = new Map<string, typeof units[number]>();
  for (const u of units) unitMap.set(u.id, u);

  const enriched = entries.map((e) => {
    const item = itemsById.get(e.itemId)!;
    const unit = unitMap.get(e.unitId)!;
    if (!item || !unit) return null;

    let daily: number;
    let burnBreakdown: string | null = null;
    let combatLoadTarget: number | null = null;
    const ammoPosture = ((unit.ammoPosture as AmmoPosture) ?? "sustain") as AmmoPosture;

    if (item.supplyClass === "V") {
      const isGce = unit.isGce ?? true;
      const ratesMap = isGce ? byUnit.get(unit.id) : byUnitNg.get(unit.id);
      const rates = ratesMap?.get(item.id);

      if (rates) {
        combatLoadTarget = rates.combatLoad;
        if (ammoPosture === "combat_load") {
          daily = unit.missionDays > 0 ? rates.combatLoad / unit.missionDays : 0;
          burnBreakdown = `Combat Load ${Math.round(rates.combatLoad).toLocaleString()} total (${isGce ? "GCE" : "Non-GCE"})`;
        } else if (ammoPosture === "assault") {
          daily = rates.assault;
          burnBreakdown = `Assault Rate ${Math.round(rates.assault).toLocaleString()}/day (${isGce ? "GCE" : "Non-GCE"})`;
        } else {
          daily = rates.sustain;
          burnBreakdown = `Sustain Rate ${Math.round(rates.sustain).toLocaleString()}/day (${isGce ? "GCE" : "Non-GCE"})`;
        }
      } else {
        // No weapon mapped — fallback to adjustedDailyRate (handles custom Class V items with explicit rates)
        daily = adjustedDailyRate(
          item.baseDailyRate,
          item.supplyClass as SupplyClass,
          unit.climate as Climate,
          unit.opTempo as OpTempo,
          unit.personnel,
        );
      }
    } else {
      daily = adjustedDailyRate(
        item.baseDailyRate,
        item.supplyClass as SupplyClass,
        unit.climate as Climate,
        unit.opTempo as OpTempo,
        unit.personnel,
      );
    }


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
      burnBreakdown,
      combatLoadTarget,
      ammoPosture,
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

router.get("/dashboard/dodic-breakdown", async (_req, res) => {
  const { enriched } = await gatherEnrichedAll();

  // Map catalogItemId -> DODIC code (one weapon-mapped row is enough; multiple
  // weapon systems may share a DODIC, so prefer the most common one).
  const dodicByItem = new Map<string, string>();
  {
    const dodicRows = await db
      .select({
        catalogItemId: weaponDodicRatesTable.catalogItemId,
        dodic: weaponDodicRatesTable.dodic,
      })
      .from(weaponDodicRatesTable);
    const counts = new Map<string, Map<string, number>>();
    for (const r of dodicRows) {
      if (!counts.has(r.catalogItemId)) counts.set(r.catalogItemId, new Map());
      const m = counts.get(r.catalogItemId)!;
      m.set(r.dodic, (m.get(r.dodic) ?? 0) + 1);
    }
    for (const [itemId, m] of counts) {
      let best = "";
      let bestCount = -1;
      for (const [d, c] of m) {
        if (c > bestCount) {
          best = d;
          bestCount = c;
        }
      }
      dodicByItem.set(itemId, best);
    }
  }

  const classV = enriched.filter((e) => e.item.supplyClass === "V");

  type Acc = {
    catalogItemId: string;
    nomenclature: string;
    unit: string;
    dodic: string;
    totalOnHand: number;
    totalDailyRequired: number;
    totalRequired: number;
    contributingUnits: Array<{
      unitId: string;
      unitName: string;
      callsign: string | null;
      echelon: string;
      onHand: number;
      dailyRequired: number;
      required: number;
      shortfall: number;
      daysOfSupply: number;
      status: "green" | "amber" | "red";
    }>;
  };

  const byItem = new Map<string, Acc>();
  for (const e of classV) {
    let acc = byItem.get(e.item.id);
    if (!acc) {
      acc = {
        catalogItemId: e.item.id,
        nomenclature: e.item.name,
        unit: e.item.unit,
        dodic: dodicByItem.get(e.item.id) ?? "",
        totalOnHand: 0,
        totalDailyRequired: 0,
        totalRequired: 0,
        contributingUnits: [],
      };
      byItem.set(e.item.id, acc);
    }
    acc.totalOnHand += e.entry.onHand;
    acc.totalDailyRequired += e.daily;
    acc.totalRequired += e.required;
    acc.contributingUnits.push({
      unitId: e.unit.id,
      unitName: e.unit.name,
      callsign: e.unit.callsign ?? null,
      echelon: e.unit.echelon,
      onHand: round2(e.entry.onHand),
      dailyRequired: round2(e.daily),
      required: round2(e.required),
      shortfall: round2(e.shortfall),
      daysOfSupply: round2(e.days),
      status: e.status,
    });
  }

  const items = Array.from(byItem.values()).map((acc) => {
    const totalShortfall = acc.contributingUnits.reduce(
      (s, u) => s + u.shortfall,
      0,
    );
    const aggregateDaysOfSupply =
      acc.totalDailyRequired > 0
        ? acc.totalOnHand / acc.totalDailyRequired
        : 999;
    const unitsShort = acc.contributingUnits.filter((u) => u.shortfall > 0).length;
    // Worst-of contributing unit statuses surfaces the regiment-level state.
    const status: "green" | "amber" | "red" = acc.contributingUnits.some(
      (u) => u.status === "red",
    )
      ? "red"
      : acc.contributingUnits.some((u) => u.status === "amber")
        ? "amber"
        : "green";

    // Surface short units first within each DODIC for fast triage.
    const sortedUnits = acc.contributingUnits
      .slice()
      .sort((a, b) => {
        const rank = (s: string) => (s === "red" ? 0 : s === "amber" ? 1 : 2);
        const r = rank(a.status) - rank(b.status);
        if (r !== 0) return r;
        return b.shortfall - a.shortfall;
      });

    return {
      dodic: acc.dodic,
      catalogItemId: acc.catalogItemId,
      nomenclature: acc.nomenclature,
      unit: acc.unit,
      totalOnHand: round2(acc.totalOnHand),
      totalDailyRequired: round2(acc.totalDailyRequired),
      totalRequired: round2(acc.totalRequired),
      totalShortfall: round2(totalShortfall),
      aggregateDaysOfSupply: round2(aggregateDaysOfSupply),
      status,
      unitsTracking: acc.contributingUnits.length,
      unitsShort,
      contributingUnits: sortedUnits,
    };
  });

  // Worst-status DODICs first; within a status, biggest shortfall first.
  items.sort((a, b) => {
    const rank = (s: string) => (s === "red" ? 0 : s === "amber" ? 1 : 2);
    const r = rank(a.status) - rank(b.status);
    if (r !== 0) return r;
    if (b.totalShortfall !== a.totalShortfall) return b.totalShortfall - a.totalShortfall;
    return a.aggregateDaysOfSupply - b.aggregateDaysOfSupply;
  });

  const totals = {
    dodicCount: items.length,
    totalOnHand: round2(items.reduce((s, i) => s + i.totalOnHand, 0)),
    totalDailyRequired: round2(items.reduce((s, i) => s + i.totalDailyRequired, 0)),
    totalShortfall: round2(items.reduce((s, i) => s + i.totalShortfall, 0)),
  };

  res.json({ totals, items });
});

router.get("/dashboard/class/:supplyClass", async (req, res) => {
  const supplyClass = req.params.supplyClass as SupplyClass;
  if (!CLASS_ORDER.includes(supplyClass)) {
    res.status(400).json({ error: `Unknown supply class: ${req.params.supplyClass}` });
    return;
  }

  const { units, enriched } = await gatherEnrichedAll();
  const inClass = enriched.filter((e) => e.item.supplyClass === supplyClass);

  const items = inClass
    .slice()
    .sort((a, b) => {
      const rank = (s: string) => (s === "red" ? 0 : s === "amber" ? 1 : 2);
      const r = rank(a.status) - rank(b.status);
      if (r !== 0) return r;
      return a.days - b.days;
    })
    .map((e) => ({
      entryId: e.entry.id,
      unitId: e.unit.id,
      unitName: e.unit.name,
      itemId: e.item.id,
      itemName: e.item.name,
      onHand: round2(e.entry.onHand),
      required: round2(e.required),
      shortfall: round2(e.shortfall),
      unit: e.item.unit,
      daysOfSupply: round2(e.days),
      status: e.status,
      criticality: e.item.criticality,
      burnBreakdown: e.burnBreakdown ?? null,
      combatLoadTarget: e.combatLoadTarget ?? null,
      ammoPosture: e.ammoPosture ?? null,
    }));

  const unitRows = units.map((u) => {
    const inUnit = inClass.filter((e) => e.unit.id === u.id);
    const greenCount = inUnit.filter((e) => e.status === "green").length;
    const amberCount = inUnit.filter((e) => e.status === "amber").length;
    const redCount = inUnit.filter((e) => e.status === "red").length;
    const worstStatus: "green" | "amber" | "red" =
      redCount > 0 ? "red" : amberCount > 0 ? "amber" : "green";
    const worstDaysOfSupply =
      inUnit.length > 0 ? Math.min(...inUnit.map((e) => e.days)) : 999;
    return {
      unitId: u.id,
      unitName: u.name,
      callsign: u.callsign,
      echelon: u.echelon,
      personnel: u.personnel,
      location: u.location,
      itemCount: inUnit.length,
      greenCount,
      amberCount,
      redCount,
      worstStatus,
      worstDaysOfSupply: round2(worstDaysOfSupply),
    };
  });

  unitRows.sort((a, b) => {
    const rank = (s: string) => (s === "red" ? 0 : s === "amber" ? 1 : 2);
    const r = rank(a.worstStatus) - rank(b.worstStatus);
    if (r !== 0) return r;
    return a.worstDaysOfSupply - b.worstDaysOfSupply;
  });

  const totals = {
    green: items.filter((i) => i.status === "green").length,
    amber: items.filter((i) => i.status === "amber").length,
    red: items.filter((i) => i.status === "red").length,
    unitsTracking: unitRows.filter((u) => u.itemCount > 0).length,
    unitsAtRisk: unitRows.filter((u) => u.worstStatus !== "green" && u.itemCount > 0).length,
  };

  res.json({
    supplyClass,
    label: CLASS_LABELS[supplyClass],
    totals,
    units: unitRows,
    items,
  });
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

router.get("/dashboard/distro-audit", async (_req, res) => {
  const [result, lastRun, lastSuccessfulSend] = await Promise.all([
    runDistroAudit(),
    getLatestCommsHygieneRun(),
    getLatestSuccessfulCommsHygieneSend(),
  ]);
  res.json({ ...result, lastRun, lastSuccessfulSend });
});

router.get("/dashboard/comms-hygiene-stats", async (_req, res) => {
  const stats = await getCommsHygieneStats();
  res.json(stats);
});

router.get("/dashboard/comms-hygiene-settings", async (_req, res) => {
  const settings = await getCommsHygieneSettings();
  res.json(settings);
});

router.put("/dashboard/comms-hygiene-settings", async (req, res) => {
  // Zod handles the validation envelope; any error from the parse call
  // bubbles to the central error handler as a 400. We deliberately do
  // NOT wrap the DB call in a catch — infra failures (DB down, schema
  // missing) need to surface as 5xx so monitoring sees them, and the
  // domain-level range check inside `setCommsHygieneRetentionOverride`
  // is just a defensive backstop because the Zod schema already pins
  // the value to 0..3650 or null.
  const body = UpdateCommsHygieneSettingsBody.parse(req.body);
  const updated = await setCommsHygieneRetentionOverride(
    body.retentionDaysOverride,
  );
  req.log.info(
    {
      retentionDaysOverride: updated.retentionDaysOverride,
      retentionDays: updated.retentionDays,
    },
    "Comms-hygiene: retention override updated via dashboard",
  );
  res.json(updated);
});

router.get("/dashboard/comms-hygiene-runs", async (req, res) => {
  const limitRaw = req.query.limit;
  const limit =
    typeof limitRaw === "string" ? Number.parseInt(limitRaw, 10) : 50;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
  const runs = await listCommsHygieneRuns(safeLimit);
  res.json(runs);
});

router.post("/dashboard/distro-audit/send-digest", async (req, res) => {
  const result = await runCommsHygieneOnce();
  req.log.info(
    {
      audited: result.audited,
      flagged: result.flagged,
      invalid: result.invalid,
      emailSent: result.emailSent,
      reason: result.reason,
    },
    "Comms-hygiene: on-demand digest run completed",
  );
  res.json(result);
});

router.post("/dashboard/distro-audit/preview-digest", async (req, res) => {
  const digest = await buildDigest();
  req.log.info(
    {
      audited: digest.audited,
      flagged: digest.flagged,
      invalid: digest.invalid,
      suppressed: digest.suppressed,
    },
    "Comms-hygiene: digest preview rendered",
  );
  res.json(digest);
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
