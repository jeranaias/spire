import { expect, test } from "@playwright/test";
import { signIn, SECURITY_MANAGER_DODID } from "./_helpers";

// Task #31 — presenter card lives at /#/presenter and is gated on
// stageMode. The route renders the 8-minute beat sheet, the stage
// hotkeys, the four CAC quick-switch identities, the SIMULATE
// THERMALHAWK cold-open trigger, and the AUDIT close affordance.
// Outside stage mode the view's effect bounces back to "/".

test.describe("Presenter card (Task #31)", () => {
  test("renders the full cheat sheet under stage mode", async ({ page }) => {
    await signIn(page, SECURITY_MANAGER_DODID);

    // Enable stage mode + land on the card via the documented entry path.
    await page.goto("/?stage=1#/presenter");
    await page.waitForFunction(
      () => window.location.hash === "#/presenter",
      null,
      { timeout: 10_000 },
    );

    const body = page.locator("body");

    // Header strap.
    await expect(body).toContainText(
      "8-minute walk · four tiles · audit close",
    );

    // Section headings (one per content block).
    await expect(body).toContainText("Beat sheet");
    await expect(body).toContainText("Stage hotkeys");
    await expect(body).toContainText("Quick-switch identities");
    await expect(body).toContainText("Cold-open trigger");
    await expect(body).toContainText("Audit close");

    // Five beat rows: SENTRY → PULSE → BASTION → DHA RESCUE → AUDIT.
    await expect(body).toContainText("SENTRY");
    await expect(body).toContainText("PULSE");
    await expect(body).toContainText("BASTION");
    await expect(body).toContainText("DHA RESCUE");
    await expect(body).toContainText("AUDIT REVEAL");

    // Quick-switch identities — all four DODIDs.
    await expect(body).toContainText("DODID 1234567890");
    await expect(body).toContainText("DODID 2345678901");
    await expect(body).toContainText("DODID 3456789012");
    await expect(body).toContainText("DODID 4567890123");

    // Cold-open trigger callout.
    await expect(body).toContainText("SIMULATE THERMALHAWK");
    await expect(body).toContainText("spire:simulate-thermalhawk");

    // Audit close mentions the route.
    await expect(body).toContainText("/admin/audit");

    // Stage hotkeys — F9 failsafe, Shift+F8 reset, ? help, g d/s/p/b chords.
    await expect(body).toContainText("F9");
    await expect(body).toContainText("F8");
    await expect(body).toContainText("Failsafe");
    await expect(body).toContainText("Stage reset");
    await expect(body).toContainText("Go to DHA RESCUE");
  });

  test("opens a beat row's deep link", async ({ page }) => {
    await signIn(page, SECURITY_MANAGER_DODID);
    await page.goto("/?stage=1#/presenter");
    await page.waitForFunction(
      () => window.location.hash === "#/presenter",
      null,
      { timeout: 10_000 },
    );

    // Each beat exposes an "Open <route> →" button. Clicking the SENTRY
    // row's button should drop the operator on /#/sentry.
    await page.getByRole("button", { name: /Open \/sentry →/ }).click();
    await page.waitForFunction(
      () => window.location.hash === "#/sentry",
      null,
      { timeout: 5_000 },
    );
    expect(page.url()).toContain("#/sentry");
  });

  test("redirects to the Decision Bridge in operator (non-stage) mode", async ({
    page,
  }) => {
    await signIn(page, SECURITY_MANAGER_DODID);

    // Force stage off via the URL flag (mirrors the operator who clears
    // their localStorage and lands without the param). The card's
    // useEffect should fire navigate("/", {replace: true}).
    await page.goto("/?stage=0#/presenter");

    // Wait for the redirect effect — PresenterCardView fires nav("/"),
    // which falls through HomeRoute to the role-specific landing view
    // (e.g. /#/bastion or /#/decision-bridge). The only invariant is
    // that the URL is no longer parked on /presenter.
    await page.waitForFunction(
      () => !window.location.hash.startsWith("#/presenter"),
      null,
      { timeout: 10_000 },
    );

    // The cheat-sheet header must NOT be present in operator mode.
    await expect(page.locator("body")).not.toContainText(
      "8-minute walk · four tiles · audit close",
    );
  });
});
