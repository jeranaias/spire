/**
 * Classification Banner Coverage — Task #152.
 *
 * DoDM 5200.01-V2 requires a page-level classification marking at the
 * top AND bottom of every screen rendering DoD information. SPIRE's
 * synthetic dataset is unclassified, but the marking still doubles as
 * a "DEMO DATA / NOT FOR OPERATIONAL USE" disclaimer that has to be
 * impossible to miss — every projected pane, every shared screenshot,
 * every demo URL a judge might land on.
 *
 * Task #28 mounted the strip globally in the App shell and on the
 * /auth splash. The trap (the same one /joint/preview originally fell
 * into) is that any future route that ships outside the App shell
 * silently loses the marking with no automated signal. This spec is
 * the guardrail.
 *
 * It is *source-driven* by `frontend/src/main.tsx`:
 *   1. The spec parses main.tsx at suite-load time, extracts every
 *      `<Route path="...">` declaration, and builds the absolute path
 *      list (top-level absolute routes ∪ shell-relative routes
 *      prefixed with "/").
 *   2. Pure `<Navigate>` redirect routes (no screen of their own) are
 *      skipped — their target route is what actually renders.
 *   3. Every remaining route must have a corresponding entry in the
 *      `ROUTE_TEST_PLAN` table that pairs it with the concrete URL
 *      to navigate to (substituting :params and /* wildcards) and an
 *      auth requirement. The spec emits a synthetic failing test if
 *      a new route is added to main.tsx without an entry in the plan
 *      — that's the source-of-truth tie that keeps the guardrail
 *      from rotting silently.
 *   4. For each planned route, the spec asserts both
 *      [data-classification-strip="top"] and [data-classification-strip="bottom"]
 *      are present, visible (non-zero `getBoundingClientRect()`),
 *      and carry the canonical
 *      "UNCLASSIFIED // DEMO DATA // NOT FOR OPERATIONAL USE".
 *
 * If a new route ships without satisfying this contract, the suite
 * fails before the build reaches a judge.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { signIn, SECURITY_MANAGER_DODID } from "./_helpers";

const EXPECTED_TEXT = "UNCLASSIFIED // DEMO DATA // NOT FOR OPERATIONAL USE";

// ---------------------------------------------------------------------
// Source-of-truth extraction from frontend/src/main.tsx
// ---------------------------------------------------------------------

const MAIN_TSX = path.join(
  __dirname,
  "..",
  "..",
  "frontend",
  "src",
  "main.tsx",
);

/**
 * Extract every `<Route path="...">` pattern from main.tsx, classifying
 * each as either a top-level absolute path or a shell-relative path
 * (mounted under the `<Route path="/" element={<App />}>` shell).
 *
 * We deliberately keep the parser simple — a regex over the raw source.
 * main.tsx is hand-authored and the Route forms are stable; we don't
 * want to drag a TS AST parser into the e2e harness for this. The
 * trade-off: if the file ever switches to a config-array form of
 * routes, this regex needs an update — that's an acceptable surface
 * because the spec will then visibly fail and force a corresponding
 * fix to the parser.
 */
