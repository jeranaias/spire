/**
 * Task #136 — Generalised fetch lifecycle for long-lived admin / operator
 * data surfaces (Model Registry / Detail, PULSE Risk Board, SENTRY Review
 * Queue, Audit · SOC).
 *
 * Originally written as `useRegistryFetch` for the supply-chain pages
 * under W1 #83. The same affordances (loadedAt stamp, manual refresh,
 * auto re-fetch on DDIL reconnect, ErrorState retry that re-runs the
 * cold-load path instead of `window.location.reload()`) are required on
 * every long-lived view in the app — anywhere an operator might leave
 * the browser open across a comms drill and come back to a screen full
 * of pre-drill data with no cue.
 *
 * What this hook owns:
 *   - the underlying `withRetry` fetch (so a single transient 5xx /
 *     SATCOM yellow doesn't dead-end the surface and the operator gets
 *     a "Waking…" affordance instead of a hard error);
 *   - a `loadedAt` epoch stamped on every successful fetch — the page
 *     header renders this in operator-local clock time so an analyst
 *     can read freshness without inferring from wall time;
 *   - a `refresh()` callable used by the manual refresh button AND by
 *     the ErrorState retry button — we never reload the whole page,
 *     because that wipes sibling-tab selections, drawer state, and
 *     unsaved scratch;
 *   - an auto re-fetch on DDIL reconnect (the operator flipped back
 *     to CONNECTED — pull a fresh payload without making them click
 *     Refresh);
 *   - cancellation safety: an in-flight response from a previous
 *     `key` (or a previous refresh click) is discarded so it cannot
 *     overwrite the current view.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { withRetry, formatApiError } from "../api-retry";
import { useSpireStore } from "../state/store";

export interface FreshFetchState<T> {
  data: T | null;
  error: string | null;
  waking: boolean;
  loadedAt: number | null;
  refreshing: boolean;
  refresh: () => void;
}

export interface UseFreshFetchOptions {
  /**
   * Skip the fetch entirely while false (defaults to true). Useful when
   * a view's required dependency isn't ready yet — e.g. the SENTRY
   * Review Queue has no processed batch and would otherwise call the
   * batch endpoint with `undefined`, generating a wave of 4xx + retry
   * noise even though the UI is correctly showing an empty-state.
   * When `enabled` flips back to true, the next `key` change (or a
   * `refresh()` call) re-runs the fetch normally.
   */
  enabled?: boolean;
}

/**
 * Fetch + lifecycle wrapper. `fetcher` is a closure that returns a
 * promise to the data; `key` invalidates the cached state when it
 * changes (e.g. the model id on the detail page, or the active batch
 * id + role for the SENTRY review queue). Pass an empty string for
 * views that never re-key.
 */
export function useFreshFetch<T>(
  fetcher: () => Promise<T>,
  key: string,
  options: UseFreshFetchOptions = {},
): FreshFetchState<T> {
  const { enabled = true } = options;
  const ddilMode = useSpireStore((s) => s.ddilMode);

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // The cancellation token guards against late responses overwriting
  // the current view (key change mid-flight, unmount, double-clicks
  // on the refresh button). Bumped on every fresh load attempt; older
  // attempts notice the bump and discard their result.
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

  // Fresh mount / key change. When `enabled` is false we still reset
  // the local state so a previously-loaded payload doesn't linger
  // on screen after the dependency that drives the fetch is cleared
  // (e.g. the operator drops the active SENTRY batch).
  useEffect(() => {
    if (!enabled) {
      epochRef.current++;
      setData(null);
      setError(null);
      setWaking(false);
      setLoadedAt(null);
      setRefreshing(false);
      return;
    }
    void load("initial");
    return () => {
      // Bump the epoch so any in-flight response is discarded.
      epochRef.current++;
    };
    // `load` is stable; keying off `key` + `enabled` is the intended invalidation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  // DDIL reconnect — auto-refresh when the operator flips back to
  // CONNECTED so the surface doesn't keep showing the cached payload
  // from before the drill. We track previous mode in a ref so we
  // don't re-fetch on every render. Guarded by `enabled` so we don't
  // wake up a deliberately-skipped fetch (e.g. a queue with no
  // selected batch) just because the comms posture flipped.
  const prevModeRef = useRef(ddilMode);
  useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = ddilMode;
    if (!enabled) return;
    if (prev !== "CONNECTED" && ddilMode === "CONNECTED") {
      void load("refresh");
    }
  }, [ddilMode, load, enabled]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    void load("refresh");
  }, [load, enabled]);

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
export function formatFreshAge(ageMs: number): string {
  const sec = Math.max(0, Math.floor(ageMs / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin ? `${hr}h ${remMin}m` : `${hr}h`;
}

// Back-compat re-exports — Task #136 renamed the hook + helpers but
// the original W1 #83 names are still used by ModelRegistryView /
// ModelDetailView via the admin/ shim. Keeping these aliases means
// the rename is purely additive on the call-site for views that
// haven't been updated yet.
export { useFreshFetch as useRegistryFetch };
export { formatFreshAge as formatAge };
