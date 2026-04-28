/**
 * Shared DDIL queue-drain entry point.
 *
 * Task #163 — the new global DDIL desync banner ("Replay Now") and the
 * existing CommsControl popover both need to drain the queued-writes
 * tray and surface progress in the same SyncingOverlay. They used to
 * each own their own copy of that loop, which would have meant either
 * cross-importing CommsControl (a heavy chrome component) from the
 * banner, or duplicating the replay logic. This module is the shared
 * implementation; both callers go through it.
 *
 * Idempotent: if a drain is already in flight (`ddilSyncing` is true)
 * the call returns immediately so a fast double-click can't run two
 * drains in parallel and corrupt the queue.
 */
import { replayQueuedWrite } from "../api";
import { formatApiError } from "../api-retry";
import { useSpireStore } from "./store";

export interface DrainOptions {
  // SyncingOverlay reads "drain total" from a setter so the progress
  // bar shows real done/total — the live ddilQueue.length shrinks as
  // we drain, so passing it through every render makes the bar stick
  // at 0%. Optional — only the CommsControl popover needs this; the
  // global banner doesn't render its own overlay.
  setDrainTotal?: (n: number) => void;
}

export async function drainDdilQueue(opts: DrainOptions = {}): Promise<void> {
  const store = useSpireStore.getState();
  if (store.ddilSyncing) return;
  const queue = store.ddilQueue;
  if (queue.length === 0) return;

  opts.setDrainTotal?.(queue.length);
  store.setDdilSyncing(true);
  let succeeded = 0;
  let failed = 0;
  for (const w of queue) {
    try {
      await replayQueuedWrite({ method: w.method, path: w.path, body: w.body });
      succeeded += 1;
      useSpireStore.getState().removeDdilWrite(w.id);
      // Visible per-write replay beat — keeps the overlay from blinking
      // past for short queues.
      await new Promise((r) => setTimeout(r, 220));
    } catch (e) {
      failed += 1;
      useSpireStore.getState().removeDdilWrite(w.id);
      // eslint-disable-next-line no-console
      console.warn(`[ddil] replay failed for ${w.method} ${w.path}:`, formatApiError(e));
    }
  }
  const finalState = useSpireStore.getState();
  finalState.setDdilSyncing(false);
  finalState.setDdilLastSyncAt(Date.now());
  if (succeeded > 0 && failed === 0) {
    finalState.pushToast({
      tone: "ok",
      text: `All caught up — ${succeeded} queued write${succeeded === 1 ? "" : "s"} replayed in order`,
      ttlMs: 4500,
    });
  } else if (succeeded > 0 && failed > 0) {
    finalState.pushToast({
      tone: "warn",
      text: `Replay partial — ${succeeded} applied, ${failed} failed (see console)`,
      ttlMs: 5500,
    });
  } else if (failed > 0) {
    finalState.pushToast({
      tone: "error",
      text: `Replay failed — ${failed} queued write${failed === 1 ? "" : "s"} could not be applied`,
      ttlMs: 5500,
    });
  }
}