function extractRoutesFromMainTsx(): {
  absolute: { path: string; isRedirect: boolean }[];
  shellRelative: { path: string; isRedirect: boolean }[];
} {
  const src = fs.readFileSync(MAIN_TSX, "utf8");

  // Locate the App-shell route block:
  //   <Route path="/" element={...<App />...}>
  //     ...children...
  //   </Route>
  // We split the file at "<Route path=\"/\"" and scan children until
  // the matching </Route> close tag. Routes outside that block are
  // top-level absolute; routes inside are shell-relative.
  const shellOpenRe = /<Route\s+path="\/"/;
  const shellOpenMatch = shellOpenRe.exec(src);
  if (!shellOpenMatch) {
    throw new Error(
      "classification_banner_coverage: failed to locate the App-shell <Route path=\"/\"> block in main.tsx",
    );
  }
  const shellStart = shellOpenMatch.index;
  const shellClose = src.indexOf("</Route>", shellStart);
  if (shellClose < 0) {
    throw new Error(
      "classification_banner_coverage: failed to locate the App-shell </Route> close tag in main.tsx",
    );
  }
  const beforeShell = src.slice(0, shellStart);
  const insideShell = src.slice(shellStart, shellClose);
  const afterShell = src.slice(shellClose);

  // Match every Route element. Two shapes:
  //   <Route path="..." element={...} />
  //   <Route index element={...} />          ← children of <Route path="/">
  // Allow whitespace / newlines between attributes (the
  // sentry/pulse/bastion routes wrap their attrs onto separate lines).
  const pathRouteRe = /<Route\b[\s\S]*?\bpath="([^"]+)"[\s\S]*?(?:\/>|>)/g;
  const indexRouteRe = /<Route\s+index\b[\s\S]*?(?:\/>|>)/g;

  function isRedirect(matchText: string): boolean {
    // <Route ... element={<Navigate to="..." replace />} />
    return /<Navigate\s/.test(matchText);
  }

  function harvest(
    slice: string,
    { includeIndex }: { includeIndex: boolean },
  ): { path: string; isRedirect: boolean }[] {
    const out: { path: string; isRedirect: boolean }[] = [];
    let m: RegExpExecArray | null;
    pathRouteRe.lastIndex = 0;
    while ((m = pathRouteRe.exec(slice))) {
      const p = m[1];
      // Skip the App-shell parent itself ("/").
      if (p === "/") continue;
      out.push({ path: p, isRedirect: isRedirect(m[0]) });
    }
    if (includeIndex) {
      indexRouteRe.lastIndex = 0;
      while ((m = indexRouteRe.exec(slice))) {
        // The index route inside <Route path="/"> renders at "/".
        // Treat it as the special path "/" for plan purposes.
        out.push({ path: "/", isRedirect: isRedirect(m[0]) });
      }
    }
    return out;
  }

  const absolute = [
    ...harvest(beforeShell, { includeIndex: false }),
    ...harvest(afterShell, { includeIndex: false }),
  ];
  const shellRelative = harvest(insideShell, { includeIndex: true });
  return { absolute, shellRelative };
}

/**
 * Build the canonical absolute-path list main.tsx ships, with redirect
 * routes filtered out (they don't render a screen of their own — their
 * target does).
 */
function listShippedScreenRoutes(): string[] {
  const { absolute, shellRelative } = extractRoutesFromMainTsx();
  const screens: string[] = [];
  for (const r of absolute) {
    if (r.isRedirect) continue;
    screens.push(r.path);
  }
  for (const r of shellRelative) {
    if (r.isRedirect) continue;
    // The "home" alias is a same-shell HomeRoute that immediately
    // redirects to the role-default view. It renders no screen of
    // its own — covered transitively by /bastion + /pulse + /sentry
    // tests below.
    if (r.path === "home") continue;
    screens.push(r.path.startsWith("/") ? r.path : `/${r.path}`);
  }
  return screens;
}

// ---------------------------------------------------------------------
// Concrete test plan — pairs each shipped route with the URL the spec
// will actually navigate to, plus an auth flag.
// ---------------------------------------------------------------------

interface RoutePlanEntry {
  // Concrete hash-router URL to navigate to. Wildcards (sentry/*) and
  // path params (admin/models/:modelId, integrations/:system) are
  // pinned to a real instance so a real screen renders rather than a
  // 404 fallback. Use a real model id from the registry for the
  // detail route.
  hash: string;
  // Whether the concrete URL needs an authenticated session. We sign
  // in once per test as CWO3 Park (security_manager) — the only mock
  // identity with sentry, admin, admin/audit, admin/models,
  // admin/economics, and bastion in scope. /pulse is out-of-scope
  // for security_manager; the ScopeGuard overlay still renders inside
  // the App shell, so the banner sandwich still holds (which is the
  // contract under test).
  requiresAuth: boolean;
}

/**
 * Source-of-truth-tied plan. Keys are the route patterns extracted
 * from main.tsx; values are the concrete navigations the spec runs.
 *
 * Adding a new <Route> to main.tsx without a matching entry here
 * triggers the synthetic "route registry parity" test below —
 * intentional, because every shipped screen has to be reasoned about
 * for the marking contract.
 */
