import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { unitsTable } from "./units";
import { catalogItemsTable } from "./catalog";

export const weaponSystemsTable = pgTable("weapon_systems", {
  id: uuid("id").primaryKey().defaultRandom(),
  tamcn: text("tamcn"),
  name: text("name").notNull(),
  isGce: boolean("is_gce").notNull().default(true),
  notes: text("notes"),
});

export const weaponDodicRatesTable = pgTable(
  "weapon_dodic_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    weaponSystemId: uuid("weapon_system_id")
      .notNull()
      .references(() => weaponSystemsTable.id, { onDelete: "cascade" }),
    catalogItemId: uuid("catalog_item_id")
      .notNull()
      .references(() => catalogItemsTable.id, { onDelete: "cascade" }),
    dodic: text("dodic").notNull(),
    gceCombatLoad: doublePrecision("gce_combat_load").notNull().default(0),
    gceAssaultRate: doublePrecision("gce_assault_rate").notNull().default(0),
    gceSustainRate: doublePrecision("gce_sustain_rate").notNull().default(0),
    nonGceCombatLoad: doublePrecision("non_gce_combat_load").notNull().default(0),
    nonGceAssaultRate: doublePrecision("non_gce_assault_rate").notNull().default(0),
    nonGceSustainRate: doublePrecision("non_gce_sustain_rate").notNull().default(0),
  },
  (table) => ({
    weaponDodicUnique: uniqueIndex("weapon_dodic_unique").on(
      table.weaponSystemId,
      table.catalogItemId,
    ),
  }),
);

export const unitWeaponsTable = pgTable(
  "unit_weapons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => unitsTable.id, { onDelete: "cascade" }),
    weaponSystemId: uuid("weapon_system_id")
      .notNull()
      .references(() => weaponSystemsTable.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
  },
  (table) => ({
    unitWeaponUnique: uniqueIndex("unit_weapon_unique").on(
      table.unitId,
      table.weaponSystemId,
    ),
  }),
);

export type WeaponSystem = typeof weaponSystemsTable.$inferSelect;
export type InsertWeaponSystem = typeof weaponSystemsTable.$inferInsert;
export type WeaponDodicRate = typeof weaponDodicRatesTable.$inferSelect;
export type UnitWeapon = typeof unitWeaponsTable.$inferSelect;
