import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  syncStateTable,
  syncOutboxTable,
  syncRunsTable,
  activityTable,
  catalogItemsTable,
} from "@workspace/db";
import { eq, desc, or } from "drizzle-orm";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const DEFAULT_ID = "default";

const SPIRE_MDM_URL = (process.env.SPIRE_MDM_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const SPIRE_INGEST_PATH = "/api/mdm/ingest";
const SPIRE_CATALOG_PATH = "/api/mdm/catalog";
const SPIRE_REQUEST_TIMEOUT_MS = 10_000;

type SpireCatalogItem = {
  nsn: string | null;
  name: string;
  unit: string;
  baseDailyRate: number;
  supplyClass: string;
};

type SpirePushOutcome =
  | { success: true; latencyMs: number }
  | { success: false; latencyMs: number; error: string; networkError: boolean };

async function pushRecordToSpire(record: {
  id: string;
  entityKind: string;
  entityId: string;
  unitId: string | null;
  op: string;
  payload: unknown;
}): Promise<SpirePushOutcome> {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${SPIRE_MDM_URL}${SPIRE_INGEST_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        outboxId: record.id,
        entityKind: record.entityKind,
        entityId: record.entityId,
        unitId: record.unitId,
        op: record.op,
        payload: record.payload,
      }),
      signal: AbortSignal.timeout(SPIRE_REQUEST_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) {
      return { success: true, latencyMs };
    }
    let errorMsg = `SPIRE responded ${res.status} ${res.statusText}`.trim();
    try {
      const body = (await res.json()) as Record<string, unknown> | null;
      const detail =
        (body?.error as string | undefined) ??
        (body?.detail as string | undefined) ??
        (body?.message as string | undefined);
      if (detail) errorMsg = `SPIRE ${res.status}: ${detail}`;
    } catch {
      /* response body was not JSON; keep status-based message */
    }
    return { success: false, latencyMs, error: errorMsg, networkError: false };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      latencyMs,
      error: `SPIRE unreachable at ${SPIRE_MDM_URL}: ${msg}`,
      networkError: true,
    };
  }
}

