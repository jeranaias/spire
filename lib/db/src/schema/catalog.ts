import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { unitsTable } from "./units";

export const catalogItemsTable = pgTable("catalog_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplyClass: text("supply_class").notNull(),
  name: text("name").notNull(),
  nsn: text("nsn"),
  unit: text("unit").notNull(),
  baseDailyRate: doublePrecision("base_daily_rate").notNull(),
  criticality: text("criticality").notNull(),
  notes: text("notes"),
  isCustom: boolean("is_custom").notNull().default(false),
  scopedUnitId: uuid("scoped_unit_id").references(() => unitsTable.id, {
    onDelete: "cascade",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CatalogItem = typeof catalogItemsTable.$inferSelect;
export type InsertCatalogItem = typeof catalogItemsTable.$inferInsert;

// Snapshot of a catalog item deletion. Lets the catalog DELETE endpoint be
// undone within a short grace window: the snapshot captures everything we'd
// need to rebuild the catalog item, the per-unit supply entries (with their
// previous on-hand counts), and any future resupply events that were cancelled
// by the cascade. Rows are looked up by the deleted catalog item's id.
export type CatalogItemDeletionSnapshot = {
  item: {
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
  };
  supplyEntries: Array<{
    id: string;
    unitId: string;
    onHand: number;
    updatedAt: string;
  }>;
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
  // IDs of the activity / outbox rows the original DELETE wrote, so a restore
  // can wipe the audit trail noise from the now-undone delete.
  activityIds: string[];
  outboxIds: string[];
};

export const catalogItemDeletionsTable = pgTable("catalog_item_deletions", {
  id: uuid("id").primaryKey(),
  snapshot: jsonb("snapshot").$type<CatalogItemDeletionSnapshot>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type CatalogItemDeletion = typeof catalogItemDeletionsTable.$inferSelect;
export type InsertCatalogItemDeletion =
  typeof catalogItemDeletionsTable.$inferInsert;
