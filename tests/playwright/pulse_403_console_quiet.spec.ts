import { test, expect, ConsoleMessage } from "@playwright/test";
import { signIn, gotoHash, SECURITY_MANAGER_DODID } from "./_helpers";

// Task #196: when security_manager (Park) signs in to SPIRE, the
// chrome (TopBar / StatusStrip) polls a number of read endpoints
// every ~30s. PULSE endpoints are role-gated to {maintenance_chief,
// g4, mef_commander}, so each poll for Park returns a backend 403.
// Pre-fix the StatusStrip wrapped both calls in `.catch(() => null)`
// inside a single `pollWithBackoff`, which (a) hid the 403 from the
// poller so it kept ticking and (b) re-issued the request every tick,
// producing 11+ "Failed to load resource: 403" lines per page load.
//
// Fix layers (kept narrow, no client-side preflight gate so the
// backend still audits the denial — Done criterion #3):
//   1. `frontend/src/api-retry.ts` — `isPermissionDenied` predicate +
//      `pollWithBackoff` permanently stops on 403 instead of retrying.
//   2. `frontend/src/components/StatusStrip.tsx` — splits the pulse
//      and bastion fetches into independent pollers and removes the
//      swallowing `.catch(() => null)` so 403 actually propagates to
//      `pollWithBackoff` (which then stops).
//
// The first tick still hits the wire and lets the backend audit the
// denial; subsequent ticks are bounded (one poller stops, the other
// continues) so the console flood is gone and the bastion alert chip
// continues to update.
test("StatusStrip stops polling gated endpoints after one 403 for security_manager", async ({
  page,
}) => {
  const consoleMessages: { type: string; text: string }[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => {
    consoleMessages.push({ type: "pageerror", text: String(err) });
  });

  // Track every gated 403 the page actually receives. After the fix
  // each gated chrome poller should fire ≤ 1 such response per page
  // load (StatusStrip.fleetOverview), so the audit log captures the
  // denial once and pollWithBackoff stops without re-issuing.
  const gated403Responses: string[] = [];
  page.on("response", (resp) => {
    const url = resp.url();
    const isGated =
      url.includes("/api/pulse/") ||
      url.includes("/api/sentry/") ||
      url.includes("/api/system/admin/");
    if (isGated && resp.status() === 403) {
      gated403Responses.push(`${resp.request().method()} ${url}`);
    }
  });

  // Sign in as Park. The default landing for security_manager is the
  // Decision Bridge ("/"), where the TopBar / StatusStrip chrome runs
  // its polling loop — that's where the original symptom appeared.
  await signIn(page, SECURITY_MANAGER_DODID);
  await gotoHash(page, "#/");

  // Park here for ~70s — long enough that the original 30s base poll
  // would have fired 2-3 times if pollWithBackoff hadn't stopped on
  // the first 403. (We pick this window deliberately to surface the
  // re-tick regression if it ever returns.)
  await page.waitForTimeout(70_000);

  // Group 403 responses by URL so we can assert each gated poller
  // hit the backend a small, bounded number of times — not every tick.
  //
  // The bound is ≤ 2 per endpoint, not ≤ 1, because React StrictMode
  // (enabled in `frontend/src/main.tsx`) intentionally mounts every
  // effect twice in dev to surface state-leak bugs. Each independent
  // mount fires its own initial tick before pollWithBackoff sees the
  // 403 and stops, so the steady-state floor in dev is 2. Pre-fix
  // this number grew unbounded over the observation window
  // (11+ for fleet-overview alone, one per 30s tick); post-fix it
  // pins at exactly 2 because the poller stops after its first 403.
  const perEndpoint = new Map<string, number>();
  for (const line of gated403Responses) {
    perEndpoint.set(line, (perEndpoint.get(line) ?? 0) + 1);
  }
  const overBudget = Array.from(perEndpoint.entries()).filter(
    ([, n]) => n > 2,
  );
  if (overBudget.length > 0) {
    console.error(
      "pollWithBackoff failed to stop on 403 for these endpoints:",
      JSON.stringify(overBudget, null, 2),
    );
  }
  expect(
    overBudget,
    "every gated chrome poller must stop after its first 403; > 2 hits per endpoint means it kept ticking",
  ).toEqual([]);

  // The first denial is still audited backend-side (the request DOES
  // reach the wire — Done criterion #3), so we expect ≥1 gated 403
  // for the StatusStrip fleet-overview poller. We also bound the
  // total to catch a future regression that re-introduces a flood.
  // Total ceiling = (# of gated chrome pollers, currently 1: fleet-
  // overview) × 2 (StrictMode), with a small headroom for any other
  // chrome chip that may join later.
  expect(
    gated403Responses.length,
    "first denial reaches backend so audit fires; subsequent ticks must stay bounded",
  ).toBeGreaterThanOrEqual(1);
  if (gated403Responses.length > 6) {
    console.error(
      "Excessive gated 403 traffic across observation window:",
      JSON.stringify(gated403Responses, null, 2),
    );
  }
  expect(
    gated403Responses.length,
    "gated 403 traffic should be a small one-shot per chrome poller, not a flood",
  ).toBeLessThanOrEqual(6);

  // Browser-emitted "Failed to load resource: 403" messages cannot be
  // suppressed from JS, but their count must mirror the bounded
  // network 403 count above. Pre-fix this number was 11+; post-fix
  // it should be ≤ 4 for the same observation window.
  const noisy403 = consoleMessages.filter((m) => {
    const t = m.text.toLowerCase();
    if (!t.includes("403") && !t.includes("failed to load resource")) {
      return false;
    }
    return (
      t.includes("/api/pulse/") ||
      t.includes("/api/sentry/") ||
      t.includes("/api/system/admin/")
    );
  });
  if (noisy403.length > 6) {
    console.error(
      "Console flood of gated 403 messages:",
      JSON.stringify(noisy403, null, 2),
    );
  }
  expect(
    noisy403.length,
    "browser console must not flood with gated 403 noise (cap mirrors network response cap)",
  ).toBeLessThanOrEqual(6);
});
