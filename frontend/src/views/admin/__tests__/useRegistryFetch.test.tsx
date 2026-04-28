/**
 * Task #137 — Unit coverage for `useRegistryFetch`'s epoch-token
 * cancellation. The hook is the shared fetch lifecycle behind the Model
 * Registry index AND the per-model detail page; if its cancellation
 * semantics regress the operator can see stale data slip in after a
 * key swap (model switch), a remount, or rapid refresh-button mashing.
 *
 * Pinned behaviors:
 *
 *   1. Key change mid-flight: a fetch in progress for key A is
 *      discarded if `key` swaps to B before A resolves. Only B's
 *      payload appears in `data`.
 *
 *   2. Unmount mid-flight: a fetch in progress at unmount must NOT
 *      reach `setState` — verified by listening for the React 18
 *      "state update on unmounted component" warning.
 *
 *   3. Double refresh: two `refresh()` calls in quick succession with
 *      different fetchers — only the SECOND fetcher's payload wins,
 *      even if the first promise resolves last (real-world race when
 *      the operator double-clicks the ↻ Refresh button).
 *
 * `withRetry` is mocked to a pass-through to remove the back-off
 * schedule from the test surface — the cancellation logic is what
 * we're pinning, not the retry wrapper (covered separately).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

vi.mock("../../../api-retry", () => ({
  // Pass-through — cancellation semantics don't depend on retry timing,
  // and the real `withRetry` would inject 1s+3s+5s back-offs on a
  // rejected promise that we explicitly want to throw to surface error
  // state. The unit under test is the epoch-token machinery.
  withRetry: <T,>(fn: () => Promise<T>) => fn(),
  formatApiError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

vi.mock("../../../state/store", () => ({
  // Tests do not exercise the DDIL reconnect branch — the store's
  // `ddilMode` selector is therefore stubbed to a stable "CONNECTED"
  // value. The reconnect refetch is covered by the Playwright spec.
  useSpireStore: <T,>(selector: (s: { ddilMode: string }) => T): T =>
    selector({ ddilMode: "CONNECTED" }),
}));

// Imported AFTER the vi.mock calls so the hook picks up the mocked
// modules. (vi.mock is hoisted, but importing the test target first
// would still pull in the original `withRetry` in some setups — keep
// the order explicit to match Vitest docs.)
import { useRegistryFetch } from "../useRegistryFetch";

// Tiny "deferred" / promise-with-handles helper. The native promise
// constructor doesn't expose its resolve/reject after the fact, but the
// cancellation tests need to interleave (start, swap key, then resolve
// the dangling promise). This mirrors the `Promise.withResolvers()`
// proposal but works on the Node runtime Vitest uses.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useRegistryFetch — epoch-token cancellation", () => {
  // React 18+ logs `Warning: Can't perform a React state update on an
  // unmounted component` when a setState fires post-unmount. The
  // unmount-mid-flight test asserts this warning is NEVER emitted. To
  // catch it we spy on console.error around each test.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    consoleErrorSpy.mockRestore();
  });

  test("key change mid-flight discards the stale payload", async () => {
    const dA = deferred<{ payload: "A" }>();
    const dB = deferred<{ payload: "B" }>();

    // Each render's fetcher is bound by closure to `currentKey` —
    // simulates how the real ModelDetailView re-binds the fetcher on
    // every model id change. The hook must apply only the in-flight
    // payload that matches the latest epoch.
    let currentKey = "model-A";
    const fetcher = () => (currentKey === "model-A" ? dA.promise : dB.promise);

    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useRegistryFetch(fetcher, key),
      { initialProps: { key: "model-A" } },
    );

    // Initial state — no data, no error, no loadedAt.
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loadedAt).toBeNull();

    // Swap to model B before A's deferred resolves. The hook bumps its
    // epoch counter on the rerender, so when A finally resolves it
    // must be silently dropped.
    currentKey = "model-B";
    rerender({ key: "model-B" });

    // Resolve A first — this is the stale response.
    await act(async () => {
      dA.resolve({ payload: "A" });
      // Yield to micro-task queue so the (discarded) `.then` runs.
      await Promise.resolve();
    });
    expect(result.current.data).toBeNull();

    // Now resolve B — its payload is current and must be applied.
    await act(async () => {
      dB.resolve({ payload: "B" });
    });
    await waitFor(() => expect(result.current.data).toEqual({ payload: "B" }));
    expect(result.current.loadedAt).not.toBeNull();
  });

  test("unmount mid-flight does NOT setState after the response lands", async () => {
    const d = deferred<{ ok: true }>();
    const fetcher = () => d.promise;

    const { unmount } = renderHook(() => useRegistryFetch(fetcher, "key-1"));
    unmount();

    // Late resolve — would otherwise call `setData` on an unmounted
    // component. The hook's epoch bump in the cleanup function should
    // suppress the setState entirely.
    await act(async () => {
      d.resolve({ ok: true });
      await Promise.resolve();
    });

    // No React warning about state updates on unmounted components.
    const warnings = consoleErrorSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .filter((m) => /unmounted component|act\(\)/i.test(m));
    expect(warnings).toEqual([]);
  });

  test("double refresh — only the latest fetcher's payload wins", async () => {
    const d1 = deferred<{ rev: 1 }>();
    const d2 = deferred<{ rev: 2 }>();
    const dInit = deferred<{ rev: 0 }>();

    // Fetcher counter so we can hand out a different deferred per call.
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      if (calls === 1) return dInit.promise;
      if (calls === 2) return d1.promise;
      return d2.promise;
    };

    const { result } = renderHook(() => useRegistryFetch(fetcher, "key-1"));

    // Settle the initial fetch so we have a baseline `loadedAt`.
    await act(async () => {
      dInit.resolve({ rev: 0 });
    });
    await waitFor(() => expect(result.current.data).toEqual({ rev: 0 }));
    const baselineLoadedAt = result.current.loadedAt;

    // Two refresh clicks back-to-back — each bumps the epoch. Resolve
    // them OUT OF ORDER (second click finishes first, first click
    // finishes last) to prove the wrong-payload race is handled by the
    // epoch-token comparison rather than by mere arrival order.
    act(() => {
      result.current.refresh();
      result.current.refresh();
    });
    expect(result.current.refreshing).toBe(true);

    await act(async () => {
      d2.resolve({ rev: 2 });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.data).toEqual({ rev: 2 }));
    expect(result.current.refreshing).toBe(false);

    // Now resolve the older request — its payload must NOT overwrite
    // the latest result, and refreshing must NOT flicker back to true.
    await act(async () => {
      d1.resolve({ rev: 1 });
      await Promise.resolve();
    });
    expect(result.current.data).toEqual({ rev: 2 });
    expect(result.current.refreshing).toBe(false);

    // loadedAt advanced past the baseline.
    expect(result.current.loadedAt).not.toBe(baselineLoadedAt);
  });

  test("refresh after a rejected fetch surfaces error → recovers cleanly", async () => {
    // Bonus pin — the manual ↻ Refresh after an ErrorState retry takes
    // the same code path as the double-refresh test above, but starts
    // from an error rather than a successful baseline. Locks the
    // contract that `error` is cleared once a subsequent fetch
    // succeeds, so the ErrorState-vs-data branch in the view re-flips.
    const dErr = deferred<never>();
    const dOk = deferred<{ ok: true }>();
    let calls = 0;
    const fetcher = () => {
      calls += 1;
      return calls === 1 ? dErr.promise : dOk.promise;
    };

    const { result } = renderHook(() => useRegistryFetch(fetcher, "key-1"));

    await act(async () => {
      dErr.reject(new Error("503 boom"));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.error).toMatch(/503 boom/));
    expect(result.current.data).toBeNull();

    act(() => result.current.refresh());
    await act(async () => {
      dOk.resolve({ ok: true });
    });
    await waitFor(() => expect(result.current.data).toEqual({ ok: true }));
    expect(result.current.error).toBeNull();
  });
});
