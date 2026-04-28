/**
 * Demo cockpit — silent-lie regression coverage (Task #165).
 *
 * Three failure-mode bugs in the scripted demo cockpit were just fixed:
 *
 *   (1) Retry no-op  — the inline ErrorState's "Retry" button on /demo
 *       used to call `setPickerScenarioId(id => id)`, which is a no-op
 *       in React (same reference, no re-render). The fetch was never
 *       re-issued; the operator clicked Retry and watched nothing
 *       happen. Now a `retryNonce` state gates the load effect, so a
 *       Retry click forces a fresh GET /api/system/scenario/blood-h72.
 *
 *   (2) Reset desync for restricted roles — the Reset button used to
 *       call the local `reset()` first, then issue the backend control
 *       round-trip. For roles outside SCENARIO_CONTROL_ROLES (e.g.
 *       maintenance_chief), the backend rejected the control with 403
 *       AFTER the FE had already snapped to beat 0. The cockpit
 *       claimed READY @ beat 0 while the backend mission clock kept
 *       the previous beat's `fired_events`. Now Reset is disabled in
 *       render for those roles and the title/aria-label explains why.
 *
 *   (3) Invisible DDIL desync — when a `scenario.control seek` failed
 *       (DDIL DISCONNECTED dropping the write, transient 5xx, network
 *       blip), ScenarioPlayerHost used to swallow the rejection. The
 *       cockpit kept ticking PLAYING through narration while the
 *       backend stayed pinned at the last successful offset. Now ANY
 *       non-success seek records `syncError` and ScenarioSyncBanner
 *       sticks a high-z-index "Backend out of sync" strip on the
 *       viewport that survives until the next successful seek.
 *
 * Each test simulates the original failure mode — a 503 on the relevant
 * endpoint — and asserts the FE no longer silently lies about it.
 *
 * Note on roles: the task description names maintenance_chief AND
 * data_custodian as the restricted-role coverage. Only maintenance_chief
 * has a backing MOCK_USERS entry today (project policy pins MOCK_USERS
 * to four operators; see `_helpers.ts`). For the data_custodian case we
 * sign in as Kowalski and route-stub the auth payloads to rewrite the
 * role to "data_custodian" so the FE store sees the gated role
 * end-to-end. Both roles are asserted explicitly — no proxy coverage.
 */
import { test, expect, type Page } from "@playwright/test";
import { signIn, gotoHash, TEST_DODID } from "./_helpers";

const MAINTENANCE_CHIEF_DODID = "2345678901";

/**
 * data_custodian doesn't have a backing MOCK_USERS entry (project policy
 * pins MOCK_USERS to four operators), so we can't sign in as one
 * directly. Instead we install a route stub that rewrites the role on
 * the auth payloads the FE consumes (`/api/auth/login`, `/api/auth/me`,
 * `/api/auth/users` authenticated re-fetch). The store sets `role` from
 * `currentUser.role` on those payloads, so this is sufficient to exercise
 * the FE-side role gate. The test never clicks Reset (which would round-
 * trip to the backend that legitimately sees the operator as
 * maintenance_chief) — it only asserts the disabled state + tooltip.
 */
async function rewriteAuthRole(
  page: Page,
  overrideRole: string,
): Promise<void> {
  const rewriteUserRole = async (route: import("@playwright/test").Route) => {
    const response = await route.fetch();
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return route.continue();
    }
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      if (obj.user && typeof obj.user === "object") {
        (obj.user as Record<string, unknown>).role = overrideRole;
      }
      if (Array.isArray(obj.users)) {
        for (const u of obj.users as Array<Record<string, unknown>>) {
          if (u && u.dodid === MAINTENANCE_CHIEF_DODID) u.role = overrideRole;
        }
      }
    }
    return route.fulfill({
      status: response.status(),
      headers: response.headers(),
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  };
  await page.route("**/api/auth/login", rewriteUserRole);
  await page.route("**/api/auth/me", rewriteUserRole);
  await page.route("**/api/auth/users", rewriteUserRole);
}

/**
 * Wait for the cockpit's scenario-load round-trip to settle into either
 * a hydrated success state (the "Current beat:" heading, which only
 * renders when beats[] is populated AND a current beat has been picked
 * by loadScenario) or the inline ErrorState. Anything else means the
 * load is still in flight.
 */
async function waitForCockpitSettled(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const body = document.body;
      if (!body) return false;
      const text = body.textContent ?? "";
      const hasErr = text.includes("Scenario load failed");
      // "Current beat:" only renders when scenario beats have hydrated
      // (DemoView gates the narration card on `currentBeat`).
      const hasCurrentBeat = text.includes("Current beat:");
      return hasErr || hasCurrentBeat;
    },
    null,
    { timeout: 15_000 },
  );
}

