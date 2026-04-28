import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./_helpers";

// MOCK_USERS in backend/auth.py:
//   1234567890 GySgt Reyes        — g4                  (denied)
//   2345678901 MSgt Kowalski      — maintenance_chief   (denied)
//   3456789012 CWO3 James Park    — security_manager    (allowed)
//   4567890123 MajGen Hayes       — mef_commander       (allowed)
const REYES_DODID = "1234567890";
const KOWALSKI_DODID = "2345678901";
const PARK_DODID = "3456789012";
const HAYES_DODID = "4567890123";

const XL_VIEWPORT = { width: 1920, height: 1080 } as const;

async function gotoBridge(page: Page, dodid: string): Promise<void> {
  await page.setViewportSize(XL_VIEWPORT);
  await signIn(page, dodid);
  // Decision Bridge is the default landing for every role; no further nav
  // needed. The PushToJointButton renders inline in the operator chrome.
  await expect(page.getByTestId("topbar-root")).toBeVisible();
}

test.describe("Joint COP push pre-flight (Task #103)", () => {
  test("disabled with helpful tooltip for GySgt Reyes (g4)", async ({ page }) => {
    await gotoBridge(page, REYES_DODID);
    const btn = page.getByTestId("push-to-joint-button");
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute("data-allowed", "false");
    await expect(btn).toHaveAttribute(
      "title",
      /Joint release requires.*Park or Hayes/,
    );
    // Clicking a disabled button must not surface the pre-flight panel.
    await btn.click({ force: true }).catch(() => {});
    await expect(page.getByTestId("push-to-joint-panel")).toHaveCount(0);
  });

  test("disabled with helpful tooltip for MSgt Kowalski (maintenance_chief)", async ({ page }) => {
    await gotoBridge(page, KOWALSKI_DODID);
    const btn = page.getByTestId("push-to-joint-button");
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute("data-allowed", "false");
    await expect(btn).toHaveAttribute(
      "title",
      /Joint release requires.*Park or Hayes/,
    );
    await btn.click({ force: true }).catch(() => {});
    await expect(page.getByTestId("push-to-joint-panel")).toHaveCount(0);
  });

  test("enabled and surfaces pre-flight for CWO3 Park (security_manager)", async ({ page }) => {
    await gotoBridge(page, PARK_DODID);
    const btn = page.getByTestId("push-to-joint-button");
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveAttribute("data-allowed", "true");
    await btn.click();
    const panel = page.getByTestId("push-to-joint-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("push-to-joint-operator")).toContainText("Park");
    await expect(page.getByTestId("push-to-joint-role")).toContainText(/Security Mgr/i);
    await expect(page.getByTestId("push-to-joint-status")).toContainText(/Allowed/i);
    await expect(page.getByTestId("push-to-joint-classification")).toContainText(
      "SECRET // REL TO USA, FVEY",
    );
    await expect(page.getByTestId("push-to-joint-subscription")).toContainText(
      "TOPIC_FULL_MAGTF",
    );
    await expect(page.getByTestId("push-to-joint-confirm")).toBeVisible();
  });

  test("enabled and surfaces pre-flight for MajGen Hayes (mef_commander)", async ({ page }) => {
    await gotoBridge(page, HAYES_DODID);
    const btn = page.getByTestId("push-to-joint-button");
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveAttribute("data-allowed", "true");
    await btn.click();
    const panel = page.getByTestId("push-to-joint-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("push-to-joint-operator")).toContainText("Hayes");
    await expect(page.getByTestId("push-to-joint-role")).toContainText(/MEF Commander/i);
    await expect(page.getByTestId("push-to-joint-status")).toContainText(/Allowed/i);
    await expect(page.getByTestId("push-to-joint-classification")).toContainText(
      "SECRET // REL TO USA, FVEY",
    );
    await expect(page.getByTestId("push-to-joint-subscription")).toContainText(
      "TOPIC_FULL_MAGTF",
    );
    // Cancel closes the panel without opening a tab.
    await page.getByTestId("push-to-joint-cancel").click();
    await expect(page.getByTestId("push-to-joint-panel")).toHaveCount(0);
  });
});
