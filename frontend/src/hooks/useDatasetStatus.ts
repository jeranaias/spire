/**
 * useDatasetStatus — Task #183 stage live-ingest mode.
 *
 * Polls /api/system/dataset-status so every top-level view can branch
 * between the populated dashboards and the "awaiting GCSS-MC ingest"
 * empty state. The polling cadence is intentionally slow (5s) — the
 * dataset only flips on a stage-ingest POST or a Shift+F8 reset, both
 * of which the hook surfaces a manual `refresh()` for.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type DatasetStatus } from "../api";

interface UseDatasetStatusResult {
  status: DatasetStatus | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const POLL_INTERVAL_MS = 5_000;

export function useDatasetStatus(): UseDatasetStatusResult {
  const [status, setStatus] = useState<DatasetStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const tickRef = useRef(0);

  const refresh = useCallback(() => {
    tickRef.current += 1;
    const myTick = tickRef.current;
    setLoading(true);
    api.system
      .datasetStatus()
      .then((s) => {
        if (myTick !== tickRef.current) return;
        setStatus(s);
        setError(null);
      })
      .catch((err: unknown) => {
        if (myTick !== tickRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (myTick !== tickRef.current) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, POLL_INTERVAL_MS);
    // Kick a refresh on window-focus so a presenter who alt-tabs back
    // from the curl session sees the hydrated dashboards immediately.
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  return { status, loading, error, refresh };
}
