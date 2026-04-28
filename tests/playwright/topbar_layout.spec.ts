import { test, expect } from "@playwright/test";
import { signIn, SECURITY_MANAGER_DODID } from "./_helpers";

// Task #184 TopBar declutter — verify the spine survives 1024 → 2560 and
// the consolidated chips render the right surface for operator vs stage
// mode. We do NOT assert the exact text of every chip (their content is
// driven by live state and the scenario clock); we assert structural
// invariants — chip presence, tagline truncation, numerals removed,
// MissionClock visibility, and that the IdentityPill dropdown holds the
// migrated Air-gap + Density + Comms posture rows.

const BREAKPOINTS = {
  md: { width: 1024, height: 900 },
  lg: { width: 1440, height: 900 },
  xl: { width: 1920, height: 1080 },
} as const;

test.describe("TopBar declutter (Task #184)", () => {
  test("xl+ shows the full spine: System + Notif + Comms + IdPill", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.xl);
    await signIn(page);
    await expect(page.getByTestId("topbar-root")).toBeVisible();
    await expect(page.getByTestId("system-status-chip")).toBeVisible();
    await expect(page.getByTestId("notifications-chip")).toBeVisible();
    await expect(page.getByTestId("topbar-identity-pill")).toBeVisible();
    // CommsControl renders an aria-labelled chip — match by accessible name.
    await expect(page.getByRole("button", { name: /comms/i }).first()).toBeVisible();
  });

  test("md/lg show CompactMissionClock and hide the full clock", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.md);
    await signIn(page);
    await expect(page.getByTestId("mission-clock-compact")).toBeVisible();
    // Full mission-clock element is wrapped in `xl:block hidden` so it's
    // present in the DOM but not visible at md.
    const full = page.getByTestId("mission-clock");
    if (await full.count()) {
      await expect(full).toBeHidden();
    }
  });

  test("xl+ shows full MissionClock and hides CompactMissionClock", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.xl);
    await signIn(page);
    await expect(page.getByTestId("mission-clock")).toBeVisible();
    const compact = page.getByTestId("mission-clock-compact");
    if (await compact.count()) {
      await expect(compact).toBeHidden();
    }
  });

  test("tab labels do not carry numerals (01/02/...) anywhere in the bar", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.lg);
    await signIn(page);
    const topbar = page.getByTestId("topbar-root");
    await expect(topbar).toBeVisible();
    const text = (await topbar.textContent()) ?? "";
    // The old tabs rendered "01 / Plan", "02 / Move", etc. We removed the
    // leading "0N / " — assert no two-digit-slash-two-digit pattern slipped
    // back in (clock times like 12:34:56 use colons so they don't match).
    expect(text).not.toMatch(/\b0[1-9]\s*\/\s*0[1-9]\b/);
    // Reyes (g4) can navigate to PULSE + BASTION; SENTRY/ADMIN render as
    // disabled spans for that role, so the assertions stick to the two
    // tabs that always render as NavLinks for g4.
    await expect(topbar.getByRole("link", { name: /^PULSE$/i }).first()).toBeVisible();
    await expect(topbar.getByRole("link", { name: /^BASTION$/i }).first()).toBeVisible();
  });

  test("IdentityPill menu hosts Operator settings (Air-gap, Density, Comms)", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.lg);
    // Park is security_manager — the only role that sees the Air-gap row.
    await signIn(page, SECURITY_MANAGER_DODID);
    // Onboarding intro modal can race the post-auth navigation when the
    // server's per-identity seen-flag disagrees with the local cache. Press
    // Escape so the chrome under it (the IdentityPill we're about to click)
    // is reachable. Harmless if no modal is open.
    await page.keyboard.press("Escape");
    await page.getByTestId("topbar-identity-pill").click();
    const settings = page.getByTestId("identity-operator-settings");
    await expect(settings).toBeVisible();
    await expect(settings.getByTestId("identity-airgap-toggle")).toBeVisible();
    await expect(settings.getByTestId("identity-density-dense")).toBeVisible();
    await expect(settings.getByTestId("identity-density-sparse")).toBeVisible();
    await expect(settings).toContainText(/Comms posture/i);
  });
});