async function fetchSpireCatalog(): Promise<{ items: SpireCatalogItem[]; reachable: boolean; error?: string }> {
  try {
    const res = await fetch(`${SPIRE_MDM_URL}${SPIRE_CATALOG_PATH}`, {
      signal: AbortSignal.timeout(SPIRE_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        items: [],
        reachable: true,
        error: `SPIRE catalog responded ${res.status}`,
      };
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      return { items: [], reachable: true, error: "SPIRE catalog payload was not an array" };
    }
    const items: SpireCatalogItem[] = [];
    for (const raw of body) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const name = typeof r.name === "string" ? r.name : null;
      const unit = typeof r.unit === "string" ? r.unit : null;
      const baseDailyRate =
        typeof r.baseDailyRate === "number"
          ? r.baseDailyRate
          : typeof r.base_daily_rate === "number"
            ? r.base_daily_rate
            : null;
      const supplyClass =
        typeof r.supplyClass === "string"
          ? r.supplyClass
          : typeof r.supply_class === "string"
            ? r.supply_class
            : null;
      const nsn = typeof r.nsn === "string" ? r.nsn : null;
      if (!name || !unit || baseDailyRate === null || !supplyClass) continue;
      items.push({ nsn, name, unit, baseDailyRate, supplyClass });
    }
    return { items, reachable: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { items: [], reachable: false, error: msg };
  }
}

async function ensureRow() {
  const [row] = await db
    .select()
    .from(syncStateTable)
    .where(eq(syncStateTable.id, DEFAULT_ID));
  if (row) {
    if (row.upstreamSystem !== "SPIRE") {
      const [updated] = await db
        .update(syncStateTable)
        .set({ upstreamSystem: "SPIRE" })
        .where(eq(syncStateTable.id, DEFAULT_ID))
        .returning();
      return updated!;
    }
    return row;
  }
  const [created] = await db
    .insert(syncStateTable)
    .values({
      id: DEFAULT_ID,
      upstreamSystem: "SPIRE",
      connected: true,
      lastSyncAt: new Date(),
      pendingChanges: 0,
      latencyMs: 142,
      autoSyncEnabled: true,
      autoSyncIntervalMinutes: 5,
    })
    .returning();
  return created!;
}

async function getPendingCount() {
  const rows = await db
    .select()
    .from(syncOutboxTable)
    .where(eq(syncOutboxTable.status, "pending"));
  return rows.length;
}

function buildStatusResponse(
  row: Awaited<ReturnType<typeof ensureRow>>,
  pending: number,
) {
  return {
    connected: row.connected,
    upstreamSystem: row.upstreamSystem,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    pendingChanges: pending,
    latencyMs: row.latencyMs,
    autoSyncEnabled: row.autoSyncEnabled,
    autoSyncIntervalMinutes: row.autoSyncIntervalMinutes,
  };
}

export async function performSync() {
  const state = await ensureRow();

  const pending = await db
    .select()
    .from(syncOutboxTable)
    .where(eq(syncOutboxTable.status, "pending"));

  const startedAt = new Date();
  let pushedCount = 0;
  let failedCount = 0;
  let totalLatencyMs = 0;
  let pushAttempts = 0;
  let spireReachable = true;
  const results: Array<{
    outboxId: string;
    entityKind: string;
    entityId: string;
    success: boolean;
    error?: string;
    unitName?: string;
    itemName?: string;
  }> = [];

  for (const row of pending) {
    const payload = row.payload as Record<string, unknown> | null;
    const itemName = (payload?.itemName as string) ?? null;
    const unitName = (payload?.unitName as string) ?? null;

    const outcome = await pushRecordToSpire({
      id: row.id,
      entityKind: row.entityKind,
      entityId: row.entityId,
      unitId: row.unitId,
      op: row.op,
      payload: row.payload,
    });
    totalLatencyMs += outcome.latencyMs;
    pushAttempts += 1;

    if (outcome.success) {
      await db
        .update(syncOutboxTable)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(syncOutboxTable.id, row.id));
      pushedCount++;
      results.push({
        outboxId: row.id,
        entityKind: row.entityKind,
        entityId: row.entityId,
        success: true,
        unitName: unitName ?? undefined,
        itemName: itemName ?? undefined,
      });
    } else {
      if (outcome.networkError) spireReachable = false;
      await db
        .update(syncOutboxTable)
        .set({ status: "failed", lastError: outcome.error })
        .where(eq(syncOutboxTable.id, row.id));
      failedCount++;
      results.push({
        outboxId: row.id,
        entityKind: row.entityKind,
        entityId: row.entityId,
        success: false,
        error: outcome.error,
        unitName: unitName ?? undefined,
        itemName: itemName ?? undefined,
      });
    }
  }

  const catalogStartedAt = Date.now();
  const spireCatalogResult = await fetchSpireCatalog();
  const catalogLatencyMs = Date.now() - catalogStartedAt;
  if (!spireCatalogResult.reachable) {
    spireReachable = false;
    logger.warn(
      { url: SPIRE_MDM_URL, error: spireCatalogResult.error },
      "SPIRE catalog fetch failed during sync",
    );
  } else if (spireCatalogResult.error) {
    logger.warn(
      { url: SPIRE_MDM_URL, error: spireCatalogResult.error },
      "SPIRE catalog returned an error during sync",
    );
  }

  const localCatalog = await db.select().from(catalogItemsTable);
  let catalogMatched = 0;
  let catalogNew = 0;
  let catalogChanged = 0;

  for (const spireItem of spireCatalogResult.items) {
    const local = localCatalog.find(
      (l) =>
        (spireItem.nsn !== null && l.nsn === spireItem.nsn) ||
        l.name.toLowerCase() === spireItem.name.toLowerCase(),
    );
    if (!local) {
      catalogNew++;
    } else {
      const namesDiffer = local.name.toLowerCase() !== spireItem.name.toLowerCase();
      const nsnDiffers = (local.nsn ?? "") !== (spireItem.nsn ?? "");
      const ratesDiffer = Math.abs(local.baseDailyRate - spireItem.baseDailyRate) > 0.001;
      if (namesDiffer || nsnDiffers || ratesDiffer) {
        catalogChanged++;
      } else {
        catalogMatched++;
      }
    }
  }

  const finishedAt = new Date();
  const observedLatencyMs = pushAttempts > 0
    ? Math.round(totalLatencyMs / pushAttempts)
    : catalogLatencyMs;
  const latency = Math.max(observedLatencyMs, 1);

  const [syncRun] = await db
    .insert(syncRunsTable)
    .values({
      startedAt,
      finishedAt,
      pushedCount,
      failedCount,
      catalogMatched,
      catalogNew,
      catalogChanged,
      latencyMs: latency,
      results,
    })
    .returning();

  const remainingPending = await getPendingCount();

  await db
    .update(syncStateTable)
    .set({
      lastSyncAt: finishedAt,
      pendingChanges: remainingPending,
      connected: spireReachable,
      latencyMs: latency,
    })
    .where(eq(syncStateTable.id, DEFAULT_ID));

  const activityMessage = spireReachable
    ? `Synced with SPIRE (${SPIRE_MDM_URL}) — pushed ${pushedCount}, failed ${failedCount}, catalog delta: +${catalogNew} new, ${catalogChanged} changed (${latency}ms)`
    : `SPIRE unreachable at ${SPIRE_MDM_URL} — pushed ${pushedCount}, failed ${failedCount} (records remain queued in outbox for retry)`;

  await db.insert(activityTable).values({
    kind: "sync_completed",
    message: activityMessage,
  });

  return {
    connected: spireReachable,
    upstreamSystem: state.upstreamSystem,
    lastSyncAt: finishedAt.toISOString(),
    pendingChanges: remainingPending,
    latencyMs: latency,
    autoSyncEnabled: state.autoSyncEnabled,
    autoSyncIntervalMinutes: state.autoSyncIntervalMinutes,
    syncRunId: syncRun?.id,
  };
}

