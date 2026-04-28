/**
 * /pitch presenter-notes leak guard — Tasks #58 (fix) / #158 (this spec).
 *
 * Bare keypresses (`p`, `Home`, `End`) used to flip presenter mode on,
 * which dumped the speaker script onto the audience screen. Task #58
 * landed two invariants:
 *
 *   1. Presenter mode starts "off" on every mount — never persisted.
 *   2. The dangerous toggles (`p`, `Home`, `End`) require Shift.
 *
 * Until now both invariants were only verified by typecheck, lint, and
 * manual screenshots. This spec locks them into CI so a future refactor
 * that re-binds those keys without the Shift guard, or that removes the
 * "off"-on-mount default, fails loudly.
 */
import { test, expect, type Page } from "@playwright/test";
import { signIn, gotoHash, TEST_DODID } from "./_helpers";

// Presenter button label is "Presenter · off" | "Presenter · window" |
// "Presenter · ON SCREEN" — see PitchHeader in PitchView.tsx. We match
// the prefix so the off / on distinction is the only thing the assertion
// is sensitive to.
const PRESENTER_OFF = /Presenter\s·\soff/;
const PRESENTER_ON = /Presenter\s·\s(window|ON SCREEN)/;

// Track presenter popups across the page lifetime. We do NOT auto-close
// them inside the popup listener: PresenterNotesWindow polls the popup
// every 400ms and resets presenter to "off" the moment it sees `closed`,
// which would race the Shift+P assertions on a slower CI box. Instead
// each test that triggers the toggle records the popup, runs its
// assertions, and afterEach mops up any leftover so windows don't
// dangle between specs.

test.describe("/pitch presenter-notes leak guard (Task #58 / #158)", () => {
  let popups: Page[];

  test.beforeEach(async ({ page }) => {
    popups = [];
    page.on("popup", (popup) => {
      popups.push(popup);
    });
    // If the popup is blocked, togglePresenter falls back to a
    // window.confirm that asks whether to spill notes onto the audience
    // screen. Always reject so we never accidentally land in inline mode
    // (and so a stray confirm never blocks the test indefinitely).
    page.on("dialog", async (dialog) => {
      await dialog.dismiss().catch(() => {});
    });
    await signIn(page, TEST_DODID);
    await gotoHash(page, "#/pitch");
    // Wait for the deck shell to mount before any assertions / keystrokes.
    await expect(page.getByRole("button", { name: PRESENTER_OFF })).toBeVisible();
  });

  test.afterEach(async () => {
    // Mop up any presenter popup the spec didn't close itself so windows
    // don't dangle into the next test.
    for (const p of popups) {
      try { await p.close(); } catch { /* non-fatal */ }
    }
  });

  test("loads with presenter mode OFF and no Failsafe / Rehearsal chrome", async ({ page }) => {
    // Invariant #1 — presenter starts "off" on every mount.
    await expect(page.getByRole("button", { name: PRESENTER_OFF })).toBeVisible();
    // The Failsafe + Rehearsal buttons are gated behind presenter-on
    // (PitchHeader: `presenterOn && (...)`). They must not be reachable
    // by audience-side observers when the deck first paints.
    await expect(page.getByRole("button", { name: /^Failsafe$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Rehearsal/ })).toHaveCount(0);
  });

  test("bare 'p', Home, End do NOT flip presenter mode on", async ({ page }) => {
    // Focus the body so the window-level keydown listener receives the
    // event outside any input field (PitchView's `inField` guard would
    // otherwise short-circuit and the test would assert on the wrong
    // codepath).
    await page.locator("body").click({ position: { x: 5, y: 5 } });

    for (const key of ["p", "Home", "End"]) {
      await page.keyboard.press(key);
    }

    // Invariant #2 — the unguarded keys are inert. The header presenter
    // button must still read "off", and the gated chrome must remain
    // absent. If a future refactor re-binds bare 'p' (or Home/End in
    // their navigational form) to togglePresenter, the assertions below
    // start failing because the label flips to "Presenter · window" /
    // "Presenter · ON SCREEN" and the Failsafe + Rehearsal buttons
    // appear.
    await expect(page.getByRole("button", { name: PRESENTER_OFF })).toBeVisible();
    await expect(page.getByRole("button", { name: PRESENTER_ON })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Failsafe$/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Rehearsal/ })).toHaveCount(0);

    // Sanity-check the Shift guard didn't accidentally trip a popup
    // either — bare 'p' must NOT have opened a presenter window.
    expect(popups.length).toBe(0);
  });

  test("Shift+P flips presenter mode on and reveals Failsafe / Rehearsal", async ({ page }) => {
    // Companion to the leak-guard tests above: with Shift held, the
    // toggle MUST work. Otherwise a refactor could "fix" the leak by
    // breaking the legitimate hotkey and the regression catches that
    // too.
    await page.locator("body").click({ position: { x: 5, y: 5 } });

    // togglePresenter calls window.open in the same gesture; wait on
    // the popup event so the keyboard.press doesn't race the React
    // state update that flips presenter to "popup".
    //
    // We deliberately do NOT close the popup before the assertions
    // below. PresenterNotesWindow polls `win.closed` every 400ms and
    // resets presenter to "off" as soon as it sees the popup gone —
    // closing inside the popup listener would race the assertions on
    // a slower CI box and re-introduce the exact flakiness the
    // afterEach hook is built to avoid. The popup is closed by
    // afterEach once the assertions land.
    const [popup] = await Promise.all([
      page.waitForEvent("popup"),
      page.keyboard.press("Shift+P"),
    ]);
    expect(popup).toBeTruthy();

    // The header label flips off "off" — exact value depends on whether
    // the popup opened ("window") or the inline fallback was confirmed
    // (we dismiss the confirm in beforeEach, so "window" is expected,
    // but we tolerate either non-off label here for robustness against
    // future popup-policy changes).
    await expect(page.getByRole("button", { name: PRESENTER_OFF })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Rehearsal/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Failsafe$/ })).toBeVisible();
  });
});
