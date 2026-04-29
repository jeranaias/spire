import {
  pgTable,
  uuid,
  text,
  doublePrecision,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { unitsTable } from "./units";
import { catalogItemsTable } from "./catalog";

export const supplySnapshotsTable = pgTable("supply_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => unitsTable.id, { onDelete: "cascade" }),
  itemId: uuid("item_id")
    .notNull()
    .references(() => catalogItemsTable.id, { onDelete: "cascade" }),
  onHand: doublePrecision("on_hand").notNull(),
  personnel: integer("personnel"),
  climate: text("climate"),
  opTempo: text("op_tempo"),
  missionDays: integer("mission_days"),
  source: text("source").notNull().default("planner_edit"),
  actorNote: text("actor_note"),
  snapshotAt: timestamp("snapshot_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SupplySnapshot = typeof supplySnapshotsTable.$inferSelect;
export type InsertSupplySnapshot = typeof supplySnapshotsTable.$inferInsert;
