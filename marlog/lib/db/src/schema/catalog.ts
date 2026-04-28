import {
  pgTable,
  uuid,
  text,
  doublePrecision,
} from "drizzle-orm/pg-core";

export const catalogItemsTable = pgTable("catalog_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  supplyClass: text("supply_class").notNull(),
  name: text("name").notNull(),
  nsn: text("nsn"),
  unit: text("unit").notNull(),
  baseDailyRate: doublePrecision("base_daily_rate").notNull(),
  criticality: text("criticality").notNull(),
  notes: text("notes"),
});

export type CatalogItem = typeof catalogItemsTable.$inferSelect;
export type InsertCatalogItem = typeof catalogItemsTable.$inferInsert;
