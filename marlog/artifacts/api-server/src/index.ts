import app from "./app";
import { logger } from "./lib/logger";
import { performSync } from "./routes/sync";
import { db } from "@workspace/db";
import { syncStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startAutoSyncScheduler();
});

function startAutoSyncScheduler() {
  const CHECK_INTERVAL_MS = 60 * 1000;

  setInterval(async () => {
    try {
      const [state] = await db
        .select()
        .from(syncStateTable)
        .where(eq(syncStateTable.id, "default"));

      if (!state || !state.autoSyncEnabled) return;

      const intervalMs = state.autoSyncIntervalMinutes * 60 * 1000;
      const lastSync = state.lastSyncAt ? state.lastSyncAt.getTime() : 0;
      const now = Date.now();

      if (now - lastSync >= intervalMs) {
        if (state.pendingChanges > 0) {
          logger.info("Auto-sync: pending changes detected, triggering sync");
          await performSync();
          logger.info("Auto-sync: sync completed");
        } else {
          await db
            .update(syncStateTable)
            .set({ lastSyncAt: new Date() })
            .where(eq(syncStateTable.id, "default"));
          logger.info("Auto-sync: no pending changes, updated lastSyncAt");
        }
      }
    } catch (err) {
      logger.error({ err }, "Auto-sync scheduler error");
    }
  }, CHECK_INTERVAL_MS);

  logger.info("Auto-sync scheduler started (checking every 60s)");
}
