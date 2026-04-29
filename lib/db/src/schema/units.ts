import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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
  role: text("role").notNull().default("organic"),
  ammoPosture: text("ammo_posture").notNull().default("sustain"),
  isGce: boolean("is_gce").notNull().default(true),
  distroEmails: text("distro_emails")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  distroCcEmails: text("distro_cc_emails")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  distroBccEmails: text("distro_bcc_emails")
    .array()
    .notNull()
    .default(sql`ARRAY[]::text[]`),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Unit = typeof unitsTable.$inferSelect;
export type InsertUnit = typeof unitsTable.$inferInsert;
