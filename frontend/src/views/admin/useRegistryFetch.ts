/**
 * W1 #83 — Shared fetch lifecycle for the Model Registry / Detail surfaces.
 *
 * The supply-chain pages used to fetch once on mount and never tell the
 * operator how stale the view was, never re-fetched on a DDIL reconnect,
 * and the only "Retry" path was a full `window.location.reload()`. This
 * hook centralises:
 *
 *   - the underlying `withRetry` fetch (with the same waking-up affordance);
 *   - a `loadedAt` epoch stamped on every successful fetch (the page header
 *     renders this in operator-local time);
 *   - a `refresh()` callable used by the manual refresh button AND by the
 *     ErrorState retry — no more page reloads;
 *   - an auto re-fetch on DDIL reconnect (the operator flipped back to
 *     CONNECTED — pull a fresh registry without making them click Refresh).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { withRetry, formatApiError } from "../../api-retry";
import { useSpireStore } from "../../state/store";

export interface RegistryFetchState<T> {
  data: T | null;
  error: string | null;
  waking: boolean;
  loadedAt: number | null;
  refreshing: boolean;
  refresh: () => void;
}

/**
 * Fetch + lifecycle wrapper. `fetcher` is a stable closure that returns a
 * promise to the data; `key` invalidates the cached state when it changes
 * (e.g. the model id on the detail page). Pass an empty string for views
 * that never re-key.
 */
export function useRegistryFetch<T>(
  fetcher: () => Promise<T>,
  key: string,
): RegistryFetchState<T> {
  const ddilMode = useSpireStore((s) => s.ddilMode);

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The cancellation token guards against late responses overwriting the
  // current view (key change mid-flight, unmount, double-clicks on the
  // refresh button). Bumped on every fresh load attempt; older attempts
  // notice the bump and discard their result.
  const epochRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      const myEpoch = ++epochRef.current;
      if (mode === "initial") {
        setData(null);
        setError(null);
        setWaking(false);
        setLoadedAt(null);
      } else {
        setRefreshing(true);
      }
      try {
        const resp = await withRetry(() => fetcherRef.current(), {
          onAttempt: (attempt) => {
            if (epochRef.current !== myEpoch) return;
            setWaking(attempt > 1);
          },
        });
        if (epochRef.current !== myEpoch) return;
        setData(resp);
        setError(null);
        setWaking(false);
        setLoadedAt(Date.now());
      } catch (e) {
        if (epochRef.current !== myEpoch) return;
        setError(formatApiError(e));
        setWaking(false);
      } finally {
        if (epochRef.current === myEpoch && mode === "refresh") {
          setRefreshing(false);
        }
      }
    },
    [],
  );

  // Fresh mount / key change.
  useEffect(() => {
    void load("initial");
    return () => {
      // Bump the epoch so any in-flight response is discarded.
      epochRef.current++;
    };
    // `load` is stable; keying off `key` is the intended invalidation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // DDIL reconnect — auto-refresh when the operator flips back to
  // CONNECTED so the supply-chain view doesn't keep showing the cached
  // payload from before the drill. We track previous mode in a ref so
  // we don't re-fetch on every render.
  const prevModeRef = useRef(ddilMode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = ddilMode;
    if (prev !== "CONNECTED" && ddilMode === "CONNECTED") {
      void load("refresh");
    }
  }, [ddilMode, load]);

  const refresh = useCallback(() => {
    void load("refresh");
  }, [load]);

  return { data, error, waking, loadedAt, refreshing, refresh };
}

/** Format an epoch as operator-local clock time (HH:MM:SS, 24h). */
export function formatLoadedAt(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return new Date(ts).toISOString().slice(11, 19);
  }
}

/** Format an age in ms as a compact "n s" / "n min" / "n h" string. */
export function formatAge(ageMs: number): string {
  const sec = Math.max(0, Math.floor(ageMs / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}
