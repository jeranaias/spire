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

const router: IRouter = Router();

const DEFAULT_ID = "default";

const SPIRE_FAILURE_REASONS = [
  "SPIRE rejected: NSN not in master catalog",
  "SPIRE timeout",
  "SPIRE validation: quantity out of range",
];

const MOCK_SPIRE_CATALOG = [
  { nsn: "8970-00-149-1094", name: "MRE Case (12-pack)", unit: "case", baseDailyRate: 0.5, supplyClass: "I" },
  { nsn: "8970-00-926-3603", name: "Water, Bottled (24-pack)", unit: "case", baseDailyRate: 2.0, supplyClass: "I" },
  { nsn: "9130-00-252-1786", name: "MOGAS (JP-8)", unit: "gallon", baseDailyRate: 50.0, supplyClass: "III" },
  { nsn: "9130-01-515-5011", name: "Diesel Fuel DF-2", unit: "gallon", baseDailyRate: 35.0, supplyClass: "III" },
  { nsn: "9150-01-354-0391", name: "Engine Oil, OE/HDO 15W-40", unit: "quart", baseDailyRate: 2.5, supplyClass: "III" },
  { nsn: "9150-00-402-4478", name: "Grease, Automotive/Artillery", unit: "lb", baseDailyRate: 0.8, supplyClass: "III" },
  { nsn: "1305-00-028-5521", name: "5.56mm Ball Ammunition", unit: "round", baseDailyRate: 120.0, supplyClass: "V" },
  { nsn: "1310-01-411-7867", name: "40mm HE Grenade", unit: "round", baseDailyRate: 12.0, supplyClass: "V" },
  { nsn: "1330-01-208-5004", name: "Hand Grenade, Fragmentation M67", unit: "each", baseDailyRate: 4.0, supplyClass: "V" },
  { nsn: "6505-01-386-7461", name: "IV Solution, NS 1L", unit: "bag", baseDailyRate: 1.5, supplyClass: "VIII" },
  { nsn: "6515-00-985-7465", name: "Bandage, Gauze 4-inch", unit: "each", baseDailyRate: 3.0, supplyClass: "VIII" },
  { nsn: "6510-00-201-7425", name: "Tourniquet, Combat Application (CAT)", unit: "each", baseDailyRate: 0.2, supplyClass: "VIII" },
  { nsn: "2530-01-394-5861", name: "Tire, HMMWV", unit: "each", baseDailyRate: 0.05, supplyClass: "IX" },
  { nsn: "2910-00-186-6482", name: "Filter, Engine Oil", unit: "each", baseDailyRate: 0.1, supplyClass: "IX" },
  { nsn: "2530-00-001-3085", name: "Battery, Lead Acid 12V", unit: "each", baseDailyRate: 0.03, supplyClass: "IX" },
  { nsn: "8340-01-060-6897", name: "Tent, Squad (MGPTS)", unit: "each", baseDailyRate: 0.01, supplyClass: "I" },
  { nsn: "8415-01-093-9485", name: "MOPP Suit, M40", unit: "each", baseDailyRate: 0.05, supplyClass: "VIII" },
  { nsn: "4240-01-100-2364", name: "Mask, Protective, Field M40A1", unit: "each", baseDailyRate: 0.02, supplyClass: "VIII" },
  { nsn: "1005-00-856-2320", name: "Cleaning Kit, M4 Carbine", unit: "kit", baseDailyRate: 0.01, supplyClass: "IX" },
  { nsn: "9140-00-286-5968", name: "Hydraulic Fluid, MIL-PRF-5606", unit: "gallon", baseDailyRate: 0.5, supplyClass: "III" },
];

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
  const baseLatency = 90 + Math.floor(Math.random() * 180);
  let pushedCount = 0;
  let failedCount = 0;
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

    const successRate = 0.85 + Math.random() * 0.1;
    const didSucceed = Math.random() < successRate;

    if (didSucceed) {
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
      const reason = SPIRE_FAILURE_REASONS[Math.floor(Math.random() * SPIRE_FAILURE_REASONS.length)];
      await db
        .update(syncOutboxTable)
        .set({ status: "failed", lastError: reason })
        .where(eq(syncOutboxTable.id, row.id));
      failedCount++;
      results.push({
        outboxId: row.id,
        entityKind: row.entityKind,
        entityId: row.entityId,
        success: false,
        error: reason,
        unitName: unitName ?? undefined,
        itemName: itemName ?? undefined,
      });
    }
  }

  const localCatalog = await db.select().from(catalogItemsTable);
  let catalogMatched = 0;
  let catalogNew = 0;
  let catalogChanged = 0;

  for (const spireItem of MOCK_SPIRE_CATALOG) {
    const local = localCatalog.find(
      (l) => l.nsn === spireItem.nsn || l.name.toLowerCase() === spireItem.name.toLowerCase(),
    );
    if (!local) {
      catalogNew++;
    } else {
      const namesDiffer = local.name.toLowerCase() !== spireItem.name.toLowerCase();
      const nsnDiffers = (local.nsn ?? "") !== spireItem.nsn;
      const ratesDiffer = Math.abs(local.baseDailyRate - spireItem.baseDailyRate) > 0.001;
      if (namesDiffer || nsnDiffers || ratesDiffer) {
        catalogChanged++;
      } else {
        catalogMatched++;
      }
    }
  }

  const finishedAt = new Date();
  const latency = baseLatency + pending.length * 8;

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
      connected: true,
      latencyMs: latency,
    })
    .where(eq(syncStateTable.id, DEFAULT_ID));

  await db.insert(activityTable).values({
    kind: "sync_completed",
    message: `Synced with SPIRE — pushed ${pushedCount}, failed ${failedCount}, catalog delta: +${catalogNew} new, ${catalogChanged} changed (${latency}ms)`,
  });

  return {
    connected: true,
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
