import { test, expect, type Page } from "@playwright/test";
import { signIn, SECURITY_MANAGER_DODID, TEST_DODID } from "./_helpers";

// Task #184 TopBar declutter — verify the spine survives 1024 → 2560 and
// the consolidated chips render the right surface for operator vs stage
// mode. We do NOT assert the exact text of every chip (their content is
// driven by live state and the scenario clock); we assert structural
// invariants — chip presence, tagline truncation, numerals removed,
// MissionClock visibility, StageCluster composition, and that the
// IdentityPill dropdown holds the migrated Air-gap + Density + Comms
// posture rows.

const BREAKPOINTS = {
  sm:  { width: 640,  height: 900 },
  md:  { width: 1024, height: 900 },
  lg:  { width: 1440, height: 900 },
  xl:  { width: 1920, height: 1080 },
  hd:  { width: 2560, height: 1440 },
} as const;

async function enableStageMode(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try { window.localStorage.setItem("spire.stageMode", "1"); } catch {}
  });
}

// Seed a scenario in sessionStorage so `useScenarioPlayer.scenarioId` is
// non-null at boot. Failsafe in StageCluster is gated on a loaded
// scenario; pre-seeding the persisted demoPlayer state is the cleanest
// way to get the third stage-cluster button visible without driving the
// scenario picker through the UI.
async function preloadScenario(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      window.sessionStorage.setItem(
        "spire.demoPlayer.v1",
        JSON.stringify({
          scenarioId: "TXN-PROBE-01",
          currentBeatIndex: 0,
          status: "loaded",
          speed: 1,
          autoAdvance: false,
          narrationVisible: true,
        }),
      );
    } catch {
      /* private mode tolerant */
    }
  });
}

