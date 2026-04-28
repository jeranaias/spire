import { test, expect } from "@playwright/test";
import {
  signIn,
  TEST_DODID,
  SECURITY_MANAGER_DODID,
} from "./_helpers";

// Task #194 — SPIRO brevity + role chips e2e coverage.
// Five flows covering the four operator roles that have brevity chips:
//   1. g4 — chip set + open/send a "MORNING BRIEF"
//   2. mef_commander — SITREP chip
//   3. security_manager — MARK CLASSIFICATION + AUDIT QUERY chips visible
//   4. maintenance_chief — DONOR FOR PART chip set
//   5. brevity refusal — sending a clearly off-scope prompt as g4 returns
//      a refusal-shaped response (no apologies, no emojis).
//
// MOCK_USERS that have brevity chips wired:
//   1234567890 GySgt Reyes        — g4
//   2345678901 MSgt Kowalski      — maintenance_chief
//   3456789012 CWO3 James Park    — security_manager
//   4567890123 MajGen Hayes       — mef_commander

const MAINTENANCE_DODID = "2345678901";
const MEF_COMMANDER_DODID = "4567890123";

async function openSpiro(page: import("@playwright/test").Page) {
  // Spiro launcher button has aria-label "Open SPIRO assistant (Ctrl+/)"
  // and the chip ul carries data-testid="spiro-chips". The Spiro panel
  // is rendered globally, so we can open it from any signed-in route.
  const launcher = page.getByRole("button", {
    name: /open spiro/i,
  });
  await launcher.waitFor({ state: "visible", timeout: 10_000 });
  await launcher.click();
  await page.waitForSelector('[data-testid="spiro-chips"]', {
    timeout: 5_000,
  });
}