const ROUTE_TEST_PLAN: Record<string, RoutePlanEntry> = {
  // Top-level absolute routes (outside the App shell — each view
  // renders its own banner sandwich).
  "/auth":               { hash: "#/auth",                 requiresAuth: false },
  "/joint/preview":      { hash: "#/joint/preview",        requiresAuth: false },
  "/integrations/joint": { hash: "#/integrations/joint",   requiresAuth: false },
  // Task #95 — security docs page is mounted outside RequireAuth so the
  // AuthView splash can deep-link to it. SecurityView renders its own
  // ClassificationBannerStrip directly (per the comment in main.tsx)
  // so pre-login visitors still see the U-banner. Both `/security` and
  // `/about/security` resolve to the same view.
  "/security":           { hash: "#/security",             requiresAuth: false },
  "/about/security":     { hash: "#/about/security",       requiresAuth: false },

  // App-shell routes (registered as relative paths under <Route path="/">,
  // recorded here in the absolute "/foo" form that listShippedScreenRoutes
  // emits so the parity check can match by exact key).
  // The shell's index route — DecisionBridgeView. The strips are mounted
  // by the shell itself, so the contract holds even if Decision Bridge
  // is empty for the signed-in role.
  "/":                       { hash: "#/",                     requiresAuth: true },
  "/sentry/*":               { hash: "#/sentry/upload",        requiresAuth: true },
  "/pulse/*":                { hash: "#/pulse/overview",       requiresAuth: true },
  "/bastion/*":              { hash: "#/bastion",              requiresAuth: true },
  "/admin":                  { hash: "#/admin",                requiresAuth: true },
  "/admin/audit":            { hash: "#/admin/audit",          requiresAuth: true },
  "/admin/models":           { hash: "#/admin/models",         requiresAuth: true },
  // Pin the detail route to a real, deterministic model id from
  // dataset/data/model_registry.json. Even if the detail fetch errors,
  // the banner contract holds because the strips are mounted by the
  // App shell, not the detail view.
  "/admin/models/:modelId":  { hash: "#/admin/models/copilot-llm", requiresAuth: true },
  "/admin/economics":        { hash: "#/admin/economics",      requiresAuth: true },
  "/about/team":             { hash: "#/about/team",           requiresAuth: true },
  "/about/transition":       { hash: "#/about/transition",     requiresAuth: true },
  "/integrations/:system":   { hash: "#/integrations/gcss-mc", requiresAuth: true },
  "/pitch":                  { hash: "#/pitch",                requiresAuth: true },
  "/demo":                   { hash: "#/demo",                 requiresAuth: true },
  "/dha-rescue":             { hash: "#/dha-rescue",           requiresAuth: true },
  "/__ui-docs":              { hash: "#/__ui-docs",            requiresAuth: true },
  // MDM 2026 stage-pivot (Task #31) — presenter cheat sheet. Mounted
  // inside the App shell, so the App-shell ClassificationBannerStrip
  // brackets it whether the view renders its own card or short-circuits
  // back to "/" when stageMode is off. Either branch satisfies the
  // banner contract.
  "/presenter":              { hash: "#/presenter",            requiresAuth: true },
};

// ---------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------

/**
 * Assert both classification strips are present on the active page,
 * visible (non-zero bounding rect), and carry the canonical text.
 *
 * `getBoundingClientRect()` is the spec's chosen visibility check —
 * it catches both `display:none` and `visibility:hidden` elements as
 * well as zero-sized strips that would otherwise silently swallow
 * the marking. We assert non-zero width AND height because a 1px-tall
 * marking band is functionally invisible on a projector.
 */
