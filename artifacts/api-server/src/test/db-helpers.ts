import { db, pool } from "@workspace/db";
import {
  unitsTable,
  catalogItemsTable,
  catalogItemDeletionsTable,
  supplyEntriesTable,
  activityTable,
  syncOutboxTable,
  supplySnapshotsTable,
  weaponSystemsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";

type SeedUnitOverrides = Partial<typeof unitsTable.$inferInsert> & {
  name?: string;
};

let testCounter = 0;

function nextSuffix(): string {
  testCounter += 1;
  return `${process.pid}-${Date.now()}-${testCounter}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export async function seedTestUnit(overrides: SeedUnitOverrides = {}) {
  const suffix = nextSuffix();
  const [unit] = await db
    .insert(unitsTable)
    .values({
      name: `TEST_UNIT_${suffix}`,
      callsign: null,
      echelon: "company",
      personnel: 100,
      commander: null,
      location: null,
      climate: "temperate",
      opTempo: "sustained",
      missionDays: 30,
      role: "organic",
      ammoPosture: "sustain",
      isGce: true,
      ...overrides,
    })
    .returning();
  if (!unit) throw new Error("Failed to seed test unit");
  return unit;
}

type SeedItemOverrides = Partial<typeof catalogItemsTable.$inferInsert>;

export async function seedTestCatalogItem(
  unitId: string,
  overrides: SeedItemOverrides = {},
) {
  const suffix = nextSuffix();
  const [item] = await db
    .insert(catalogItemsTable)
    .values({
      supplyClass: "I",
      name: `TEST_ITEM_${suffix}`,
      unit: "ea",
      baseDailyRate: 1.0,
      criticality: "critical",
      isCustom: true,
      // scopedUnitId ties the item to the unit so cleanup cascades.
      scopedUnitId: unitId,
      ...overrides,
    })
    .returning();
  if (!item) throw new Error("Failed to seed test catalog item");
  return item;
}

export async function seedTestSupplyEntry(
  unitId: string,
  itemId: string,
  onHand: number,
  requiredOverride: number | null = null,
) {
  const [entry] = await db
    .insert(supplyEntriesTable)
    .values({ unitId, itemId, onHand, requiredOverride })
    .returning();
  if (!entry) throw new Error("Failed to seed test supply entry");
  return entry;
}

// Seeds a *global* (scopedUnitId: null) custom catalog item. The catalog
// route handlers only allow editing/deleting items where isCustom=true and
// scopedUnitId IS NULL, so this is the variant the catalog tests need.
// The caller owns cleanup via deleteTestCatalogItem.
export async function seedGlobalCatalogItem(
  overrides: Partial<typeof catalogItemsTable.$inferInsert> = {},
) {
  const suffix = nextSuffix();
  const [item] = await db
    .insert(catalogItemsTable)
    .values({
      supplyClass: "I",
      name: `TEST_GLOBAL_ITEM_${suffix}`,
      unit: "ea",
      baseDailyRate: 1.0,
      criticality: "medium",
      isCustom: true,
      scopedUnitId: null,
      ...overrides,
    })
    .returning();
  if (!item) throw new Error("Failed to seed global catalog item");
  return item;
}

// Cleans up a catalog item (and any pending deletion snapshot row keyed by
// its id, since the catalog DELETE handler writes one of those).
export async function deleteTestCatalogItem(itemId: string) {
  await db
    .delete(catalogItemDeletionsTable)
    .where(eq(catalogItemDeletionsTable.id, itemId));
  await db.delete(catalogItemsTable).where(eq(catalogItemsTable.id, itemId));
}

// Seeds a weapon system row for use in weapons-route tests. The caller owns
// cleanup via deleteTestWeaponSystem (cascades to weapon_dodic_rates and
// unit_weapons via FK onDelete: cascade).
export async function seedTestWeaponSystem(
  overrides: Partial<typeof weaponSystemsTable.$inferInsert> = {},
) {
  const suffix = nextSuffix();
  const [weapon] = await db
    .insert(weaponSystemsTable)
    .values({
      name: `TEST_WEAPON_${suffix}`,
      tamcn: null,
      isGce: true,
      ...overrides,
    })
    .returning();
  if (!weapon) throw new Error("Failed to seed test weapon system");
  return weapon;
}

export async function deleteTestWeaponSystem(weaponSystemId: string) {
  await db
    .delete(weaponSystemsTable)
    .where(eq(weaponSystemsTable.id, weaponSystemId));
}

// Removes all rows tied to the test unit. The unit FK cascade clears supply
// entries, snapshots, and any unit-scoped catalog items. Activity and sync
// outbox rows do not cascade (no FK), so we sweep them up explicitly.
export async function deleteTestUnit(unitId: string) {
  await db.delete(activityTable).where(eq(activityTable.unitId, unitId));
  await db.delete(syncOutboxTable).where(eq(syncOutboxTable.unitId, unitId));
  // supplySnapshots cascade with the unit, but be defensive in case the unit
  // is gone but some snapshot references linger from a partial test run.
  await db
    .delete(supplySnapshotsTable)
    .where(eq(supplySnapshotsTable.unitId, unitId));
  await db.delete(unitsTable).where(eq(unitsTable.id, unitId));
}

export async function closeTestPool() {
  await pool.end();
}
