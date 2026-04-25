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
