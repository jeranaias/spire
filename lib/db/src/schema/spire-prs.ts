import {
  pgTable,
  text,
  timestamp,
  integer,
  uuid,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * Tracks GitHub pull requests opened against the SPIRE repository from MARLOG.
 *
 * `sourceKind` is one of:
 *   - "calculator" — a one-off requirements bill from /calculator
 *   - "schedule"   — a pre-coordinated (comms-denied) schedule
 *   - "supply"     — a unit's current supply snapshot (on-hand + overrides)
 *
 * `sourceId` is unitId (calculator/supply) or scheduleId (schedule); free-form
 * to keep the table source-agnostic. `state` is mirrored from GitHub
 * ("open"/"closed"/"merged") and refreshed lazily on read.
 */
export const spirePrsTable = pgTable(
  "spire_prs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceKind: text("source_kind").notNull(),
    sourceId: text("source_id"),
    sourceLabel: text("source_label").notNull(),
    repoOwner: text("repo_owner").notNull(),
    repoName: text("repo_name").notNull(),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    filePath: text("file_path").notNull(),
    prNumber: integer("pr_number").notNull(),
    prUrl: text("pr_url").notNull(),
    title: text("title").notNull(),
    state: text("state").notNull().default("open"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    payloadSummary: jsonb("payload_summary"),
  },
  (t) => ({
    sourceIdx: index("spire_prs_source_idx").on(t.sourceKind, t.sourceId),
    createdAtIdx: index("spire_prs_created_at_idx").on(t.createdAt),
  }),
);

export type SpirePr = typeof spirePrsTable.$inferSelect;
export type InsertSpirePr = typeof spirePrsTable.$inferInsert;
