import { Page, expect } from "@playwright/test";

// MOCK_USERS in backend/auth.py:
//   1234567890 GySgt Reyes        — g4
//   2345678901 MSgt Kowalski      — maintenance_chief
//   3456789012 CWO3 James Park    — security_manager
//   4567890123 MajGen Hayes       — mef_commander
// SENTRY view is scope-gated to {data_custodian, security_manager} —
// only `security_manager` (Park) exists in MOCK_USERS, so SENTRY-driven
// specs sign in as Park. Other views default to GySgt Reyes (g4).
export const TEST_DODID = "1234567890";
export const TEST_PIN = "123456";
export const SECURITY_MANAGER_DODID = "3456789012";

const ALL_TEST_DODIDS = [
  "1234567890",
  "2345678901",
  "3456789012",
  "4567890123",
];

/**
 * Pre-seed the per-identity onboarding "seen" flag in localStorage so the
 * 4-screen SPIRO intro modal does not block automated specs. The Onboarding
 * component reads `spire.onboarding.intro.seen.${dodid}` === "1" as
 * "already seen, don't show".
 */
async function dismissOnboarding(page: Page): Promise<void> {
  await page.addInitScript((dodids: string[]) => {
    try {
      for (const d of dodids) {
        window.localStorage.setItem(`spire.onboarding.intro.seen.${d}`, "1");
      }
    } catch {
      /* private mode tolerant */
    }
  }, ALL_TEST_DODIDS);
}

export async function signIn(
  page: Page,
  dodid: string = TEST_DODID,
  pin: string = TEST_PIN,
): Promise<void> {
  await dismissOnboarding(page);
  await page.goto("/#/auth");
  await page
    .waitForSelector("#cac-pin, [aria-label='Card PIN · 6 digits']", {
      timeout: 10_000,
    })
    .catch(() => {});
  // The cert-selection screen renders one cert per MOCK_USERS entry. The
  // visible DODID is masked except for the last 4 digits — match by suffix.
  const certCard = page.locator(`text=${dodid.slice(-4)}`).first();
  await certCard.waitFor({ state: "visible", timeout: 10_000 });
  await certCard.click();
  const pinInput = page.locator("#cac-pin");
  await pinInput.waitFor({ state: "visible", timeout: 5_000 });
  await pinInput.fill(pin);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForFunction(
    () => !window.location.hash.startsWith("#/auth"),
    null,
    { timeout: 15_000 },
  );
  // Belt-and-braces dismissal of the 4-screen Onboarding intro modal.
  // The Onboarding component (frontend/src/components/Onboarding.tsx)
  // reconciles against `/prefs/onboarding-intro` on every mount and
  // trusts the server value over the localStorage cache. So we both:
  //   1) POST the per-identity "seen" pref to the server so the modal
  //      stays dismissed across reconciliations, and
  //   2) If the modal is already on screen for this paint, click its
  //      backdrop to drop it so it doesn't intercept TopBar clicks.
  // Use the page's own `fetch` (via page.evaluate) so the auth cookies
  // set by the sign-in form are guaranteed to attach — `page.request`
  // sometimes does not pick up cookies set by an in-page POST.
  // Route lives under the `system` router (prefix `/api/system`); see
  // backend/main.py:93.
  await page.evaluate(async () => {
    try {
      await fetch("/api/system/prefs/onboarding-intro", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ seen: true }),
      });
    } catch {
      /* server pref is best-effort; cache fallback still works. */
    }
  });
  const introModal = page.locator(
    "div[role='presentation'].fixed.inset-0.z-\\[9100\\]",
  );
  try {
    await introModal.waitFor({ state: "visible", timeout: 1_500 });
    // Clicking the backdrop dismisses the modal (its onClick handler).
    await introModal.click({ position: { x: 5, y: 5 } });
    await introModal.waitFor({ state: "hidden", timeout: 3_000 });
  } catch {
    /* no modal → nothing to dismiss */
  }
}

export async function gotoHash(page: Page, hashPath: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hashPath);
  await page.waitForFunction(
    (h) => window.location.hash === h,
    hashPath,
    { timeout: 5_000 },
  );
}

export async function expectVisibleText(
  page: Page,
  text: RegExp | string,
): Promise<void> {
  await expect(page.locator("body")).toContainText(text);
}
