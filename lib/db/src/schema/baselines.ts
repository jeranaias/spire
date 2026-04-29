import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { unitsTable } from "./units";

export const supplyBaselinesTable = pgTable("supply_baselines", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: text("label").notNull(),
  notes: text("notes"),
  unitId: uuid("unit_id").references(() => unitsTable.id, {
    onDelete: "cascade",
  }),
  frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  snapshotData: jsonb("snapshot_data").notNull().$type<BaselineSnapshotData>(),
});

export interface BaselineSnapshotItem {
  itemId: string;
  itemName: string;
  supplyClass: string;
  unit: string;
  onHand: number;
  dailyConsumption: number;
  daysOfSupply: number;
  status: string;
}

export interface BaselineSnapshotData {
  unitId: string;
  unitName: string;
  personnel: number;
  climate: string;
  opTempo: string;
  missionDays: number;
  items: BaselineSnapshotItem[];
}

export type SupplyBaseline = typeof supplyBaselinesTable.$inferSelect;
export type InsertSupplyBaseline = typeof supplyBaselinesTable.$inferInsert;

export const prePlannedSchedulesTable = pgTable("pre_planned_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  baselineId: uuid("baseline_id").references(() => supplyBaselinesTable.id, {
    onDelete: "set null",
  }),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => unitsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  horizonDays: text("horizon_days").notNull(),
  burnModel: text("burn_model").notNull().default("worst-of-both"),
  safetyMarginDays: text("safety_margin_days").notNull().default("2"),
  resupplyLeadDays: text("resupply_lead_days").notNull().default("2"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  shareToken: text("share_token"),
});

export type PrePlannedSchedule = typeof prePlannedSchedulesTable.$inferSelect;
export type InsertPrePlannedSchedule = typeof prePlannedSchedulesTable.$inferInsert;
