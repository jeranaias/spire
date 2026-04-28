/**
 * useIdempotentAction — fat-finger lockout for mutating actions.
 *
 * J4 TORCH: "Marines break things. Show me what happens when an E-3 with mud
 * on the screen taps the wrong button three times in a row." This hook
 * dedups rapid repeats and exposes a single async runner. Triple-tap an
 * ack button: one mutation goes out, the other two are silently swallowed
 * (or surface a toast if the caller asks).
 *
 *   const ack = useIdempotentAction("ack:" + alert.id, () => api.ack(id), {
 *     lockoutMs: 250,        // ignore taps within 250ms of the last
 *     onBlocked: () => pushToast({ tone: "info", text: "Already submitted" }),
 *   });
 *   <Button onClick={ack.run}>Acknowledge</Button>
 *
 * The dedup key is the first argument; if multiple buttons share the same
 * key (e.g. ack-row + ack-modal for the same alert), they are coalesced.
 * Pending state survives the React re-render — `ack.pending` flips true
 * for the duration of the underlying async call so callers can disable
 * the button visually without a separate state slot.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseIdempotentActionOptions {
  /** Tap-window in ms; subsequent taps inside the window no-op. Default 250. */
  lockoutMs?: number;
  /** Called when a tap is suppressed because the lockout window is active or a call is in flight. */
  onBlocked?: () => void;
  /** If true, also block while the previous async call is pending. Default true. */
  blockWhilePending?: boolean;
}

export interface UseIdempotentActionResult<TArgs extends unknown[], TResult> {
  run: (...args: TArgs) => Promise<TResult | undefined>;
  pending: boolean;
}

// Module-level registry — shared across components so two buttons with the
// same key (e.g. row + drawer ack on the same alert) coalesce correctly.
const lastFiredAt = new Map<string, number>();
const inFlight = new Map<string, Promise<unknown>>();

export function useIdempotentAction<TArgs extends unknown[], TResult>(
  key: string,
  fn: (...args: TArgs) => Promise<TResult> | TResult,
  opts: UseIdempotentActionOptions = {},
): UseIdempotentActionResult<TArgs, TResult> {
  const { lockoutMs = 250, onBlocked, blockWhilePending = true } = opts;
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const blockedRef = useRef(onBlocked);
  blockedRef.current = onBlocked;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | undefined> => {
      const now = performance.now();
      const last = lastFiredAt.get(key) ?? 0;
      if (now - last < lockoutMs) {
        blockedRef.current?.();
        return undefined;
      }
      if (blockWhilePending && inFlight.has(key)) {
        blockedRef.current?.();
        return undefined;
      }
      lastFiredAt.set(key, now);
      setPending(true);
      const promise = Promise.resolve()
        .then(() => fnRef.current(...args))
        .finally(() => {
          inFlight.delete(key);
          if (mountedRef.current) setPending(false);
        });
      inFlight.set(key, promise);
      return (await promise) as TResult;
    },
    [key, lockoutMs, blockWhilePending],
  );

  return { run, pending };
}

/**
 * Lower-level helper — for places that don't have a stable component to
 * hang a hook off (event listeners, programmatic dispatch). Same dedup
 * registry, same semantics, no React state.
 */
export function fireIdempotent<T>(
  key: string,
  fn: () => Promise<T> | T,
  lockoutMs = 250,
): Promise<T | undefined> {
  const now = performance.now();
  const last = lastFiredAt.get(key) ?? 0;
  if (now - last < lockoutMs) return Promise.resolve(undefined);
  if (inFlight.has(key)) return Promise.resolve(undefined);
  lastFiredAt.set(key, now);
  const p = Promise.resolve()
    .then(() => fn())
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, p);
  return p as Promise<T | undefined>;
}
