import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  weaponSystemsTable,
  weaponDodicRatesTable,
  unitWeaponsTable,
  unitsTable,
  catalogItemsTable,
  activityTable,
} from "@workspace/db";
import {
  ListUnitWeaponsParams,
  AddUnitWeaponParams,
  AddUnitWeaponBody,
  UpdateUnitWeaponParams,
  UpdateUnitWeaponBody,
  DeleteUnitWeaponParams,
  UpdateWeaponDodicRateParams,
  UpdateWeaponDodicRateBody,
} from "@workspace/api-zod";
import { eq, and } from "drizzle-orm";

const router: IRouter = Router();

function serializeUnitWeapon(
  uw: typeof unitWeaponsTable.$inferSelect,
  weapon: typeof weaponSystemsTable.$inferSelect,
) {
  return {
    id: uw.id,
    unitId: uw.unitId,
    weaponSystemId: uw.weaponSystemId,
    weaponName: weapon.name,
    tamcn: weapon.tamcn ?? null,
    quantity: uw.quantity,
    isGce: weapon.isGce,
  };
}

router.get("/units/:unitId/weapons", async (req, res) => {
  const { unitId } = ListUnitWeaponsParams.parse(req.params);

  const rows = await db
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

  res.json(rows.map(({ uw, weapon }) => serializeUnitWeapon(uw, weapon)));
});

router.post("/units/:unitId/weapons", async (req, res) => {
  const { unitId } = AddUnitWeaponParams.parse(req.params);
  const body = AddUnitWeaponBody.parse(req.body);

  const [unit] = await db
    .select()
    .from(unitsTable)
    .where(eq(unitsTable.id, unitId));
  if (!unit) {
    res.status(404).json({ error: "Unit not found" });
    return;
  }

  const [weapon] = await db
    .select()
    .from(weaponSystemsTable)
    .where(eq(weaponSystemsTable.id, body.weaponSystemId));
  if (!weapon) {
    res.status(404).json({ error: "Weapon system not found" });
    return;
  }

  const [existing] = await db
    .select()
    .from(unitWeaponsTable)
    .where(
      and(
        eq(unitWeaponsTable.unitId, unitId),
        eq(unitWeaponsTable.weaponSystemId, body.weaponSystemId),
      ),
    );

  let uw: typeof unitWeaponsTable.$inferSelect;
  if (existing) {
    const [updated] = await db
      .update(unitWeaponsTable)
      .set({ quantity: body.quantity })
      .where(eq(unitWeaponsTable.id, existing.id))
      .returning();
    if (!updated) {
      res.status(500).json({ error: "Failed to update weapon entry" });
      return;
    }
    uw = updated;
  } else {
    const [created] = await db
      .insert(unitWeaponsTable)
      .values({ unitId, weaponSystemId: body.weaponSystemId, quantity: body.quantity })
      .returning();
    if (!created) {
      res.status(500).json({ error: "Failed to add weapon" });
      return;
    }
    uw = created;
  }

  res.status(201).json(serializeUnitWeapon(uw, weapon));
});

router.patch("/units/:unitId/weapons/:weaponEntryId", async (req, res) => {
  const { unitId, weaponEntryId } = UpdateUnitWeaponParams.parse(req.params);
  const body = UpdateUnitWeaponBody.parse(req.body);

  const [existing] = await db
    .select({
      uw: unitWeaponsTable,
      weapon: weaponSystemsTable,
    })
    .from(unitWeaponsTable)
    .innerJoin(
      weaponSystemsTable,
      eq(unitWeaponsTable.weaponSystemId, weaponSystemsTable.id),
    )
    .where(
      and(
        eq(unitWeaponsTable.id, weaponEntryId),
        eq(unitWeaponsTable.unitId, unitId),
      ),
    );

  if (!existing) {
    res.status(404).json({ error: "Weapon entry not found" });
    return;
  }

  const [updated] = await db
    .update(unitWeaponsTable)
    .set({ quantity: body.quantity })
    .where(eq(unitWeaponsTable.id, weaponEntryId))
    .returning();

  if (!updated) {
    res.status(500).json({ error: "Failed to update weapon entry" });
    return;
  }

  res.json(serializeUnitWeapon(updated, existing.weapon));
});

router.delete("/units/:unitId/weapons/:weaponEntryId", async (req, res) => {
  const { unitId, weaponEntryId } = DeleteUnitWeaponParams.parse(req.params);

  const [existing] = await db
    .select()
    .from(unitWeaponsTable)
    .where(
      and(
        eq(unitWeaponsTable.id, weaponEntryId),
        eq(unitWeaponsTable.unitId, unitId),
      ),
    );

  if (!existing) {
    res.status(404).json({ error: "Weapon entry not found" });
    return;
  }

  await db.delete(unitWeaponsTable).where(eq(unitWeaponsTable.id, weaponEntryId));
  res.status(204).send();
});

