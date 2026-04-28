import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";

export const unitsTable = pgTable("units", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  callsign: text("callsign"),
  echelon: text("echelon").notNull(),
  personnel: integer("personnel").notNull(),
  commander: text("commander"),
  location: text("location"),
  climate: text("climate").notNull(),
  opTempo: text("op_tempo").notNull(),
  missionDays: integer("mission_days").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Unit = typeof unitsTable.$inferSelect;
export type InsertUnit = typeof unitsTable.$inferInsert;
