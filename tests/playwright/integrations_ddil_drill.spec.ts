/**
 * Task #167 — End-to-end regression for the comms-denial (DDIL) drill on
 * the GCSS-MC integrations page.
 *
 * The drill is a load-bearing demo story: an operator flips the topbar
 * comms switcher to DISCONNECTED and every page that polls upstream
 * acknowledges it (banner + cached-data fallback) instead of leaking a
 * raw fetch failure.  Today the only verification is manual + type-check;
 * nothing fails CI if a future change reverts a page back to a raw fetch
 * and silently breaks the drill.  Task #76's runTest pass was blocked by
 * a Replit dev-preview proxy quirk, so no automated regression existed
 * before this spec.
 *
 * Three guarantees are locked down here, each as its own test so a
 * failure points straight at the broken contract:
 *
 *   1. The polling-cadence row (`integrations-refresh-cadence`) renders
 *      with the documented 30s cadence and a live "next refresh in N s"
 *      countdown.  If a future refactor drops the row or the countdown,
 *      the page stops being honest about how stale its data is.
 *
 *   2. Flipping the topbar comms switcher to DISCONNECTED surfaces the
 *      `integrations-comms-banner` within one second of the click.  If
 *      a future refactor removes the store subscription or hard-codes a
 *      "CONNECTED" assumption, the page stops acknowledging the drill.
 *
 *   3. A forged 401 from the sample endpoint surfaces the in-page
 *      "re-tap your CAC" panel with a working link to `/auth` instead
 *      of leaking a raw HTTP status string into the layout.  Stage mode
 *      is enabled so the global `UnauthenticatedBridge` does not bounce
 *      the page to /auth before the in-page safety-net panel can render.
 */
import { test, expect } from "@playwright/test";
import { signIn, gotoHash } from "./_helpers";

const SAMPLE_ENDPOINT_GLOB = "**/api/integrations/gcss-mc/sample**";

