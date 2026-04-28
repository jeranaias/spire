import {
  pgTable,
  uuid,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const activityTable = pgTable("activity", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  unitId: uuid("unit_id"),
  unitName: text("unit_name"),
  timestamp: timestamp("timestamp", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Activity = typeof activityTable.$inferSelect;
export type InsertActivity = typeof activityTable.$inferInsert;
