import { test } from "@playwright/test";
import { signIn, SECURITY_MANAGER_DODID } from "./_helpers";

// Visual snapshots for docs/screenshots/topbar/. Crops to the topbar
// region (header is h-14 = 56px). Run via:
//   npx playwright test tests/playwright/_capture_topbar_screenshots.spec.ts

const SHOTS = [
  { name: "xl-1920", width: 1920, height: 1080, dodid: undefined },
  { name: "lg-1440", width: 1440, height: 900,  dodid: undefined },
  { name: "md-1024", width: 1024, height: 900,  dodid: undefined },
  { name: "stage-1920", width: 1920, height: 1080, dodid: SECURITY_MANAGER_DODID, stage: true },
];

for (const shot of SHOTS) {
  test(`capture ${shot.name}`, async ({ page }) => {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    if (shot.stage) {
      await page.addInitScript(() => {
        try { window.localStorage.setItem("spire.stageMode", "1"); } catch {}
      });
    }
    await signIn(page, shot.dodid);
    // Wait for the consolidated chip strip to render before grabbing
    // pixels — without this the screenshot is taken during the brief
    // post-auth bootstrap where the page is still a black background.
    await page.getByTestId("topbar-root").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("topbar-identity-pill").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(400);
    // Top of the page renders the UNCLASSIFIED // DEMO DATA banner
    // (~26px) followed by the h-14 TopBar (~56px). Capture 120px so both
    // strips are clearly framed.
    await page.screenshot({
      path: `docs/screenshots/topbar/${shot.name}.png`,
      clip: { x: 0, y: 0, width: shot.width, height: 120 },
    });
  });
}
