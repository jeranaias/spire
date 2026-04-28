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

/**
 * Task #135 — separate "fatal" load failures from "manual refresh failed
 * but we still have a cached payload on screen". The two have different
 * UX consequences:
 *
 *   - `error`         → no cached data, the view collapses to ErrorState.
 *   - `refreshError`  → there IS cached data; we keep rendering it but
 *                       surface a dismissible inline warning so the
 *                       operator doesn't mistake a 10-min-old card for
 *                       the post-Refresh value.
 */
export interface RefreshFailure {
  message: string;
  at: number;
}

export interface RegistryFetchState<T> {
  data: T | null;
  error: string | null;
  waking: boolean;
  loadedAt: number | null;
  refreshing: boolean;
  refresh: () => void;
  refreshError: RefreshFailure | null;
  dismissRefreshError: () => void;
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
  const [refreshError, setRefreshError] = useState<RefreshFailure | null>(null);

  // The cancellation token guards against late responses overwriting the
  // current view (key change mid-flight, unmount, double-clicks on the
  // refresh button). Bumped on every fresh load attempt; older attempts
  // notice the bump and discard their result.
  const epochRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Mirror `data` into a ref so the catch handler below can decide
  // (without a stale closure capture) whether a refresh failure should
  // collapse the view (no cached payload) or surface as an inline
  // dismissible warning (cached payload still on screen).
  const dataRef = useRef<T | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      const myEpoch = ++epochRef.current;
      if (mode === "initial") {
        setData(null);
        dataRef.current = null;
        setError(null);
        setWaking(false);
        setLoadedAt(null);
        setRefreshError(null);
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
        dataRef.current = resp;
        setError(null);
        setWaking(false);
        setLoadedAt(Date.now());
        // Task #135 — a successful refresh clears any prior "refresh
        // failed" warning so the operator isn't left staring at a
        // banner that no longer reflects the on-screen payload.
        setRefreshError(null);
      } catch (e) {
        if (epochRef.current !== myEpoch) return;
        const message = formatApiError(e);
        setWaking(false);
        // Task #135 — if we already have a cached payload on screen,
        // a failed refresh is non-fatal: keep the view, surface the
        // failure inline, and let the operator dismiss it. Without
        // this branch the previous code wrote into `error` but the
        // UI only renders ErrorState when `data` is null, so the
        // failure was effectively silent.
        if (mode === "refresh" && dataRef.current !== null) {
          setRefreshError({ message, at: Date.now() });
        } else {
          setError(message);
        }
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

  const dismissRefreshError = useCallback(() => {
    setRefreshError(null);
  }, []);

  return {
    data,
    error,
    waking,
    loadedAt,
    refreshing,
    refresh,
    refreshError,
    dismissRefreshError,
  };
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
