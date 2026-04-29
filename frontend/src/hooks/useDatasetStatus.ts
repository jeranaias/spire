/**
 * useDatasetStatus — singleton polling hook.
 *
 * Polls /api/system/dataset-status so every top-level view can branch
 * between the populated dashboards and the "awaiting GCSS-MC ingest"
 * empty state.
 *
 * Architecture: a single module-level controller owns the poll, and
 * every React subscriber gets the same value. Without this dedupe, a
 * user who has 4 components consuming the hook (Decision Bridge +
 * PulseView + FleetOverviewTab + SentryView) generates 4× the request
 * volume and the single uvicorn worker collapses under burst load
 * (observed: 8 dataset-status calls per second from one client during
 * navigation). With dedupe, regardless of how many components mount,
 * we make exactly one poll per `POLL_INTERVAL_MS` window.
 *
 * Polling cadence is intentionally slow (20s) — the dataset only flips
 * on a stage-ingest POST or a Shift+F8 reset, and both of those
 * surface immediate refresh()es via the `spire:dataset-reset` event.
 * 20s is fresh-enough for "did someone load data?" without burning
 * backend cycles.
 */
import { useEffect, useState } from "react";

import { api, type DatasetStatus } from "../api";

interface UseDatasetStatusResult {
  status: DatasetStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 20_000;

// Module-level singleton state. All hook callers subscribe.
let _status: DatasetStatus | null = null;
let _loading = true;
let _error: string | null = null;
let _inFlight: Promise<void> | null = null;
let _intervalId: number | null = null;
let _subscriberCount = 0;
const _subscribers = new Set<() => void>();

function notify() {
  _subscribers.forEach((fn) => {
    try {
      fn();
    } catch {
      /* tolerant — one bad subscriber shouldn't kill the rest */
    }
  });
}

function refresh(): Promise<void> {
  if (_inFlight) return _inFlight; // single-flight: coalesce concurrent calls
  _loading = true;
  notify();
  const p = api.system
    .datasetStatus()
    .then((s) => {
      _status = s;
      _error = null;
    })
    .catch((err: unknown) => {
      _error = err instanceof Error ? err.message : String(err);
    })
    .finally(() => {
      _loading = false;
      _inFlight = null;
      notify();
    });
  _inFlight = p;
  return p;
}

function ensureBackgroundPoll() {
  if (_intervalId !== null) return; // already running
  if (typeof window === "undefined") return;
  // First subscriber kicks an immediate fetch (no wait for first tick).
  void refresh();
  _intervalId = window.setInterval(() => {
    void refresh();
  }, POLL_INTERVAL_MS);
  // Window-focus refresh: if the operator alt-tabs back, get fresh
  // status immediately. Listener is added once and lives for the
  // entire session.
  window.addEventListener("focus", () => {
    void refresh();
  });
  // Shift+F8 reset broadcast; same channel.
  window.addEventListener("spire:dataset-reset", () => {
    void refresh();
  });
}

function teardownBackgroundPoll() {
  if (_intervalId === null) return;
  if (typeof window === "undefined") return;
  window.clearInterval(_intervalId);
  _intervalId = null;
}

export function useDatasetStatus(): UseDatasetStatusResult {
  // Subscribe to the singleton. Every component re-renders when the
  // singleton updates — no per-component polling state, no per-component
  // setInterval.
  const [, setTick] = useState(0);

  useEffect(() => {
    const sub = () => setTick((n) => (n + 1) % 1_000_000);
    _subscribers.add(sub);
    _subscriberCount += 1;
    if (_subscriberCount === 1) ensureBackgroundPoll();
    return () => {
      _subscribers.delete(sub);
      _subscriberCount = Math.max(0, _subscriberCount - 1);
      if (_subscriberCount === 0) teardownBackgroundPoll();
    };
  }, []);

  return {
    status: _status,
    loading: _loading,
    error: _error,
    refresh: () => {
      void refresh();
    },
  };
}