router.get("/weapon-systems", async (_req, res) => {
  const weapons = await db
    .select()
    .from(weaponSystemsTable)
    .orderBy(weaponSystemsTable.name);

  const rates = await db.select().from(weaponDodicRatesTable);
  const catalog = await db.select().from(catalogItemsTable);
  const catalogById = new Map(catalog.map((c) => [c.id, c]));

  const out = weapons.map((w) => {
    const wRates = rates.filter((r) => r.weaponSystemId === w.id);
    return {
      id: w.id,
      tamcn: w.tamcn ?? null,
      name: w.name,
      isGce: w.isGce,
      notes: w.notes ?? null,
      dodics: wRates.map((r) => {
        const item = catalogById.get(r.catalogItemId);
        return {
          id: r.id,
          dodic: r.dodic,
          nomenclature: item?.name ?? r.dodic,
          catalogItemId: r.catalogItemId,
          gceCombatLoad: r.gceCombatLoad,
          gceAssaultRate: r.gceAssaultRate,
          gceSustainRate: r.gceSustainRate,
          nonGceCombatLoad: r.nonGceCombatLoad,
          nonGceAssaultRate: r.nonGceAssaultRate,
          nonGceSustainRate: r.nonGceSustainRate,
        };
      }),
    };
  });

  res.json(out);
});

router.patch(
  "/weapon-systems/:weaponSystemId/dodic-rates/:rateId",
  async (req, res) => {
    const { weaponSystemId, rateId } =
      UpdateWeaponDodicRateParams.parse(req.params);
    const body = UpdateWeaponDodicRateBody.parse(req.body);

    const [existing] = await db
      .select()
      .from(weaponDodicRatesTable)
      .where(
        and(
          eq(weaponDodicRatesTable.id, rateId),
          eq(weaponDodicRatesTable.weaponSystemId, weaponSystemId),
        ),
      );

    if (!existing) {
      res.status(404).json({ error: "Weapon DODIC rate not found" });
      return;
    }

    const [weapon] = await db
      .select()
      .from(weaponSystemsTable)
      .where(eq(weaponSystemsTable.id, weaponSystemId));

    if (!weapon) {
      res.status(404).json({ error: "Weapon system not found" });
      return;
    }

    const patch: Partial<typeof weaponDodicRatesTable.$inferInsert> = {};
    if (body.gceCombatLoad !== undefined)
      patch.gceCombatLoad = body.gceCombatLoad;
    if (body.gceAssaultRate !== undefined)
      patch.gceAssaultRate = body.gceAssaultRate;
    if (body.gceSustainRate !== undefined)
      patch.gceSustainRate = body.gceSustainRate;
    if (body.nonGceCombatLoad !== undefined)
      patch.nonGceCombatLoad = body.nonGceCombatLoad;
    if (body.nonGceAssaultRate !== undefined)
      patch.nonGceAssaultRate = body.nonGceAssaultRate;
    if (body.nonGceSustainRate !== undefined)
      patch.nonGceSustainRate = body.nonGceSustainRate;

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const [updated] = await db
      .update(weaponDodicRatesTable)
      .set(patch)
      .where(eq(weaponDodicRatesTable.id, rateId))
      .returning();

    if (!updated) {
      res.status(500).json({ error: "Failed to update DODIC rate" });
      return;
    }

    const [item] = await db
      .select()
      .from(catalogItemsTable)
      .where(eq(catalogItemsTable.id, updated.catalogItemId));

    const changed =
      existing.gceCombatLoad !== updated.gceCombatLoad ||
      existing.gceAssaultRate !== updated.gceAssaultRate ||
      existing.gceSustainRate !== updated.gceSustainRate ||
      existing.nonGceCombatLoad !== updated.nonGceCombatLoad ||
      existing.nonGceAssaultRate !== updated.nonGceAssaultRate ||
      existing.nonGceSustainRate !== updated.nonGceSustainRate;

    if (changed) {
      await db.insert(activityTable).values({
        kind: "supply_updated",
        message: `Doctrinal rates updated: ${weapon.name} / ${updated.dodic}`,
        unitId: null,
        unitName: null,
      });
    }

    res.json({
      id: updated.id,
      dodic: updated.dodic,
      nomenclature: item?.name ?? updated.dodic,
      catalogItemId: updated.catalogItemId,
      gceCombatLoad: updated.gceCombatLoad,
      gceAssaultRate: updated.gceAssaultRate,
      gceSustainRate: updated.gceSustainRate,
      nonGceCombatLoad: updated.nonGceCombatLoad,
      nonGceAssaultRate: updated.nonGceAssaultRate,
      nonGceSustainRate: updated.nonGceSustainRate,
    });
  },
);

export default router;
