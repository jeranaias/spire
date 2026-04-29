import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  unitsTable,
  catalogItemsTable,
  supplyEntriesTable,
  resupplyEventsTable,
  activityTable,
  weaponSystemsTable,
  weaponDodicRatesTable,
  unitWeaponsTable,
} from "@workspace/db";
import {
  CreateUnitBody,
  GetUnitParams,
  UpdateUnitParams,
  UpdateUnitBody,
  DeleteUnitParams,
} from "@workspace/api-zod";
import { eq, asc, and, gte } from "drizzle-orm";
import {
  adjustedDailyRate,
  statusFromDays,
  deriveRequirement,
  buildSupplyEntryResponse,
  round2,
  CLASS_LABELS,
  CLASS_ORDER,
  DOS_CLASSES,
  type Climate,
  type OpTempo,
  type SupplyClass,
} from "../lib/logistics";
import { partitionDistroEmails } from "@workspace/distro-email";

const router: IRouter = Router();

type AmmoPosture = "combat_load" | "assault" | "sustain";

function normalizeDistroEmails(input: string[] | undefined | null): string[] {
  const { valid, invalid } = partitionDistroEmails(input);
  if (invalid.length > 0) {
    const err = new Error(
      `Invalid distribution list address${invalid.length === 1 ? "" : "es"}: ${invalid.join(", ")}`,
    ) as Error & { status: number };
    err.status = 400;
    throw err;
  }
  return valid;
}

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
    role: u.role,
    ammoPosture: (u.ammoPosture ?? "sustain") as AmmoPosture,
    isGce: u.isGce ?? true,
    distroEmails: u.distroEmails ?? [],
    distroCcEmails: u.distroCcEmails ?? [],
    distroBccEmails: u.distroBccEmails ?? [],
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

async function getWeaponDrivenRates(unitId: string, isGce: boolean) {
  const rates = await db
    .select({
      rate: weaponDodicRatesTable,
      uw: unitWeaponsTable,
    })
    .from(weaponDodicRatesTable)
    .innerJoin(
      unitWeaponsTable,
      eq(weaponDodicRatesTable.weaponSystemId, unitWeaponsTable.weaponSystemId),
    )
    .where(eq(unitWeaponsTable.unitId, unitId));

  const byItem = new Map<string, { assault: number; sustain: number; combatLoad: number }>();

  for (const { rate: r, uw } of rates) {
    const current = byItem.get(r.catalogItemId) ?? { assault: 0, sustain: 0, combatLoad: 0 };

    if (isGce) {
      current.assault    += uw.quantity * r.gceAssaultRate;
      current.sustain    += uw.quantity * r.gceSustainRate;
      current.combatLoad += uw.quantity * r.gceCombatLoad;
    } else {
      current.assault    += uw.quantity * r.nonGceAssaultRate;
      current.sustain    += uw.quantity * r.nonGceSustainRate;
      current.combatLoad += uw.quantity * r.nonGceCombatLoad;
    }

    byItem.set(r.catalogItemId, current);
  }

  return byItem;
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

  const climate    = unit.climate as Climate;
  const opTempo    = unit.opTempo as OpTempo;
  const personnel  = unit.personnel;
  const days       = unit.missionDays;
  const ammoPosture: AmmoPosture = (unit.ammoPosture as AmmoPosture) ?? "sustain";
  const isGce      = unit.isGce ?? true;

  // Build weapon-driven rates map for Class V items
  const weaponRates = await getWeaponDrivenRates(unitId, isGce);

  const enriched = entries.map(({ entry, item }) => {
    let dailyConsumption: number;
    let burnBreakdown: string | null = null;

    if (item.supplyClass === "V") {
      // Class V — weapon-driven calculation
      const rates = weaponRates.get(item.id);
      if (rates) {
        if (ammoPosture === "combat_load") {
          // combat_load is a total target, not a daily rate
          // We spread combat load over mission days as the "daily equivalent" for DOS calc
          dailyConsumption = days > 0 ? rates.combatLoad / days : 0;
          burnBreakdown = `Combat Load (${rates.combatLoad} rds total)`;
        } else if (ammoPosture === "assault") {
          dailyConsumption = rates.assault;
          burnBreakdown = `Daily Assault (${isGce ? "GCE" : "Non-GCE"})`;
        } else {
          dailyConsumption = rates.sustain;
          burnBreakdown = `Daily Sustain (${isGce ? "GCE" : "Non-GCE"})`;
        }
      } else {
        // No weapon assigned for this DODIC — use base rate (handles custom Class V items)
        dailyConsumption = adjustedDailyRate(
          item.baseDailyRate,
          item.supplyClass as SupplyClass,
          climate,
          opTempo,
          personnel,
        );
      }
    } else {
      dailyConsumption = adjustedDailyRate(
        item.baseDailyRate,
        item.supplyClass as SupplyClass,
        climate,
        opTempo,
        personnel,
      );
    }

    const requirement = deriveRequirement({
      override: entry.requiredOverride,
      onHand: entry.onHand,
      dailyConsumption,
      missionDays: days,
    });

    return buildSupplyEntryResponse({
      entry,
      item,
      dailyConsumption,
      requirement,
      burnBreakdown,
      // For combat load gap view: the combat load target if weapon rates exist
      combatLoadTarget:
        weaponRates.has(item.id) && item.supplyClass === "V"
          ? round2(weaponRates.get(item.id)!.combatLoad)
          : null,
    });
  });

  // Readiness: weight by criticality. Class IX and "not a requirement" rows excluded.
  let readinessScore  = 100;
  let deficiencyCount = 0;
  for (const e of enriched) {
    if (!e.isRequirement) continue;
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
      role: body.role ?? "organic",
      ammoPosture: (body.ammoPosture as AmmoPosture | undefined) ?? "sustain",
      isGce: body.isGce ?? true,
      distroEmails: normalizeDistroEmails(body.distroEmails),
      distroCcEmails: normalizeDistroEmails(body.distroCcEmails),
      distroBccEmails: normalizeDistroEmails(body.distroBccEmails),
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

  const supplyByClass = CLASS_ORDER.map((cls) => {
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

  // Get weapons on this unit
  const weaponRows = await db
    .select({
      uw: unitWeaponsTable,
      weapon: weaponSystemsTable,
    })
    .from(unitWeaponsTable)
    .innerJoin(
      weaponSystemsTable,
      eq(unitWeaponsTable.weaponSystemId, weaponSystemsTable.id),
    )
    .where(eq(unitWeaponsTable.unitId, unitId))
    .orderBy(weaponSystemsTable.name);

  const weapons = weaponRows.map(({ uw, weapon }) => ({
    id: uw.id,
    unitId: uw.unitId,
    weaponSystemId: uw.weaponSystemId,
    weaponName: weapon.name,
    tamcn: weapon.tamcn ?? null,
    quantity: uw.quantity,
    isGce: weapon.isGce,
  }));

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
    weapons,
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
      ...(body.role        != null ? { role: body.role }                              : {}),
      ...(body.ammoPosture != null ? { ammoPosture: body.ammoPosture as AmmoPosture } : {}),
      ...(body.isGce       != null ? { isGce: body.isGce }                            : {}),
      ...(body.distroEmails != null
        ? { distroEmails: normalizeDistroEmails(body.distroEmails) }
        : {}),
      ...(body.distroCcEmails != null
        ? { distroCcEmails: normalizeDistroEmails(body.distroCcEmails) }
        : {}),
      ...(body.distroBccEmails != null
        ? { distroBccEmails: normalizeDistroEmails(body.distroBccEmails) }
        : {}),
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
