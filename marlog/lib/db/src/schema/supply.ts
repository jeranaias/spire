import {
  pgTable,
  uuid,
  doublePrecision,
  timestamp,
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