test.describe("demo cockpit — silent-lie regressions (Task #165)", () => {
  // ---------------------------------------------------------------
  // (1) Retry button on /demo actually re-issues the scenario fetch.
  // ---------------------------------------------------------------
  test("Retry on a failed scenario load re-fetches the vignette", async ({ page }) => {
    // Block the scenario fetch ONCE so the first GET fails with 503.
    let blocked = true;
    let getCount = 0;
    await page.route("**/api/system/scenario/blood-h72**", async (route) => {
      // Only intercept the metadata GET, not the /feed route or POSTs.
      const url = route.request().url();
      if (route.request().method() !== "GET") return route.continue();
      if (url.includes("/blood-h72/feed")) return route.continue();
      getCount += 1;
      if (blocked) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "scenario engine warming up" }),
        });
        return;
      }
      return route.continue();
    });

    await signIn(page, TEST_DODID); // Reyes (g4) — has scenario control
    await gotoHash(page, "#/demo");

    // The first GET should be the 503; the inline ErrorState surfaces.
    await expect(page.getByText("Scenario load failed")).toBeVisible({
      timeout: 10_000,
    });
    expect(getCount).toBeGreaterThanOrEqual(1);

    // Unblock further GETs and click Retry — this is the bug surface.
    // The old `setPickerScenarioId(id => id)` was a no-op; the new
    // `retryNonce` increment must trigger a fresh fetch.
    blocked = false;
    const beforeRetry = getCount;
    await page.getByRole("button", { name: /Retry/i }).first().click();

    // Wait for at least one new GET to be observed (the load effect
    // re-running with the bumped nonce). 5s is comfortable for the
    // proxied dev server.
    await expect
      .poll(() => getCount, { timeout: 5_000 })
      .toBeGreaterThan(beforeRetry);

    // Cockpit hydrates: the narration card's "Current beat:" heading
    // only renders once the scenario.beats[] arrived from the backend.
    await waitForCockpitSettled(page);
    await expect(page.getByText("Scenario load failed")).toBeHidden();
    await expect(page.getByText(/Current beat:/i).first()).toBeVisible();
  });

  // ---------------------------------------------------------------
  // (2a) Reset disabled with role-explanatory tooltip for the
  //      restricted role that has a real MOCK_USERS entry.
  // ---------------------------------------------------------------
  test("Reset is disabled for maintenance_chief with a role-explanatory tooltip", async ({
    page,
  }) => {
    await signIn(page, MAINTENANCE_CHIEF_DODID); // Kowalski
    await gotoHash(page, "#/demo");
    await waitForCockpitSettled(page);

    // The disabled aria-label is the regression-locking signal: it
    // names the role gate explicitly so a future refactor that flips
    // the gate has to update this string. Pressable forwards aria-label
    // verbatim from props.
    const resetBtn = page
      .locator(
        "[aria-label=\"Reset disabled — this role can't drive the mission clock\"]",
      )
      .first();
    await expect(resetBtn).toBeVisible({ timeout: 10_000 });
    await expect(resetBtn).toBeDisabled();
    await expect(resetBtn).toHaveAttribute(
      "title",
      /only MEF Commander, G4, or Security Manager can reset the mission clock/i,
    );
  });

  // ---------------------------------------------------------------
  // (2b) Same gate, asserted explicitly for data_custodian. There is
  //      no MOCK_USERS entry for that role today, so we sign in as
  //      Kowalski and route-stub the auth payloads to rewrite the
  //      FE-visible role to "data_custodian" — see `rewriteAuthRole`
  //      header for rationale. Locks down the second role named in
  //      the task without proxying to the maintenance_chief case.
  // ---------------------------------------------------------------
  test("Reset is disabled for data_custodian with a role-explanatory tooltip", async ({
    page,
  }) => {
    await rewriteAuthRole(page, "data_custodian");
    await signIn(page, MAINTENANCE_CHIEF_DODID); // role rewritten in-flight
    await gotoHash(page, "#/demo");
    await waitForCockpitSettled(page);

    const resetBtn = page
      .locator(
        "[aria-label=\"Reset disabled — this role can't drive the mission clock\"]",
      )
      .first();
    await expect(resetBtn).toBeVisible({ timeout: 10_000 });
    await expect(resetBtn).toBeDisabled();
    await expect(resetBtn).toHaveAttribute(
      "title",
      /only MEF Commander, G4, or Security Manager can reset the mission clock/i,
    );
  });

  // ---------------------------------------------------------------
  // (3) Forcing a scenario.control 503 surfaces the sticky "Backend
  //     out of sync" banner; clearing the intercept and clicking
  //     "Retry sync" makes it disappear.
  // ---------------------------------------------------------------
  test("Sticky sync banner appears on scenario.control 503 and clears on Retry sync", async ({
    page,
  }) => {
    // Sign in as Reyes (g4) so the role check passes — a 403 on control
    // would fire a different toast path; we want the generic 5xx path
    // that proves the silent-swallow is gone.
    await signIn(page, TEST_DODID);

    // Intercept POST /api/system/scenario/control with 503. Capture the
    // toggle in a closure so we can flip it later from the test body.
    let block503 = true;
    await page.route("**/api/system/scenario/control**", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      if (block503) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: "mission clock stalled" }),
        });
        return;
      }
      return route.continue();
    });

    await gotoHash(page, "#/demo");
    await waitForCockpitSettled(page);

    // Click Play — DemoView calls `play()` then navigates to the first
    // beat's view. ScenarioPlayerHost then issues the seek, which 503s
    // and pins `syncError`. The banner is mounted at the App shell and
    // survives the route change.
    await page.getByRole("button", { name: /Play scenario/i }).click();

    // Wait for the sticky banner. The role="alert" + the headline text
    // are both regression signals — neither existed before this fix.
    const banner = page.getByRole("alert").filter({
      hasText: /Backend out of sync/i,
    });
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(/cockpit advanced past the mission clock/i);

    // Now unblock the control endpoint and click the banner's "Retry
    // sync" affordance. The host's success path calls noteSyncSuccess,
    // which clears `syncError`, which unmounts the banner.
    block503 = false;
    // The retry affordance's accessible name comes from its aria-label
    // ("Retry mission-clock sync"); the visible glyph reads "Retry sync".
    await banner
      .getByRole("button", { name: /Retry mission-clock sync/i })
      .click();

    await expect(banner).toBeHidden({ timeout: 10_000 });
  });
});