test.describe("Task #167 — DDIL drill regression on /integrations/gcss-mc", () => {
  test("polling-cadence row + countdown render with the documented 30s cadence", async ({
    page,
  }) => {
    await signIn(page);
    await gotoHash(page, "#/integrations/gcss-mc");

    const cadence = page.getByTestId("integrations-refresh-cadence");
    await expect(cadence).toBeVisible({ timeout: 10_000 });
    // The text contract the page advertises in PollingCadenceSection — a
    // 30-second nominal cadence — must be visible in the cadence row,
    // not buried in a tooltip or a secondary card.
    await expect(cadence).toContainText(/Polling cadence\s*·\s*30s/i);
    // Live countdown surface — without this the operator has no signal
    // that the page is honoring its own refresh contract. Match the
    // tabular-nums seconds counter that ticks once per second.
    await expect(cadence).toContainText(/next refresh in\s*\d+\s*s/i);
  });

  test("topbar comms switcher → DISCONNECTED surfaces the comms-degraded banner within 1s", async ({
    page,
  }) => {
    await signIn(page);
    await gotoHash(page, "#/integrations/gcss-mc");

    const cadence = page.getByTestId("integrations-refresh-cadence");
    await expect(cadence).toBeVisible({ timeout: 10_000 });
    // Banner must NOT be present before the operator flips the switch
    // (CONNECTED is the steady-state and the banner returns null then).
    await expect(page.getByTestId("integrations-comms-banner")).toHaveCount(0);

    // Open the topbar DDIL switcher (the chip's accessible name is
    // "Comms <state> — DDIL switcher", regardless of the active mode).
    const switcherChip = page.getByRole("button", {
      name: /Comms .* DDIL switcher/i,
    });
    await switcherChip.waitFor({ state: "visible", timeout: 5_000 });
    await switcherChip.click();

    // The spec says "within one second of the flip". Playwright's
    // `toBeVisible({ timeout: 1_000 })` is the contract assertion:
    // it polls until the banner is on-screen and fails if it takes
    // longer than 1s after the click resolves.  We deliberately do
    // NOT wall-clock from before-the-click to after-the-assertion —
    // that interval includes Playwright's own click-action overhead
    // (scroll-into-view, hover, dispatch) which a real operator
    // never pays, and on a busy CI host that overhead alone can
    // exceed the 1s contract budget while the actual UI response
    // is still snappy.
    const discButton = page
      .getByRole("button", { name: /Disconnected/i })
      .filter({ has: page.locator("text=DISC") });
    await discButton.waitFor({ state: "visible", timeout: 5_000 });
    await discButton.click();

    const banner = page.getByTestId("integrations-comms-banner");
    await expect(banner).toBeVisible({ timeout: 1_000 });

    // The banner must say what is actually happening — a generic chip
    // is not enough.  Lock the DISCONNECTED copy contract so a future
    // i18n/refactor that swallows the headline still fails the drill.
    await expect(banner).toContainText(/Comms degraded · DDIL drill engaged/i);
    await expect(banner).toContainText(/DISCONNECTED/i);
  });

  test("forged 401 from the sample endpoint surfaces the re-tap your CAC panel with a working /auth link", async ({
    page,
  }) => {
    // Stage mode keeps the operator on the page when the API client
    // raises a 401 (the global UnauthenticatedBridge surfaces a toast
    // instead of bouncing to /auth).  Without stage mode, the bridge
    // would unmount the IntegrationsView before its in-page safety-net
    // panel had a chance to render — losing the very surface this test
    // is trying to lock down.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("spire.stageMode", "1");
      } catch {
        /* private mode tolerant */
      }
    });

    // Forge the 401 BEFORE the page fetches the sample slice on mount,
    // so the very first poll trips the auth_required branch and the
    // page never paints a "happy path" state we'd then have to wait
    // out the 30s cadence to invalidate.
    await page.route(SAMPLE_ENDPOINT_GLOB, (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "unauthenticated",
          detail: "session expired or missing (forged by Task #167 spec)",
        }),
      }),
    );

    await signIn(page);
    await gotoHash(page, "#/integrations/gcss-mc");

    // The cadence row should still render — the 401 is a per-fetch
    // failure, not a page-level crash. Lock that down so a future
    // ErrorBoundary swap doesn't blank the surface.
    const cadence = page.getByTestId("integrations-refresh-cadence");
    await expect(cadence).toBeVisible({ timeout: 10_000 });

    // The in-page safety-net panel renders a clean "Session expired"
    // headline + a re-tap CTA.  Match on the panel-only description
    // copy ("…to resume the GCSS-MC sample fetch") so the assertion
    // doesn't collide with the stage-mode toast, which also uses the
    // phrase "Session expired" but a different second clause.  The
    // raw "HTTP 401: ..." string must NOT bleed into the layout —
    // that's the regression P1-6 originally landed against.
    await expect(
      page.getByText(/Re-tap your CAC to resume the GCSS-MC sample fetch/i),
    ).toBeVisible({ timeout: 5_000 });
    // Headline contract — scoped to the panel via its sibling link so
    // the multi-match toast variant is excluded.
    const panelAlert = page
      .locator('[role="alert"]')
      .filter({ hasText: /Re-tap your CAC to resume the GCSS-MC sample fetch/i });
    await expect(panelAlert).toContainText(/Session expired/i);
    await expect(page.locator("body")).not.toContainText(/HTTP 401/i);

    // The CTA must navigate to /auth — under HashRouter that means
    // the link's href ends with `#/auth`, and clicking it lands the
    // location hash there.  Both are asserted: the href contract
    // protects against a copy-paste drift and the click protects
    // against a stale router config.
    const reTapLink = page.getByRole("link", { name: /Re-tap CAC/i });
    await expect(reTapLink).toBeVisible();
    await expect(reTapLink).toHaveAttribute("href", /#\/auth$/);
    // Click + assert the route leaves the integrations page.  We do
    // NOT assert the URL lands precisely at `#/auth` — under stage
    // mode the session cookie survives the forged 401, so AuthView's
    // own "already signed in" effect immediately bounces the
    // operator off `/auth` to the role default (the Decision Bridge
    // at `#/`).  That's the *correct* product behavior; what this
    // test cares about is that the link is a real router target and
    // the click changes the route, not a dead `<a href>` glued onto
    // the panel.
    await reTapLink.scrollIntoViewIfNeeded();
    await reTapLink.click();
    await page.waitForFunction(
      () => !window.location.hash.includes("/integrations"),
      null,
      { timeout: 7_000 },
    );

    // And the route the link advertises must actually mount the
    // AuthView for an unauthenticated caller.  Drop *both* the
    // server-side session cookie AND the in-tab session-mirror so
    // the bootstrap `/auth/me` probe comes back unauthenticated and
    // AuthView doesn't immediately bounce to the role default.  Then
    // hard-reload at `#/auth` and assert the cert-selection surface
    // paints.  This locks down the second half of the contract:
    // `/auth` is a real, render-able route, not just a string in
    // the panel.
    await page.context().clearCookies();
    await page.evaluate(() => {
      try {
        window.sessionStorage.clear();
        window.localStorage.removeItem("spire");
      } catch {
        /* tolerant */
      }
      window.location.hash = "#/auth";
    });
    // `page.goto` with a hash-only delta is a no-op (no document
    // reload), so the in-memory store would keep `currentUser`
    // populated and AuthView's "already signed-in" effect would
    // bounce us off `/auth` again.  An explicit reload forces a
    // fresh bootstrap; with cookies + sessionStorage cleared, the
    // bootstrap `/auth/me` probe fails and AuthView paints the
    // cert-selection surface.
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /Insert smartcard/i }),
    ).toBeVisible({ timeout: 10_000 });
  });
});