router.get("/sync/status", async (_req, res) => {
  const row = await ensureRow();
  const pending = await getPendingCount();
  res.json(buildStatusResponse(row, pending));
});

router.post("/sync/status", async (_req, res) => {
  const result = await performSync();
  res.json(result);
});

router.patch("/sync/settings", async (req, res) => {
  const body = req.body as { autoSyncEnabled?: boolean; autoSyncIntervalMinutes?: number };

  const updates: Record<string, unknown> = {};
  if (typeof body.autoSyncEnabled === "boolean") {
    updates.autoSyncEnabled = body.autoSyncEnabled;
  }
  if (typeof body.autoSyncIntervalMinutes === "number" && body.autoSyncIntervalMinutes >= 1) {
    updates.autoSyncIntervalMinutes = body.autoSyncIntervalMinutes;
  }

  await ensureRow();

  const [updated] = await db
    .update(syncStateTable)
    .set(updates)
    .where(eq(syncStateTable.id, DEFAULT_ID))
    .returning();

  const pending = await getPendingCount();
  res.json(buildStatusResponse(updated!, pending));
});

router.get("/sync/outbox", async (_req, res) => {
  const rows = await db
    .select()
    .from(syncOutboxTable)
    .where(or(eq(syncOutboxTable.status, "pending"), eq(syncOutboxTable.status, "failed")));

  res.json(
    rows.map((row) => {
      const payload = row.payload as Record<string, unknown> | null;
      return {
        id: row.id,
        entityKind: row.entityKind,
        entityId: row.entityId,
        unitId: row.unitId,
        op: row.op,
        createdAt: row.createdAt.toISOString(),
        status: row.status,
        lastError: row.lastError,
        itemName: (payload?.itemName as string) ?? null,
        unitName: (payload?.unitName as string) ?? null,
      };
    }),
  );
});

router.get("/sync/runs", async (_req, res) => {
  const rows = await db
    .select()
    .from(syncRunsTable)
    .orderBy(desc(syncRunsTable.startedAt));

  res.json(
    rows.map((run) => ({
      id: run.id,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      pushedCount: run.pushedCount,
      failedCount: run.failedCount,
      catalogMatched: run.catalogMatched,
      catalogNew: run.catalogNew,
      catalogChanged: run.catalogChanged,
      latencyMs: run.latencyMs,
      results: run.results ?? [],
    })),
  );
});

router.delete("/sync/outbox/:id", async (req, res) => {
  const { id } = req.params;
  const [existing] = await db
    .select()
    .from(syncOutboxTable)
    .where(eq(syncOutboxTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Record not found" });
    return;
  }

  await db.delete(syncOutboxTable).where(eq(syncOutboxTable.id, id));
  res.status(204).send();
});

router.post("/sync/outbox/:id/retry", async (req, res) => {
  const { id } = req.params;
  const [existing] = await db
    .select()
    .from(syncOutboxTable)
    .where(eq(syncOutboxTable.id, id));

  if (!existing) {
    res.status(404).json({ error: "Record not found" });
    return;
  }

  const [updated] = await db
    .update(syncOutboxTable)
    .set({ status: "pending", lastError: null })
    .where(eq(syncOutboxTable.id, id))
    .returning();

  const payload = updated!.payload as Record<string, unknown> | null;
  res.json({
    id: updated!.id,
    entityKind: updated!.entityKind,
    entityId: updated!.entityId,
    unitId: updated!.unitId,
    op: updated!.op,
    createdAt: updated!.createdAt.toISOString(),
    status: updated!.status,
    lastError: updated!.lastError,
    itemName: (payload?.itemName as string) ?? null,
    unitName: (payload?.unitName as string) ?? null,
  });
});

router.get("/sync/last-run", async (_req, res) => {
  const rows = await db
    .select()
    .from(syncRunsTable)
    .orderBy(desc(syncRunsTable.startedAt))
    .limit(1);

  if (rows.length === 0) {
    res.status(204).send();
    return;
  }

  const run = rows[0]!;
  res.json({
    id: run.id,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    pushedCount: run.pushedCount,
    failedCount: run.failedCount,
    catalogMatched: run.catalogMatched,
    catalogNew: run.catalogNew,
    catalogChanged: run.catalogChanged,
    latencyMs: run.latencyMs,
    results: run.results ?? [],
  });
});

export default router;
