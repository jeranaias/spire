import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  uuid,
  jsonb,
} from "drizzle-orm/pg-core";

export const syncStateTable = pgTable("sync_state", {
  id: text("id").primaryKey(),
  upstreamSystem: text("upstream_system").notNull(),
  connected: boolean("connected").notNull().default(true),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  pendingChanges: integer("pending_changes").notNull().default(0),
  latencyMs: integer("latency_ms"),
  autoSyncEnabled: boolean("auto_sync_enabled").notNull().default(true),
  autoSyncIntervalMinutes: integer("auto_sync_interval_minutes").notNull().default(5),
});

export const syncOutboxTable = pgTable("sync_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityKind: text("entity_kind").notNull(),
  entityId: text("entity_id").notNull(),
  unitId: text("unit_id"),
  op: text("op").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  status: text("status").notNull().default("pending"),
  lastError: text("last_error"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

export const syncRunsTable = pgTable("sync_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  pushedCount: integer("pushed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  catalogMatched: integer("catalog_matched").notNull().default(0),
  catalogNew: integer("catalog_new").notNull().default(0),
  catalogChanged: integer("catalog_changed").notNull().default(0),
  latencyMs: integer("latency_ms"),
  results: jsonb("results"),
});

export type SyncState = typeof syncStateTable.$inferSelect;
export type InsertSyncState = typeof syncStateTable.$inferInsert;
export type SyncOutbox = typeof syncOutboxTable.$inferSelect;
export type InsertSyncOutbox = typeof syncOutboxTable.$inferInsert;
export type SyncRun = typeof syncRunsTable.$inferSelect;
export type InsertSyncRun = typeof syncRunsTable.$inferInsert;