test.describe("TopBar declutter (Task #184)", () => {
  test("xl+ shows the full spine: System + Notif + Comms + IdPill", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.xl);
    await signIn(page);
    await expect(page.getByTestId("topbar-root")).toBeVisible();
    await expect(page.getByTestId("system-status-chip")).toBeVisible();
    await expect(page.getByTestId("notifications-chip")).toBeVisible();
    await expect(page.getByTestId("topbar-identity-pill")).toBeVisible();
    await expect(page.getByRole("button", { name: /comms/i }).first()).toBeVisible();
  });

  test("md/lg show CompactMissionClock and hide the full clock", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.md);
    await signIn(page);
    await expect(page.getByTestId("mission-clock-compact")).toBeVisible();
    const full = page.getByTestId("mission-clock");
    if (await full.count()) {
      await expect(full).toBeHidden();
    }
  });

  test("stage mode at lg with a loaded scenario renders all 3 stage-cluster controls", async ({ page }) => {
    // Required scenario from done-criteria: stage mode + 1440 + Failsafe
    // visible = the cluster groups Failsafe + Reset + Audit. Pre-seed the
    // scenarioPlayer sessionStorage so the Failsafe gate is open.
    await page.setViewportSize(BREAKPOINTS.lg);
    await enableStageMode(page);
    await preloadScenario(page);
    await signIn(page, SECURITY_MANAGER_DODID);
    const cluster = page.getByTestId("stage-cluster");
    await expect(cluster).toBeVisible();
    await expect(cluster).toHaveAttribute("data-stage-mode", "1");
    await expect(cluster.getByTestId("stage-cluster-failsafe")).toBeVisible();
    await expect(cluster.getByTestId("stage-cluster-reset")).toBeVisible();
    await expect(cluster.getByTestId("stage-cluster-audit")).toBeVisible();
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

  test("sm hides the MissionClock — System chip mission-timeline row is the fallback", async ({ page }) => {
    // Per the spec the compact clock renders only at md+. At sm the
    // chrome is too cramped for the chip; the System chip dropdown's
    // Mission timeline row owns the access path (clicking it fires the
    // `spire:open-mission-clock` event which expands the clock from the
    // System chip's stacking context).
    await page.setViewportSize(BREAKPOINTS.sm);
    await signIn(page);
    const compact = page.getByTestId("mission-clock-compact");
    if (await compact.count()) {
      await expect(compact).toBeHidden();
    }
    // System chip is part of the spine — present at every breakpoint.
    await expect(page.getByTestId("system-status-chip")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("system-status-chip").click();
    await expect(page.getByTestId("system-status-panel")).toContainText(/Mission timeline/i);
  });

  test("MissionClock dropdown opens and is not clipped by neighbouring chrome", async ({ page }) => {
    // PR #181 fix: the header sits at z-[60] so the MissionClock dropdown
    // (z-[8500] inside the header) is no longer covered by view content.
    // We open the dropdown and assert the menu is visible — if any
    // surrounding stacking context (StatusStrip, banners, etc.) clipped
    // it the toBeVisible() check would fail.
    await page.setViewportSize(BREAKPOINTS.xl);
    await signIn(page);
    const clock = page.getByTestId("mission-clock");
    await expect(clock).toBeVisible();
    await clock.click();
    const menu = page.getByRole("menu", { name: /mission clock controls/i });
    await expect(menu).toBeVisible();
    // Sanity: the menu is wider than 0px and present in the layout.
    const box = await menu.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(50);
  });

  test("System chip dropdown surfaces all three underlying statuses", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.xl);
    await signIn(page);
    // Dismiss any racing onboarding modal so the chip click isn't
    // intercepted (see IdentityPill spec for the same dance).
    await page.keyboard.press("Escape");
    await page.getByTestId("system-status-chip").click();
    const panel = page.getByTestId("system-status-panel");
    await expect(panel).toBeVisible();
    // The consolidated chip merged NodeStatus (sync), GcssMcSyncPill
    // (gcss), and ModeBadge (the mode value renders as the node label
    // "MLG-NODE-0 · <mode>"). Each surface is named in the panel.
    await expect(panel).toContainText(/sync/i);
    await expect(panel).toContainText(/gcss/i);
    await expect(panel).toContainText(/MLG-NODE-0/);
  });

  test("md (1024px) keeps the critical chips visible — survives the cramped breakpoint", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.md);
    await signIn(page);
    // The whole point of the declutter: at 1024 the spine still holds.
    await expect(page.getByTestId("topbar-root")).toBeVisible();
    await expect(page.getByTestId("system-status-chip")).toBeVisible();
    await expect(page.getByTestId("notifications-chip")).toBeVisible();
    await expect(page.getByRole("button", { name: /comms/i }).first()).toBeVisible();
    await expect(page.getByTestId("mission-clock-compact")).toBeVisible();
    await expect(page.getByTestId("topbar-identity-pill")).toBeVisible();
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

  test("stage mode at lg renders the StageCluster with Reset + Audit grouped", async ({ page }) => {
    await page.setViewportSize(BREAKPOINTS.lg);
    await enableStageMode(page);
    // Reset is g4-only outside stage mode; in stage mode it relaxes to
    // any role. Sign in as Park (security_manager) to verify the relax.
    await signIn(page, SECURITY_MANAGER_DODID);
    const cluster = page.getByTestId("stage-cluster");
    await expect(cluster).toBeVisible();
    await expect(cluster).toHaveAttribute("data-stage-mode", "1");
    // In stage mode the cluster groups all three controls. Failsafe is
    // gated on a loaded scenario (same gate as the original chrome) and
    // the spec doesn't trigger one, so it's absent here — Reset and
    // Audit are the two stage-only controls that always render.
    await expect(cluster.getByTestId("stage-cluster-reset")).toBeVisible();
    await expect(cluster.getByTestId("stage-cluster-audit")).toBeVisible();
    await expect(cluster.getByTestId("stage-cluster-failsafe")).toHaveCount(0);
  });

  test("operator mode never shows the StageCluster — chrome stays decluttered", async ({ page }) => {
    // Stage-only contract: the cluster must NOT appear in operator mode
    // for any role, regardless of scenario state. Reset (g4) and Failsafe
    // (when scenario loaded) are reachable through the IdentityPill
    // Operator settings → Demo controls section instead.
    await page.setViewportSize(BREAKPOINTS.lg);
    await signIn(page, TEST_DODID);
    await expect(page.getByTestId("stage-cluster")).toHaveCount(0);
    // Operator spine intact: System + Notif + Comms + Identity.
    await expect(page.getByTestId("system-status-chip")).toBeVisible();
    await expect(page.getByTestId("notifications-chip")).toBeVisible();
    await expect(page.getByTestId("topbar-identity-pill")).toBeVisible();
  });

  test("operator mode for non-g4 keeps spine intact, no StageCluster, no Demo controls", async ({ page }) => {
    // Park (security_manager) outside stage mode with no scenario:
    // - StageCluster: absent (stage-only)
    // - Demo controls: absent (Reset is g4-only, Failsafe needs scenario)
    // - Spine: present
    await page.setViewportSize(BREAKPOINTS.lg);
    await signIn(page, SECURITY_MANAGER_DODID);
    await expect(page.getByTestId("stage-cluster")).toHaveCount(0);
    await expect(page.getByTestId("system-status-chip")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.getByTestId("topbar-identity-pill").click();
    await expect(page.getByTestId("identity-operator-settings")).toBeVisible();
    await expect(page.getByTestId("identity-demo-controls")).toHaveCount(0);
  });

  test("IdentityPill Demo controls expose Reset for g4 in operator mode (cluster replacement)", async ({ page }) => {
    // The pre-declutter chrome had `<ResetDemoButton />` inline for g4
    // outside stage mode. The cluster moved to stage-only, so the Reset
    // affordance migrated to IdentityPill → Operator settings → Demo
    // controls. Same role gate, different surface.
    await page.setViewportSize(BREAKPOINTS.lg);
    await signIn(page, TEST_DODID);
    await page.keyboard.press("Escape");
    await page.getByTestId("topbar-identity-pill").click();
    await expect(page.getByTestId("identity-demo-controls")).toBeVisible();
    await expect(page.getByTestId("identity-reset-demo")).toBeVisible();
    // No scenario loaded → Failsafe row is correctly hidden.
    await expect(page.getByTestId("identity-failsafe")).toHaveCount(0);
  });

  test("System chip drawer cycles through no-conflicts and conflicts-present states", async ({ page }) => {
    // Task #192 — the consolidated SystemStatusChip drawer re-uses
    // NodeStatus's exported ClockCard + ConflictRow. The Task #184 spec
    // only proves the chip renders; this spec exercises the drawer end
    // to end so a regression in either exported helper can't silently
    // break the consolidated surface.
    await page.setViewportSize(BREAKPOINTS.xl);
    await signIn(page, SECURITY_MANAGER_DODID);
    await page.keyboard.press("Escape");

    // Backend conflict storage is module-level memory and may carry
    // residue from earlier specs. Pre-clear via the resolve API so the
    // first half of this spec lands cleanly in the "no conflicts" state.
    const list = await page.request.get("/api/system/sync/conflicts");
    if (list.ok()) {
      const body = await list.json();
      for (const c of (body.pending ?? []) as Array<{ id: string }>) {
        await page.request.post(
          `/api/system/sync/resolve/${encodeURIComponent(c.id)}`,
          { data: { winner: "local", actor: "security_manager" } },
        );
      }
    }
    // Reload so the chip's polling picks up the cleaned-out state
    // immediately (its fingerprint back-off would otherwise stretch the
    // refresh window past this spec's budget).
    await page.reload();
    await page.keyboard.press("Escape");

    await page.getByTestId("system-status-chip").click();
    const panel = page.getByTestId("system-status-panel");
    await expect(panel).toBeVisible();

    // The drawer trigger only mounts once syncState has resolved.
    const opener = page.getByTestId("system-status-open-conflicts");
    await expect(opener).toBeVisible({ timeout: 10_000 });
    // After the cleanup the trigger reads "Open drawer", not "Resolve N".
    await expect(opener).toContainText(/open drawer/i);
    await opener.click();

    const drawer = page.getByRole("dialog", { name: /distributed sync drawer/i });
    await expect(drawer).toBeVisible();

    // ClockCard pair (NodeStatus's exported helper) renders the local +
    // peer vector-clock columns side-by-side. Match on the column
    // prefix only — node IDs are env-configurable (SPIRE_NODE_ID /
    // SPIRE_PEER_NODE_ID) and we don't want this spec to wedge in a CI
    // env that overrides them.
    await expect(drawer.getByText(/^Local · \S/)).toBeVisible();
    await expect(drawer.getByText(/^Peer · \S/)).toBeVisible();

    // No-conflicts state — the empty banner + the (0) count both show.
    await expect(drawer.getByText(/Pending conflicts \(0\)/i)).toBeVisible();
    await expect(
      drawer.getByText(/NO CONFLICTS — clocks reconciled/i),
    ).toBeVisible();
    // Pre-condition for the conflicts-present half: no ConflictRow yet.
    await expect(drawer.getByRole("button", { name: /^pick$/i })).toHaveCount(0);

    // Seed a demo conflict from inside the drawer and assert the
    // empty state collapses + a ConflictRow appears with the local +
    // peer vector-clock columns the task requires.
    await drawer.getByRole("button", { name: /seed demo conflict/i }).click();
    await expect(drawer.getByText(/Pending conflicts \(1\)/i)).toBeVisible({ timeout: 10_000 });
    await expect(
      drawer.getByText(/NO CONFLICTS — clocks reconciled/i),
    ).toHaveCount(0);
    // ConflictRow renders Local + Peer sides (one Pick button each) and
    // each side surfaces a `clock:` line containing the vector-clock
    // JSON — that's the affordance the resolution UI hinges on.
    await expect(drawer.getByRole("button", { name: /^pick$/i })).toHaveCount(2);
    const clockLines = drawer.getByText(/clock:/i);
    expect(await clockLines.count()).toBeGreaterThanOrEqual(2);

    // Leave the backend tidy so downstream specs don't inherit the
    // seeded conflict (module-level state survives across pages).
    const after = await page.request.get("/api/system/sync/conflicts");
    if (after.ok()) {
      const body = await after.json();
      for (const c of (body.pending ?? []) as Array<{ id: string }>) {
        await page.request.post(
          `/api/system/sync/resolve/${encodeURIComponent(c.id)}`,
          { data: { winner: "local", actor: "security_manager" } },
        );
      }
    }
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
