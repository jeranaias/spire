/**
 * api-retry unit tests.
 *
 * Pin the "fail visibly after N consecutive poll errors" threshold so a
 * future tweak doesn't silently regress the alert sidebar / fused-threats
 * panel back to the original behaviour (errors only logged to the dev
 * console, no operator-visible signal).
 *
 * Runs under node:test via tsx, no test framework dependency:
 *   npm run test:unit
 *
 * pollWithBackoff calls `window.setTimeout` directly; we shim window so
 * the helper resolves to global setTimeout under node.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// pollWithBackoff uses `window.setTimeout` / `window.clearTimeout`. Stub
// `window` to the global scope so the helper finds them under node.
(globalThis as { window?: typeof globalThis }).window ??= globalThis;

import {
  consecutiveErrorTracker,
  pollWithBackoff,
} from "../../frontend/src/api-retry.ts";

describe("consecutiveErrorTracker", () => {
  it("does not flip offline before the threshold is reached", () => {
    const events: boolean[] = [];
    const t = consecutiveErrorTracker(3, (o) => events.push(o));
    t.onError();
    t.onError();
    assert.deepEqual(events, [], "no transition before threshold");
    assert.equal(t.isOffline(), false);
  });

  it("flips offline once N consecutive errors hit", () => {
    const events: boolean[] = [];
    const t = consecutiveErrorTracker(3, (o) => events.push(o));
    t.onError();
    t.onError();
    t.onError();
    assert.deepEqual(events, [true]);
    assert.equal(t.isOffline(), true);
  });

  it("does not re-fire onChange while already offline", () => {
    const events: boolean[] = [];
    const t = consecutiveErrorTracker(2, (o) => events.push(o));
    t.onError();
    t.onError(); // -> offline
    t.onError();
    t.onError();
    assert.deepEqual(events, [true], "transition fires once, not on every error");
  });

  it("flips back to online on a single successful result", () => {
    const events: boolean[] = [];
    const t = consecutiveErrorTracker(2, (o) => events.push(o));
    t.onError();
    t.onError(); // -> offline
    t.onResult(); // -> online
    assert.deepEqual(events, [true, false]);
    assert.equal(t.isOffline(), false);
  });

  it("a success between errors resets the counter — sub-threshold runs stay quiet", () => {
    const events: boolean[] = [];
    const t = consecutiveErrorTracker(3, (o) => events.push(o));
    t.onError();
    t.onError();
    t.onResult(); // counter -> 0
    t.onError();
    t.onError(); // only 2 consecutive errors, below threshold
    assert.deepEqual(events, [], "sub-threshold runs do not flip offline");
    assert.equal(t.isOffline(), false);
  });

  it("onResult on a tracker that was never offline does not fire onChange", () => {
    const events: boolean[] = [];
    const t = consecutiveErrorTracker(3, (o) => events.push(o));
    t.onResult();
    t.onResult();
    assert.deepEqual(events, []);
  });

  it("reset() returns to online without firing onChange", () => {
    const events: boolean[] = [];
    const t = consecutiveErrorTracker(2, (o) => events.push(o));
    t.onError();
    t.onError(); // -> offline
    assert.deepEqual(events, [true]);
    t.reset();
    assert.equal(t.isOffline(), false);
    assert.deepEqual(events, [true], "reset is silent — no transition fires");
  });

  it("rejects non-positive thresholds", () => {
    assert.throws(() => consecutiveErrorTracker(0, () => {}));
    assert.throws(() => consecutiveErrorTracker(-1, () => {}));
    assert.throws(() => consecutiveErrorTracker(1.5, () => {}));
  });
});

describe("pollWithBackoff", () => {
  it("invokes onError for each rejected poll without stopping", async () => {
    const errors: unknown[] = [];
    const ctrl = pollWithBackoff(
      async () => {
        throw new Error("boom");
      },
      {
        baseMs: 5,
        maxMs: 20,
        onError: (e) => errors.push(e),
      },
    );
    // Wait long enough for several ticks — base 5ms, multiplier 1.5,
    // capped at 20ms. ~120ms gives at least 3-4 invocations.
    await new Promise((r) => setTimeout(r, 120));
    ctrl.stop();
    assert.ok(
      errors.length >= 3,
      `expected at least 3 errors to drive the offline tracker past threshold, got ${errors.length}`,
    );
  });

  it("integrates with consecutiveErrorTracker — N back-to-back failed polls flip offline", async () => {
    const events: boolean[] = [];
    const tracker = consecutiveErrorTracker(3, (o) => events.push(o));
    const ctrl = pollWithBackoff(
      async () => {
        throw new Error("upstream down");
      },
      {
        baseMs: 5,
        maxMs: 20,
        onError: () => tracker.onError(),
      },
    );
    await new Promise((r) => setTimeout(r, 120));
    ctrl.stop();
    assert.deepEqual(events, [true], "tracker flips offline exactly once");
    assert.equal(tracker.isOffline(), true);
  });
});
