/**
 * useSamplePolling — shared polling helper for the integrations subpages.
 *
 * Task #166. Task #76 wired up the GCSS-MC integrations page to honor the
 * SATCOM-denial drill — comms-degraded acknowledgement, 30s polling with a
 * countdown that survives a tab-away/return, a clean "re-tap your CAC"
 * panel for 401, and a calm "comms denied · no cache" surface for the
 * DDIL interceptor's structured 0-status response. Every sibling
 * integration page (TC-AIMS-II, MIMMS, AESIP/LMP, GFEBS, ...) needs the
 * same behavior or the moment a presenter flips Comms to LIMITED /
 * INTERMITTENT / DISCONNECTED on those pages, the integrity story breaks.
 *
 * This hook owns:
 *   - the deadline-driven polling loop (interval recomputed from a
 *     wall-clock deadline so the countdown doesn't freeze when the tab
 *     loses focus)
 *   - the four observable states the IntegrationsView already renders
 *     against (idle / auth_required / ddil_no_cache / error)
 *   - a `refreshTick` that bumps on every successful fetch so callers
 *     can flash a "just refreshed" pip without diffing payload bytes
 *   - a `refreshNow` that collapses the deadline to the next animation
 *     frame instead of tearing down the effect
 */
import { useEffect, useRef, useState } from "react";

import { ApiError } from "../api";
import { formatApiError } from "../api-retry";

export type SampleStatus =
  | "idle"
  | "auth_required"
  | "ddil_no_cache"
  | "error";

export interface UseSamplePollingOptions<T> {
  /** Per-call sample fetch. Called immediately on mount, then on the
   * configured cadence. Re-creating the function reference does not
   * restart the loop — the hook captures the latest reference via a
   * ref so the consumer can pass an inline arrow without flooding
   * the network with re-mounts. */
  fetcher: () => Promise<T>;
  /** Polling cadence in seconds. The page is expected to print this
   * value to the operator so it must match what the page advertises. */
  intervalSeconds: number;
  /** Optional dependency list — when one of these changes, the polling
   * loop tears down and re-arms. Use for slug / filter / route param
   * changes. The fetcher reference itself is intentionally NOT in the
   * dependency list (see fetcherRef). */
  deps?: ReadonlyArray<unknown>;
}

export interface UseSamplePollingResult<T> {
  /** Latest successful payload, or null until the first poll lands. On a
   * 401 / DDIL / error after a successful poll, the previous payload is
   * preserved so the operator keeps seeing the last-known slice. */
  data: T | null;
  /** State machine the IntegrationsView already renders against. */
  status: SampleStatus;
  /** Operator-readable error string for the ddil_no_cache and error
   * states. Never the raw `HTTP 4xx: ...` body. */
  errorDetail: string | null;
  /** Wall-clock millisecond deadline of the next scheduled fetch. The
   * countdown ticker reads this each second; surviving across a
   * tab-away/return is the whole point of the wall-clock approach. */
  nextRefreshAt: number;
  /** Bumps every time a fresh poll completes successfully. Lets a
   * subscriber flash "just refreshed" without diffing payload bytes
   * (which are nearly identical poll-to-poll in the synthetic data). */
  refreshTick: number;
  /** Manual refresh — fires the fetch immediately and re-arms the
   * polling deadline from the moment the fetch starts. Used by the
   * "Refresh now" pressable and by the "Try again" button on the
   * ddil_no_cache / error panels. */
  refreshNow: () => void;
}

export function useSamplePolling<T>({
  fetcher,
  intervalSeconds,
  deps = [],
}: UseSamplePollingOptions<T>): UseSamplePollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<SampleStatus>("idle");
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [nextRefreshAt, setNextRefreshAt] = useState<number>(
    () => Date.now() + intervalSeconds * 1000,
  );
  const [refreshTick, setRefreshTick] = useState<number>(0);

  // Hold the fetcher in a ref so callers can pass an inline arrow
  // without retriggering the interval setup on every render. The loop
  // resets only when the explicit `deps` array changes.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // The currently-armed runFetch closure. Stored on a ref so refreshNow
  // can fire the same fetch path the interval fires (and so it can also
  // re-arm the interval), without depending on the effect's lexical
  // scope.
  const runFetchRef = useRef<() => void>(() => {});
  // Handle of the currently-armed setInterval. Stored on a ref so
  // refreshNow can clear it and re-arm — that way the next scheduled
  // poll lands `intervalSeconds` AFTER the manual refresh, not at the
  // original deadline (which would double-fire if the user clicked
  // late in the cycle).
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const runFetch = async () => {
      try {
        const payload = await fetcherRef.current();
        if (cancelled) return;
        setData(payload);
        setStatus("idle");
        setErrorDetail(null);
        setRefreshTick((n) => n + 1);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          // Session expired — surface a clean "re-tap your CAC" panel.
          // Never bleed the raw "HTTP 401: {detail:...}" string into
          // the page (the bug Task #76 fixed for GCSS-MC and Task #166
          // is now generalizing to every sibling integrations page).
          setStatus("auth_required");
          setErrorDetail(null);
        } else if (err instanceof ApiError && err.status === 0) {
          // DDIL interceptor served a structured "no cached data" /
          // "queued for replay" response. Render the comms banner +
          // a calm posture line, not a red 5xx.
          setStatus("ddil_no_cache");
          setErrorDetail(formatApiError(err));
        } else {
          setStatus("error");
          setErrorDetail(formatApiError(err));
        }
      } finally {
        if (!cancelled) {
          setNextRefreshAt(Date.now() + intervalSeconds * 1000);
        }
      }
    };

    runFetchRef.current = runFetch;
    runFetch();
    const handle = window.setInterval(runFetch, intervalSeconds * 1000);
    intervalRef.current = handle;
    return () => {
      cancelled = true;
      window.clearInterval(handle);
      if (intervalRef.current === handle) {
        intervalRef.current = null;
      }
      runFetchRef.current = () => {};
    };
    // intervalSeconds intentionally part of the dep list — flipping
    // cadence at runtime should re-arm the loop. fetcher is captured
    // through the ref so changing it in-place does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalSeconds, ...deps]);

  const refreshNow = () => {
    // Fire the fetch immediately so the operator sees an instant
    // response from "Refresh now" / "Try again", then re-arm the
    // polling interval from this moment so the next scheduled poll
    // lands one full cadence AFTER the manual refresh (not at the
    // original deadline, which would double-fire at the tail of the
    // cycle).
    runFetchRef.current();
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      const handle = window.setInterval(
        runFetchRef.current,
        intervalSeconds * 1000,
      );
      intervalRef.current = handle;
    }
  };

  return {
    data,
    status,
    errorDetail,
    nextRefreshAt,
    refreshTick,
    refreshNow,
  };
}
