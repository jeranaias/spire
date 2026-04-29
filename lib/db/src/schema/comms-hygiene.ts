import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Single-row settings table for the comms-hygiene scheduler. Lets planners
 * override `COMMS_HYGIENE_RETENTION_DAYS` from the dashboard without
 * restarting the API. `retentionDaysOverride` is null when no override is
 * active and the env var (or its default) should be used.
 */
export const commsHygieneSettingsTable = pgTable("comms_hygiene_settings", {
  id: text("id").primaryKey(),
  retentionDaysOverride: integer("retention_days_override"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CommsHygieneSettingsRow =
  typeof commsHygieneSettingsTable.$inferSelect;

export const commsHygieneRunsTable = pgTable(
  "comms_hygiene_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ranAt: timestamp("ran_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    auditedCount: integer("audited_count").notNull(),
    flaggedCount: integer("flagged_count").notNull(),
    invalidCount: integer("invalid_count").notNull(),
    recipients: jsonb("recipients").$type<string[]>().notNull().default([]),
    cc: jsonb("cc").$type<string[]>().notNull().default([]),
    outcome: text("outcome").notNull(),
    errorMessage: text("error_message"),
  },
  (t) => ({
    ranAtIdx: index("comms_hygiene_runs_ran_at_idx").on(t.ranAt),
  }),
);

export type CommsHygieneRun = typeof commsHygieneRunsTable.$inferSelect;
export type InsertCommsHygieneRun = typeof commsHygieneRunsTable.$inferInsert;

export const COMMS_HYGIENE_OUTCOMES = [
  "sent",
  "skipped_no_flags",
  "skipped_no_recipients",
  "skipped_no_smtp",
  "failed",
] as const;

export type CommsHygieneOutcome = (typeof COMMS_HYGIENE_OUTCOMES)[number];