async function expectBannerSandwich(page: Page, label: string): Promise<void> {
  for (const position of ["top", "bottom"] as const) {
    const sel = `[data-classification-strip="${position}"]`;
    const locator = page.locator(sel);
    await expect(locator, `${label}: ${position} strip is present`).toHaveCount(1, {
      timeout: 10_000,
    });
    await expect(locator, `${label}: ${position} strip is visible`).toBeVisible();

    const rect = await locator.evaluate((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    expect(
      rect.width,
      `${label}: ${position} strip has non-zero width (got ${rect.width})`,
    ).toBeGreaterThan(0);
    expect(
      rect.height,
      `${label}: ${position} strip has non-zero height (got ${rect.height})`,
    ).toBeGreaterThan(0);

    // Inner-text contract — collapse whitespace so a stray newline or
    // an extra space inside the strip never produces a false-positive
    // failure. The marking must contain the canonical wording verbatim.
    const text = (await locator.innerText()).replace(/\s+/g, " ").trim();
    expect(
      text,
      `${label}: ${position} strip carries the canonical marking`,
    ).toContain(EXPECTED_TEXT);
  }
}

/**
 * Navigate to a route via the hash-router, then wait for the lazy
 * chunk to settle. We don't wait on a per-route DOM signal because
 * the Suspense fallback inside the App shell still renders the
 * banners (the strip is mounted in App.tsx, outside the Outlet) — so
 * the contract holds even mid-load. For routes outside the shell
 * the view itself owns the banners and the strip selectors will
 * appear after the initial render.
 */
async function gotoAndSettle(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => {
    window.location.hash = h;
  }, hash);
  await page.waitForFunction(
    (h) => window.location.hash === h,
    hash,
    { timeout: 5_000 },
  );
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
}

// ---------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------

const SHIPPED_ROUTES = listShippedScreenRoutes();

test.describe("Classification banner coverage (Task #152)", () => {
  // Source-of-truth parity check. If a developer adds a new
  // <Route path="..."> to main.tsx without a matching entry in
  // ROUTE_TEST_PLAN, the suite fails here with a clear message
  // pointing at the missing route — closing the trap that the
  // hardcoded-list version of this spec would otherwise hide.
  test("route registry parity — every shipped route in main.tsx has a banner test plan", () => {
    const planned = new Set(Object.keys(ROUTE_TEST_PLAN));
    const shipped = new Set(SHIPPED_ROUTES);

    const missingPlan: string[] = [];
    for (const r of shipped) {
      if (!planned.has(r)) missingPlan.push(r);
    }
    const stalePlan: string[] = [];
    for (const r of planned) {
      if (!shipped.has(r)) stalePlan.push(r);
    }

    expect(
      missingPlan,
      `frontend/src/main.tsx ships routes that have no banner-coverage test plan entry: ${JSON.stringify(missingPlan)}. Add them to ROUTE_TEST_PLAN in tests/playwright/classification_banner_coverage.spec.ts so the marking is verified.`,
    ).toEqual([]);
    expect(
      stalePlan,
      `ROUTE_TEST_PLAN references routes that no longer exist in frontend/src/main.tsx: ${JSON.stringify(stalePlan)}. Remove the stale entries.`,
    ).toEqual([]);
  });

  // Authenticated routes — sign in once as CWO3 Park (security_manager).
  test.describe("authenticated routes (CWO3 Park · security_manager)", () => {
    const planned = SHIPPED_ROUTES
      .filter((r) => ROUTE_TEST_PLAN[r]?.requiresAuth)
      .map((r) => ({ key: r, plan: ROUTE_TEST_PLAN[r] }));

    test.beforeEach(async ({ page }) => {
      await signIn(page, SECURITY_MANAGER_DODID);
    });

    for (const { key, plan } of planned) {
      test(`${key} carries top + bottom UNCLASSIFIED // DEMO DATA strips`, async ({
        page,
      }) => {
        await gotoAndSettle(page, plan.hash);
        await expectBannerSandwich(page, key);
      });
    }
  });

  // Unauthenticated routes — render their own banner sandwich without
  // a session. /auth carries the marking before any cert is selected;
  // /joint/preview and /integrations/joint were the original out-of-
  // shell trap and now mount their own strips.
  test.describe("unauthenticated routes (no session)", () => {
    const planned = SHIPPED_ROUTES
      .filter((r) => ROUTE_TEST_PLAN[r] && !ROUTE_TEST_PLAN[r].requiresAuth)
      .map((r) => ({ key: r, plan: ROUTE_TEST_PLAN[r] }));

    for (const { key, plan } of planned) {
      test(`${key} carries top + bottom UNCLASSIFIED // DEMO DATA strips (signed out)`, async ({
        page,
      }) => {
        await page.goto(`/${plan.hash}`);
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        await expectBannerSandwich(page, key);
      });
    }
  });
});
