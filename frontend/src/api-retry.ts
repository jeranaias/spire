/**
 * api-retry — exponential-backoff retry wrapper for transient 5xx failures.
 *
 * Closes #14 (Safari cold-start trap). Fly's machines auto-suspend; the first
 * request after wake gets a 502/503 while the machine spins up. Without this
 * helper the BastionView/AdminView fetches return a single rejected promise,
 * the spinner sticks indefinitely, and the operator thinks the system is down.
 *
 * Default schedule: 3 attempts at 1s / 3s / 5s after the initial try (so up to
 * 4 calls total). Only retries on 5xx and network errors — 4xx is operator
 * error or auth and shouldn't be hammered.
 *
 * The optional `onAttempt` callback fires before each retry so the caller can
 * surface a "Waking up — one moment" state instead of an indefinite spinner.
 */

const DEFAULT_BACKOFFS_MS = [1000, 3000, 5000];

export interface RetryOptions {
  backoffsMs?: number[];
  onAttempt?: (attempt: number, total: number) => void;
}

/** Heuristic: was this a 5xx or transport error worth retrying? */
function isTransient(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // jsonFetch throws "<status> <statusText>: ..." for non-2xx.
  if (/^5\d\d\b/.test(msg)) return true;
  // Network failure (CORS / offline / connection reset) shows up as TypeError
  // with "Failed to fetch" in Chrome / "Load failed" in Safari.
  if (/Failed to fetch|Load failed|NetworkError|ECONN/i.test(msg)) return true;
  return false;
}

/**
 * Run `fn` with up to N retries on transient errors. Each attempt index passed
 * to `onAttempt` is 1-based; total includes the initial try.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const backoffs = opts.backoffsMs ?? DEFAULT_BACKOFFS_MS;
  const total = backoffs.length + 1;

  let lastErr: unknown;
  for (let i = 0; i <= backoffs.length; i++) {
    try {
      opts.onAttempt?.(i + 1, total);
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i >= backoffs.length || !isTransient(err)) break;
      await new Promise((r) => setTimeout(r, backoffs[i]));
    }
  }
  throw lastErr;
}

export interface PollControl {
  /** Stop the poller. Safe to call multiple times. */
  stop: () => void;
}

export interface PollOptions<T> {
  /** Base interval in ms (also the floor when the response changes). Default 5000. */
  baseMs?: number;
  /** Cap interval in ms. Default 60000. */
  maxMs?: number;
  /** Multiplier applied each tick when the response is unchanged. Default 1.5. */
  multiplier?: number;
  /** Called on every successful fetch. */
  onResult?: (value: T) => void;
  /** Called on errors (non-fatal — keeps polling). */
  onError?: (err: unknown) => void;
  /**
   * Optional fingerprint extractor — by default we JSON.stringify the value.
   * Provide a custom one if your payload has volatile timestamps you want
   * to ignore so the back-off can still kick in on real data parity.
   */
  fingerprint?: (value: T) => string;
}

/**
 * Polling helper with exponential back-off when the response is identical to
 * the previous response. Reviewer caught StatusFooter, NodeStatus, BastionView
 * each polling every 4-5s on the same endpoints — ~10 GET/sec to the worker
 * across the page. With identical-response back-off the steady-state load
 * drops to ~3 GET/min, snapping back to base when something changes.
 *
 * Schedule (default base=5000, max=60000, mult=1.5):
 *   identical → 5s, 7.5s, 11.25s, 16.9s, 25.3s, 38s, 57s, 60s, 60s ...
 *   on change → snap back to base (5s).
 */
export function pollWithBackoff<T>(
  fn: () => Promise<T>,
  opts: PollOptions<T> = {},
): PollControl {
  const base = opts.baseMs ?? 5000;
  const cap = opts.maxMs ?? 60000;
  const mult = opts.multiplier ?? 1.5;
  const fp = opts.fingerprint ?? ((v: T) => {
    try { return JSON.stringify(v); } catch { return String(v); }
  });

  let interval = base;
  let lastFp: string | null = null;
  let stopped = false;
  let timer: number | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const v = await fn();
      if (stopped) return;
      const f = fp(v);
      if (lastFp !== null && f === lastFp) {
        interval = Math.min(Math.round(interval * mult), cap);
      } else {
        interval = base;
      }
      lastFp = f;
      opts.onResult?.(v);
    } catch (err) {
      // Errors don't reset the back-off — a steadily-failing endpoint should
      // back off too, not hammer.
      interval = Math.min(Math.round(interval * mult), cap);
      opts.onError?.(err);
    }
    if (stopped) return;
    timer = window.setTimeout(tick, interval);
  };

  // Kick off immediately — first call is on-mount.
  tick();

  return {
    stop: () => {
      stopped = true;
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/**
 * formatApiError — turn a thrown api error into operator-readable copy.
 *
 * Walkthrough audit: setError(String(e)) was leaking raw nginx 502 HTML
 * into UI panels — operators saw <html><head><title>502 Bad Gateway in
 * the error message. This helper strips HTML and recognises common
 * upstream error states, returning a posture line instead.
 */
export function formatApiError(err: unknown, fallback?: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/<html|Bad Gateway|Gateway Time-?out|nginx/i.test(raw)) {
    return fallback ?? "Backend reconnecting — view will refresh shortly.";
  }
  if (/Failed to fetch|NetworkError|ERR_NETWORK/i.test(raw)) {
    return "Network error — check connection and retry.";
  }
  // Trim long error strings to a reasonable length
  return raw.length > 140 ? raw.slice(0, 140) + "…" : raw;
}