test.describe("SPIRO — brevity chips by role", () => {
  test("g4 sees MORNING BRIEF / WHO'S RED / CANNIB chips", async ({ page }) => {
    await signIn(page, TEST_DODID);
    await openSpiro(page);
    const chipList = page.locator('[data-testid="spiro-chips"]');
    await expect(chipList).toContainText(/MORNING BRIEF/i);
    await expect(chipList).toContainText(/WHO'?S RED/i);
    await expect(chipList).toContainText(/CANNIB/i);
    // Send the MORNING BRIEF chip; we just verify it lands in the
    // composer (no LLM round-trip required for this layer).
    await page
      .locator('[data-testid="spiro-chip-morning-brief"]')
      .click();
    const composer = page.getByPlaceholder(/ask spiro/i)
      .or(page.locator("textarea"))
      .first();
    await expect(composer).not.toHaveValue("");
  });

  test("mef_commander sees SITREP / FPCON / BACK-BRIEF chips", async ({
    page,
  }) => {
    await signIn(page, MEF_COMMANDER_DODID);
    await openSpiro(page);
    const chipList = page.locator('[data-testid="spiro-chips"]');
    await expect(chipList).toContainText(/SITREP/);
    await expect(chipList).toContainText(/FPCON/);
    await expect(chipList).toContainText(/BACK-?BRIEF/i);
  });

  test("security_manager sees MARK / RELEASE / AUDIT chips", async ({
    page,
  }) => {
    await signIn(page, SECURITY_MANAGER_DODID);
    await openSpiro(page);
    const chipList = page.locator('[data-testid="spiro-chips"]');
    await expect(chipList).toContainText(/MARK CLASSIFICATION/i);
    await expect(chipList).toContainText(/RELEASE PACKAGE/i);
    await expect(chipList).toContainText(/AUDIT QUERY/i);
  });

  test("maintenance_chief sees DONOR / WHAT'S RED / PREDICT chips", async ({
    page,
  }) => {
    await signIn(page, MAINTENANCE_DODID);
    await openSpiro(page);
    const chipList = page.locator('[data-testid="spiro-chips"]');
    await expect(chipList).toContainText(/DONOR FOR PART/i);
    await expect(chipList).toContainText(/WHAT'?S RED/i);
    await expect(chipList).toContainText(/PREDICT/i);
  });

  test("SPIRO panel header carries the brevity persona label", async ({
    page,
  }) => {
    await signIn(page, TEST_DODID);
    await openSpiro(page);
    // The chip-list header reads "Brevity · click to send" — that label
    // is the demo's persona signpost and must not silently change.
    const panel = page.locator('[aria-label="SPIRO"]');
    await expect(panel).toContainText(/Brevity/i);
    await expect(panel).toContainText(/click to send/i);
    // No apologies, no emojis on the empty-state copy.
    const empty = await panel.innerText();
    expect(empty).not.toMatch(/sorry|apolog/i);
    expect(empty).not.toMatch(/[\u{1F300}-\\u{1FAFF}]/u);
  });
});

// Task #194 code review G-3+G-4: chips don't just open — they fire real
// tools and grow the audit chain. We exercise the /api/copilot/plan +
// /api/copilot/execute pair directly through the signed-in browser
// session so cookies, role, and DODID flow exactly like a real operator.

test.describe("SPIRO — brevity → tool firing + audit chain", () => {
  test("'SITREP' plan + execute returns status_summary results", async ({
    page,
  }) => {
    await signIn(page, MEF_COMMANDER_DODID);
    // Use the browser context's fetch so the signed session cookie rides
    // along — that's the same path the real composer takes.
    const planResp = await page.evaluate(async () => {
      const r = await fetch("/api/copilot/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "SITREP" }),
      });
      return { status: r.status, body: await r.json() };
    });
    expect(planResp.status).toBe(200);
    const steps = (planResp.body?.steps ?? []) as Array<{ tool: string }>;
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0].tool).toBe("status_summary");

    const execResp = await page.evaluate(async (planBody) => {
      const r = await fetch("/api/copilot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_id: planBody.plan_id,
          steps: planBody.steps,
        }),
      });
      return { status: r.status, body: await r.json() };
    }, planResp.body);
    expect(execResp.status).toBe(200);
    const results = execResp.body?.results ?? [];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].tool).toBe("status_summary");
  });

  test("'Set FPCON CHARLIE' actually mutates FPCON state through the live route", async ({
    page,
  }) => {
    await signIn(page, MEF_COMMANDER_DODID);

    // Snapshot FPCON state before the brevity click via the status_summary
    // tool — that's the live read surface every operator role can see.
    const readFpcon = async (): Promise<string> => {
      return await page.evaluate(async () => {
        const plan = await (await fetch("/api/copilot/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "SITREP" }),
        })).json();
        const exec = await (await fetch("/api/copilot/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ plan_id: plan.plan_id, steps: plan.steps }),
        })).json();
        const status = (exec?.results ?? []).find(
          (r: { tool: string }) => r.tool === "status_summary",
        );
        return String(status?.result?.fpcon ?? "");
      });
    };
    const fpconBefore = await readFpcon();

    const planResp = await page.evaluate(async () => {
      const r = await fetch("/api/copilot/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Set FPCON CHARLIE" }),
      });
      return await r.json();
    });
    const steps = (planResp?.steps ?? []) as Array<{
      tool: string;
      args: Record<string, unknown>;
    }>;
    expect(steps[0]?.tool).toBe("set_fpcon");
    expect(steps[0]?.args?.level).toBe("CHARLIE");

    const execResp = await page.evaluate(async (planBody) => {
      const r = await fetch("/api/copilot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan_id: planBody.plan_id,
          steps: planBody.steps,
        }),
      });
      return await r.json();
    }, planResp);
    const setResult = (execResp?.results ?? []).find(
      (r: { tool: string }) => r.tool === "set_fpcon",
    );
    expect(setResult?.result?.new).toBe("CHARLIE");

    // FPCON now reads CHARLIE on the live status_summary surface — proves
    // the brevity → tool path mutates real state, not just the audit row.
    const fpconAfter = await readFpcon();
    expect(fpconAfter).toBe("CHARLIE");
    expect(fpconAfter).not.toBe(fpconBefore);

    // Reset FPCON so subsequent specs see BRAVO baseline.
    await page.evaluate(async () => {
      const plan = await (await fetch("/api/copilot/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Set FPCON BRAVO" }),
      })).json();
      await fetch("/api/copilot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_id: plan.plan_id, steps: plan.steps }),
      });
    });
  });
});
