import {
  pgTable,
  uuid,
  doublePrecision,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { unitsTable } from "./units";
import { catalogItemsTable } from "./catalog";

export const supplyEntriesTable = pgTable(
  "supply_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => unitsTable.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => catalogItemsTable.id, { onDelete: "cascade" }),
    onHand: doublePrecision("on_hand").notNull().default(0),
    requiredOverride: doublePrecision("required_override"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    unitItemUnique: uniqueIndex("supply_entries_unit_item_unique").on(
      table.unitId,
      table.itemId,
    ),
  }),
);

export type SupplyEntry = typeof supplyEntriesTable.$inferSelect;
export type InsertSupplyEntry = typeof supplyEntriesTable.$inferInsert;

// Snapshot of a unit-scoped supply removal. Lets the per-unit DELETE endpoint
// be undone within a short grace window: the snapshot captures the supply
// entry (with its previous on-hand count), any future resupply events tied to
// that item on that unit, and — for unit-scoped custom items that are dropped
// outright by the cascade — the full catalog row.
export type UnitSupplyDeletionSnapshot = {
  supplyEntry: {
    id: string;
    unitId: string;
    itemId: string;
    onHand: number;
    requiredOverride: number | null;
    updatedAt: string;
  };
  resupplyEvents: Array<{
    id: string;
    unitId: string;
    supplyClass: string;
    quantity: number;
    unit: string;
    scheduledFor: string;
    status: string;
    assignedTo: string | null;
    notes: string | null;
    createdAt: string;
  }>;
  // Populated only when the deleted supply entry referenced a unit-scoped
  // custom catalog item. The catalog row was deleted alongside the entry, and
  // an undo needs to recreate it before the supply entry can be re-inserted.
  catalogItem: {
    id: string;
    supplyClass: string;
    name: string;
    nsn: string | null;
    unit: string;
    baseDailyRate: number;
    criticality: string;
    notes: string | null;
    isCustom: boolean;
    scopedUnitId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  // IDs of the activity / outbox rows the original DELETE wrote, so a restore
  // can wipe the audit trail noise from the now-undone delete.
  activityIds: string[];
  outboxIds: string[];
};

export const unitSupplyDeletionsTable = pgTable(
  "unit_supply_deletions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unitId: uuid("unit_id").notNull(),
    itemId: uuid("item_id").notNull(),
    snapshot: jsonb("snapshot").$type<UnitSupplyDeletionSnapshot>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    unitItemUnique: uniqueIndex(
      "unit_supply_deletions_unit_item_unique",
    ).on(table.unitId, table.itemId),
  }),
);

export type UnitSupplyDeletion = typeof unitSupplyDeletionsTable.$inferSelect;
export type InsertUnitSupplyDeletion =
  typeof unitSupplyDeletionsTable.$inferInsert;
