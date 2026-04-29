import { db } from "@workspace/db";
import {
  unitsTable,
  catalogItemsTable,
  supplyEntriesTable,
  supplySnapshotsTable,
  resupplyEventsTable,
} from "@workspace/db";
import { and, eq, lt } from "drizzle-orm";
import {
  adjustedDailyRate,
  type Climate,
  type OpTempo,
  type SupplyClass,
} from "./logistics";
import { logger } from "./logger";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

type SeedSnapshot = {
  unitId: string;
  itemId: string;
  onHand: number;
  personnel: number;
  climate: string;
  opTempo: string;
  missionDays: number;
  source: string;
  actorNote: string | null;
  snapshotAt: Date;
};

/**
 * Backfills `supply_snapshots` rows for (unit, item) pairs that already have
 * supply data and historical resupply events, but no snapshot history.
 *
 * Called once at server startup. Idempotent: skips any (unit, item) pair that
 * already has at least one snapshot, so re-running it is a no-op once data is
 * seeded or once normal planner edits begin generating snapshots organically.
 */
export async function seedSupplyHistoryFromResupplyEvents(): Promise<void> {
  const now = new Date();

  const combos = await db
    .select({
      entry: supplyEntriesTable,
      unit: unitsTable,
      item: catalogItemsTable,
    })
    .from(supplyEntriesTable)
    .innerJoin(unitsTable, eq(supplyEntriesTable.unitId, unitsTable.id))
    .innerJoin(
      catalogItemsTable,
      eq(supplyEntriesTable.itemId, catalogItemsTable.id),
    );

  let pairsSeeded = 0;
  let snapshotsInserted = 0;

  for (const { entry, unit, item } of combos) {
    const existing = await db
      .select({ id: supplySnapshotsTable.id })
      .from(supplySnapshotsTable)
      .where(
        and(
          eq(supplySnapshotsTable.unitId, unit.id),
          eq(supplySnapshotsTable.itemId, item.id),
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;

    const pastEvents = await db
      .select()
      .from(resupplyEventsTable)
      .where(
        and(
          eq(resupplyEventsTable.unitId, unit.id),
          eq(resupplyEventsTable.itemId, item.id),
          lt(resupplyEventsTable.scheduledFor, now),
        ),
      );
    if (pastEvents.length === 0) continue;

    const eventsAsc = [...pastEvents].sort(
      (a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime(),
    );
    const oldestEvent = eventsAsc[0]!;
    const totalDeliveredQty = eventsAsc.reduce((s, e) => s + e.quantity, 0);
    const observedSpanDays = Math.max(
      1,
      (now.getTime() - oldestEvent.scheduledFor.getTime()) / ONE_DAY_MS,
    );

    const doctrinalRate = adjustedDailyRate(
      item.baseDailyRate,
      item.supplyClass as SupplyClass,
      unit.climate as Climate,
      unit.opTempo as OpTempo,
      unit.personnel,
    );

    // Estimate observed burn from delivery cadence assuming approximate
    // steady-state on-hand: total delivered ≈ total consumed over the span.
    const estimatedFromDeliveries = totalDeliveredQty / observedSpanDays;

    // Pick the rate we'll back-fit history with. Prefer the delivery-derived
    // estimate when it's plausible; otherwise fall back to doctrinal.
    const seedRate =
      estimatedFromDeliveries > 0 && Number.isFinite(estimatedFromDeliveries)
        ? estimatedFromDeliveries
        : doctrinalRate;

    const snapshotsToInsert: SeedSnapshot[] = [];
    const baseFields = {
      unitId: unit.id,
      itemId: item.id,
      personnel: unit.personnel,
      climate: unit.climate,
      opTempo: unit.opTempo,
      missionDays: unit.missionDays,
    };

    // Final snapshot anchored at "now" with the actual current on-hand.
    snapshotsToInsert.push({
      ...baseFields,
      onHand: entry.onHand,
      source: "seed_estimate",
      actorNote: "Seeded from resupply event history",
      snapshotAt: now,
    });

    // Walk backwards from now through each past event, generating a pair of
    // snapshots per event: one just after delivery (source=resupply_event,
    // shows the post-delivery on-hand) and one just before delivery
    // (source=seed_estimate, shows the pre-delivery low point). The deltas
    // between consecutive non-resupply snapshots reproduce `seedRate` as the
    // observed burn rate.
    let cursorTime = now.getTime();
    let cursorOnHand = entry.onHand;

    const eventsDesc = [...eventsAsc].reverse();
    for (const ev of eventsDesc) {
      const evTime = ev.scheduledFor.getTime();
      const daysBack = Math.max(0, (cursorTime - evTime) / ONE_DAY_MS);
      const postOnHand = cursorOnHand + seedRate * daysBack;
      const preOnHand = Math.max(0, postOnHand - ev.quantity);

      snapshotsToInsert.push({
        ...baseFields,
        onHand: round2(postOnHand),
        source: "resupply_event",
        actorNote: `Seeded: post-delivery (${ev.quantity} ${ev.unit})`,
        snapshotAt: new Date(evTime + ONE_MINUTE_MS),
      });
      snapshotsToInsert.push({
        ...baseFields,
        onHand: round2(preOnHand),
        source: "seed_estimate",
        actorNote: `Seeded: pre-delivery (${ev.quantity} ${ev.unit})`,
        snapshotAt: new Date(evTime - ONE_MINUTE_MS),
      });

      cursorTime = evTime - ONE_MINUTE_MS;
      cursorOnHand = preOnHand;
    }

    await db.insert(supplySnapshotsTable).values(snapshotsToInsert);
    pairsSeeded += 1;
    snapshotsInserted += snapshotsToInsert.length;
  }

  if (pairsSeeded > 0) {
    logger.info(
      { pairsSeeded, snapshotsInserted },
      "Seeded supply history from resupply events",
    );
  } else {
    logger.info("Supply history seed: nothing to backfill");
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
