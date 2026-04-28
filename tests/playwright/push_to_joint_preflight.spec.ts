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

// Task #330 — the JOINT COP CTA must be reachable on the smaller
// viewport tiers a maintenance chief actually carries. Tailwind's `lg`
// kicks in at 1024px; the panel uses `max-w-[92vw]` so it can't
// horizontally clip even at the 1024-wide tier.
const MD_VIEWPORT = { width: 1024, height: 768 } as const;
const LG_VIEWPORT = { width: 1440, height: 900 } as const;

async function gotoBridge(
  page: Page,
  dodid: string,
  viewport: { width: number; height: number } = XL_VIEWPORT,
): Promise<void> {
  await page.setViewportSize(viewport);
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

// Task #330 — viewport sweep. Before this task the wrapper was
// `hidden xl:inline-flex` so the JOINT COP affordance only rendered at
// ≥1280px. A maintenance chief on a 1024×768 iPad therefore never saw
// the button and never reached the pre-flight panel that explains why
// their role can't push to joint. The wrapper now flips to
// `hidden lg:inline-flex` (≥1024px), so the affordance shows on md
// (1024) and lg (1440) too — the sweep below pins that contract.
test.describe("Joint COP affordance · viewport sweep (Task #330)", () => {
  const viewports: Array<{ name: string; size: { width: number; height: number } }> = [
    { name: "md (1024px)", size: MD_VIEWPORT },
    { name: "lg (1440px)", size: LG_VIEWPORT },
    { name: "xl (1920px)", size: XL_VIEWPORT },
  ];

  for (const { name, size } of viewports) {
    test(`Reyes (g4) sees the disabled JOINT COP button at ${name}`, async ({ page }) => {
      await gotoBridge(page, REYES_DODID, size);
      const btn = page.getByTestId("push-to-joint-button");
      await expect(btn).toBeVisible();
      await expect(btn).toBeDisabled();
      await expect(btn).toHaveAttribute("data-allowed", "false");
      await expect(btn).toHaveAttribute(
        "title",
        /Joint release requires.*Park or Hayes/,
      );
      // Disabled button must not surface the pre-flight panel even via a
      // forced click — same contract as the xl-only suite above.
      await btn.click({ force: true }).catch(() => {});
      await expect(page.getByTestId("push-to-joint-panel")).toHaveCount(0);
    });

    test(`Kowalski (maintenance_chief) sees the disabled JOINT COP button at ${name}`, async ({ page }) => {
      await gotoBridge(page, KOWALSKI_DODID, size);
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
  }

  test("Park (security_manager) opens the pre-flight panel at md (1024px) without horizontal clip", async ({ page }) => {
    await gotoBridge(page, PARK_DODID, MD_VIEWPORT);
    const btn = page.getByTestId("push-to-joint-button");
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
    await btn.click();
    const panel = page.getByTestId("push-to-joint-panel");
    await expect(panel).toBeVisible();
    // The panel carries `max-w-[92vw]` so it must stay within the
    // viewport even at the cramped 1024-wide tier. We verify the
    // bounding box doesn't overrun the right edge.
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(MD_VIEWPORT.width);
    }
  });
});
