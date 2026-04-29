import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  timestamp,
} from "drizzle-orm/pg-core";
import { unitsTable } from "./units";
import { catalogItemsTable } from "./catalog";

export const resupplyEventsTable = pgTable("resupply_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => unitsTable.id, { onDelete: "cascade" }),
  supplyClass: text("supply_class").notNull(),
  itemId: uuid("item_id").references(() => catalogItemsTable.id, {
    onDelete: "set null",
  }),
  quantity: doublePrecision("quantity").notNull(),
  unit: text("unit").notNull(),
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
  status: text("status").notNull().default("planned"),
  assignedTo: text("assigned_to"),
  notes: text("notes"),
  baselineId: uuid("baseline_id"),
  scheduleId: uuid("schedule_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ResupplyEvent = typeof resupplyEventsTable.$inferSelect;
export type InsertResupplyEvent = typeof resupplyEventsTable.$inferInsert;
