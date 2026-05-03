import { StrictMode, lazy, Suspense, useEffect } from "react";
import { createRoot } from "react-dom/client";
// HashRouter over BrowserRouter: SPIRE is designed to run from a local file
// path as well as a localhost server. HashRouter works in both contexts and
// keeps deep links (sentry/review, pulse/cannibalization) functional if a
// judge reloads or clicks a share link while we're offline.
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";

// Self-hosted fonts — eliminates the Google Fonts cross-origin DNS +
// TLS handshake on every cold start. Vite emits these as same-origin
// woff2 with content-hash + 1y immutable cache (see nginx.fly.conf).
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";

import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ScopeGuard } from "./components/ScopeGuard";
import { AuthView } from "./views/AuthView";
// ClassificationBannerStrip is rendered once in App.tsx (the app shell) —
// see Walkthrough #JOB-F. Importing it here would invite a second instance
// in the Suspense fallback, the exact duplication this fix eliminates.
import { registerRoleSource, registerUnauthenticatedHandler, registerDdilHandlers } from "./api";
import { useSpireStore, ROLE_DEFAULT_VIEW } from "./state/store";
import "./index.css";

// Code-split the four heavy view trees. Initial bundle drops from ~258 KB
// gzipped to a ~88 KB shell + lazy chunks per view. The classification
// band is rendered as the Suspense fallback so first paint of any route
// is instant — judges never see a blank pane while the chunk lands.
//
// Stale-chunk recovery: when a deploy ships, hashed chunk filenames change.
// A returning user's cached index.html still references the old hashes —
// dynamic-import then 503s and React's lazy() throws "Failed to fetch
// dynamically imported module." We catch that specifically and force a
// hard reload (which pulls the fresh index.html with the new hashes).
// Without this, every deploy crashed the app for any user with a stale tab.
function lazyWithRecovery<T extends { default: React.ComponentType<any> }>(loader: () => Promise<T>) {
  return lazy(async () => {
    try {
      return await loader();
    } catch (err) {
      const msg = String(err);
      const isChunkFail = /failed to fetch dynamically imported module|Loading chunk \d+ failed|importing.*chunk/i.test(msg);
      if (isChunkFail) {
        // Avoid an infinite reload loop: only reload once per session.
        const flag = "spire.chunk_reload_attempted";
        if (!sessionStorage.getItem(flag)) {
          sessionStorage.setItem(flag, "1");
          window.location.reload();
          // Throwing keeps Suspense from resolving against a stale chunk
          // while the reload kicks in.
          throw err;
        }
      }
      throw err;
    }
  });
}

const SentryView  = lazyWithRecovery(() => import("./views/SentryView").then((m) => ({ default: m.SentryView })));
const PulseView   = lazyWithRecovery(() => import("./views/PulseView").then((m) => ({ default: m.PulseView })));
const BastionView = lazyWithRecovery(() => import("./views/BastionView").then((m) => ({ default: m.BastionView })));
const AdminView   = lazyWithRecovery(() => import("./views/AdminView").then((m) => ({ default: m.AdminView })));
const AuditView   = lazyWithRecovery(() => import("./views/admin/AuditView").then((m) => ({ default: m.AuditView })));
// W1 #30 — Model registry / supply-chain page. Restricted to security_manager.
const ModelRegistryView = lazyWithRecovery(() => import("./views/admin/ModelRegistryView").then((m) => ({ default: m.ModelRegistryView })));
const ModelDetailView   = lazyWithRecovery(() => import("./views/admin/ModelDetailView").then((m) => ({ default: m.ModelDetailView })));
const InferenceEconomicsView = lazyWithRecovery(() => import("./views/admin/InferenceEconomicsTab").then((m) => ({ default: m.InferenceEconomicsView })));
// RD9 — operator-side real-data ingest dropzone. Scoped to
// data_custodian + security_manager via VIEW_SCOPE.
const IngestView = lazyWithRecovery(() => import("./views/admin/IngestView").then((m) => ({ default: m.IngestView })));
// E1 hardened-primitives gallery — design/QA surface for verifying every
// variant of every primitive renders correctly. Not in role-based nav;
// reachable only by direct deep link (#/__ui-docs).
const UiDocsView  = lazyWithRecovery(() => import("./views/UiDocsView").then((m) => ({ default: m.UiDocsView })));
// W1 lane: /about/team — pure-content page (warfighter customer + team).
// Not role-gated; reachable to any authenticated user from the help menu.
const AboutTeamView = lazyWithRecovery(() => import("./views/AboutTeamView").then((m) => ({ default: m.AboutTeamView })));
// W1 transition pathway page — linkable from the Help overlay so a TORCH-class
// judge can read the SBIR→MTA-RP plan without leaving the app.
const TransitionView = lazyWithRecovery(() => import("./views/TransitionView").then((m) => ({ default: m.TransitionView })));
// Integrations / system-of-record adapter contracts. Wave-1 lane (#27);
// currently scoped to GCSS-MC. No role-gate — every operator can read the
// adapter posture as part of the inoculation-via-honesty narrative.
const IntegrationsView = lazyWithRecovery(() => import("./views/IntegrationsView").then((m) => ({ default: m.IntegrationsView })));
// Joint COP export — sister-service partner viewer (no SPIRE chrome) and
// the integrations / conformance documentation surface. Both lazy.
const JointPreviewView      = lazyWithRecovery(() => import("./views/JointPreviewView").then((m) => ({ default: m.JointPreviewView })));
const JointIntegrationsView = lazyWithRecovery(() => import("./views/JointIntegrationsView").then((m) => ({ default: m.JointIntegrationsView })));
// Task-24 — "15-second decision" hero dashboard. Lives at `/`. The
// previous role-default redirect is preserved at `/home` as a fallback
// + escape hatch for operators who prefer landing directly on their
// scoped surface.
const DecisionBridgeView = lazyWithRecovery(() => import("./views/DecisionBridge").then((m) => ({ default: m.DecisionBridgeView })));
// /pitch deck retired — the live SPIRE walkthrough IS the pitch.
// PitchView source kept under views/pitch for git history; route
// removed below.
// W2 Task #37 — `/demo` scripted scenario cockpit. Lazy because the
// surface is presenter-only; no operator ever has to download the chunk
// during normal use.
const DemoView = lazyWithRecovery(() => import("./views/DemoView").then((m) => ({ default: m.DemoView })));
// MDM 2026 stage-pivot — first-class landing for the DHA RESCUE
// (Class VIII / blood resupply) hero use case. Lazy: the view is only
// reached from the stage-mode Decision Bridge.
const DhaRescueView = lazyWithRecovery(() => import("./views/DhaRescueView").then((m) => ({ default: m.DhaRescueView })));

// Expose the active role to the API layer. Every GET/POST now splices it as
// `?role=...` so the backend's scoping filter applies per-call.
registerRoleSource(() => useSpireStore.getState().role);

// MDM 2026 stage-pivot — hydrate `stageMode` from the URL hash query
// string before the store renders. HashRouter parks the query inside the
// hash (`#/path?stage=1`), so we parse the hash first and fall back to a
// bare `?stage=1` on the document URL. `?stage=1` enables; `?stage=0`
// (or any other value) disables. The state is also persisted to
// localStorage so a hard reload, a fresh tab, or a popout window all
// inherit the stage layout without re-passing the URL parameter.
(function hydrateStageModeFromUrl() {
  if (typeof window === "undefined") return;
  try {
    const hash = window.location.hash || "";
    const hashQ = hash.indexOf("?");
    const queries: string[] = [];
    if (hashQ >= 0) queries.push(hash.slice(hashQ + 1));
    if (window.location.search) queries.push(window.location.search.replace(/^\?/, ""));
    let stageParam: string | null = null;
    for (const q of queries) {
      const sp = new URLSearchParams(q);
      if (sp.has("stage")) {
        stageParam = sp.get("stage");
        break;
      }
    }
    if (stageParam == null) return;
    useSpireStore.getState().setStageMode(stageParam === "1");
  } catch {
    /* tolerant — don't crash boot on a malformed URL */
  }
})();

// W1 — Wire the DDIL interceptor's view of the store. The api layer stays
// Zustand-agnostic; this adapter is the single binding point. Cache TTL
// is generous (10 minutes) so a DDIL drill that lasts a minute still has
// fresh-enough cached reads to serve from.
const DDIL_CACHE_TTL_MS = 10 * 60 * 1000;
registerDdilHandlers({
  getMode: () => useSpireStore.getState().ddilMode,
  cacheRead: (key, body) => useSpireStore.getState().cacheDdilRead(key, body),
  readCache: (key) => {
    const hit = useSpireStore.getState().ddilCache[key];
    if (!hit) return null;
    const ageMs = Date.now() - hit.cachedAt;
    if (ageMs > DDIL_CACHE_TTL_MS) return null;
    return { body: hit.body, ageMs };
  },
  queueWrite: ({ method, path, body, actor }) => {
    const entry = useSpireStore.getState().enqueueDdilWrite({ method, path, body, actor });
    return entry.id;
  },
  noteCacheHit: (key, _ageMs, cachedAt) => {
    useSpireStore.getState().noteDdilCacheHit(key, cachedAt);
  },
});

// Send users to their role-appropriate home view on first load.
function HomeRoute() {
  const role = useSpireStore.getState().role;
  return <Navigate to={ROLE_DEFAULT_VIEW[role] ?? "/bastion"} replace />;
}

// Auth gate. Wraps every authenticated route; if there's no `currentUser`
// in the store, redirect to /auth and remember the intended path so we can
// land them there after sign-in.
//
// The HttpOnly session cookie is the server's source of truth; the store's
// `currentUser` is a same-tab cache hydrated from sessionStorage. If the
// cookie is missing/expired, the next /api/* call will return 401 and the
// global 401 handler clears the store -> we re-render here -> redirect.
function RequireAuth({ children }: { children: React.ReactNode }) {
  const currentUser = useSpireStore((s) => s.currentUser);
  const loc = useLocation();
  if (!currentUser) {
    const intended = loc.pathname + loc.search + loc.hash;
    return <Navigate to="/auth" state={{ from: intended === "/auth" ? "/" : intended }} replace />;
  }
  return <>{children}</>;
}

// Bridges the api layer's 401 callback to React-Router so any /api/* that
// returns 401 mid-session signs the user out and bounces them to /auth.
// Mounted once at the root.
//
// MDM 2026 stage-pivot — when the store is in `stageMode` we DO NOT
// bounce the presenter to `/auth` on a transient 401 (the 4-step cert-
// pick → PIN → sign-in dance is fatal under stage lights). Instead we
// surface a non-blocking toast inviting the presenter to tap any
// identity chip in the TopBar to resume; the IdentityChips strip will
// re-issue a session via quick-switch (or PIN-fallback) on the next
// click. Outside stage mode the original behaviour is preserved
// byte-for-byte so operators still get the secure redirect.
function UnauthenticatedBridge() {
  const signOut = useSpireStore((s) => s.signOut);
  const pushToast = useSpireStore((s) => s.pushToast);
  const nav = useNavigate();
  const loc = useLocation();
  useEffect(() => {
    registerUnauthenticatedHandler(() => {
      // Only act if the store still thinks we're signed in — avoids
      // re-running on the 401 from /api/auth/me right after sign-out.
      if (!useSpireStore.getState().currentUser) return;
      if (useSpireStore.getState().stageMode) {
        // Stage path: keep the presenter in place, surface a toast.
        // We deliberately do NOT signOut() here because the IdentityChips
        // strip in the TopBar can re-mint a session on the next click
        // and the BASTION/DHA surface remains visually intact in the
        // meantime. The toast is the only audience-visible signal.
        pushToast({
          tone: "warn",
          text: "Session expired — tap any identity chip to resume.",
          ttlMs: 6000,
        });
        return;
      }
      // Operator path: clear local state and bounce to /auth.
      signOut();
      const intended = loc.pathname + loc.search + loc.hash;
      nav("/auth", { state: { from: intended }, replace: true });
    });
    return () => registerUnauthenticatedHandler(() => {});
  }, [nav, signOut, loc, pushToast]);
  return null;
}

// Lightweight Suspense fallback. The app shell (App.tsx) already renders
// ClassificationBannerStrip once at the top of the page; the Outlet sits
// inside <main>, so the U-banner stays visible across transitions. We DO
// NOT render a second strip here — Walkthrough #JOB-F (review
// SENTRY #26) caught a duplicate banner briefly appearing at y=212 during
// role swaps because the fallback rendered its own band inside the
// Outlet while the shell's band was still mounted above. Single source
// of truth for the banner is App.tsx; the fallback now only fills the
// view region with a status line.
function ViewSuspense({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full flex-col">
          <div className="flex flex-1 items-center justify-center font-mono text-sm uppercase tracking-[0.22em] text-[var(--color-text-muted)]">
            Loading…
          </div>
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary scope="app">
      <HashRouter>
        <UnauthenticatedBridge />
        <Routes>
          {/* Cert-selection splash — outside the App shell so no chrome
           * leaks onto the surface. */}
          <Route path="/auth" element={<AuthView />} />
          {/* Joint COP partner view — opened in a new tab from the SPIRE
           * topbar, intentionally rendered without SPIRE chrome so judges
           * see the data in a sister-service shell, not the parent app.
           *
           * NOT wrapped in RequireAuth: the HttpOnly session cookie IS
           * shared across tabs (cross-tab) but the same-tab sessionStorage
           * cache the auth gate consults is NOT. Without this exception,
           * "Push to Joint COP" opens a new tab that bounces straight to
           * /auth even though the operator is signed in. The view itself
           * calls /api/joint/oms-uci/export which still re-checks the
           * cookie + clearance gate server-side. */}
          <Route path="/joint/preview" element={<ViewSuspense><JointPreviewView /></ViewSuspense>} />
          {/* Integrations / conformance docs — same treatment. The doc is
           * authored from /api/joint/conformance which is auth-gated by
           * the session middleware; the view shows a friendly "sign in
           * to SPIRE first" if the cookie is missing. */}
          <Route path="/integrations/joint" element={<ViewSuspense><JointIntegrationsView /></ViewSuspense>} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <App />
              </RequireAuth>
            }
          >
            <Route index element={<ViewSuspense><DecisionBridgeView /></ViewSuspense>} />
            {/* Role-default fallback — preserved for operators who prefer
             * landing on their scoped surface instead of the bridge. */}
            <Route path="home" element={<HomeRoute />} />
            <Route
              path="sentry/*"
              element={
                <ScopeGuard view="/sentry">
                  <ViewSuspense><SentryView /></ViewSuspense>
                </ScopeGuard>
              }
            />
            <Route
              path="pulse/*"
              element={
                <ScopeGuard view="/pulse">
                  <ViewSuspense><PulseView /></ViewSuspense>
                </ScopeGuard>
              }
            />
            <Route
              path="bastion/*"
              element={
                <ScopeGuard view="/bastion">
                  <ViewSuspense><BastionView /></ViewSuspense>
                </ScopeGuard>
              }
            />
            {/* GC-6 Admin / Training Flywheel — Security Manager only,
             * scope-gated inside the view itself. */}
            <Route path="admin" element={<ViewSuspense><AdminView /></ViewSuspense>} />
            <Route path="admin/audit" element={<ViewSuspense><AuditView /></ViewSuspense>} />
            {/* W1 #30 — Model registry / supply-chain page. Per-model
             * cards documenting provenance, hosting target, FedRAMP
             * status, vendor jurisdiction, validation history. The
             * inline guards mirror the backend MODEL_REGISTRY_ROLES
             * gate. Cross-linked from SENTRY Review Queue. */}
            <Route path="admin/models" element={<ViewSuspense><ModelRegistryView /></ViewSuspense>} />
            <Route path="admin/models/:modelId" element={<ViewSuspense><ModelDetailView /></ViewSuspense>} />
            <Route path="admin/economics" element={<ViewSuspense><InferenceEconomicsView /></ViewSuspense>} />
            <Route path="admin/ingest" element={<ViewSuspense><IngestView /></ViewSuspense>} />
            {/* E1 hardened-primitives gallery — design/QA surface only.
             * Not gated, intentionally hidden from nav. */}
            <Route path="__ui-docs" element={<ViewSuspense><UiDocsView /></ViewSuspense>} />
            {/* W1 — about/team. Reachable from the help menu. No role
             * scope: pure content, available to anyone signed in. */}
            <Route path="about/team" element={<ViewSuspense><AboutTeamView /></ViewSuspense>} />
            {/* W1 about / transition pathway — linkable from Help. No
             * scope guard; this is unclassified company / program info. */}
            <Route path="about/transition" element={<ViewSuspense><TransitionView /></ViewSuspense>} />
            {/* GCSS-MC integration contract page (Wave-1 lane #27). The
             * `:system` slug is fixed to `gcss-mc` for now — only one
             * adapter contract exists — but the path keeps room for
             * follow-on integrations (palantir, magtf-ii) without a
             * router change. */}
            <Route path="integrations/:system" element={<ViewSuspense><IntegrationsView /></ViewSuspense>} />
            {/* Bare /integrations redirects to the default system —
             * MORE menu used to point here and rendered an empty
             * Outlet because no route matched without :system. */}
            <Route path="integrations" element={<Navigate to="/integrations/gcss-mc" replace />} />
            {/* /pitch retired — redirect to home so any old links / muscle
             * memory routes back into Decision Bridge instead of rendering
             * a blank Outlet. */}
            <Route path="pitch" element={<Navigate to="/" replace />} />
            <Route path="pitch/*" element={<Navigate to="/" replace />} />
            {/* W2 Task #37 — `/demo` presenter cockpit. Inside the App
             * shell so the scripted player can navigate to operator
             * surfaces without losing chrome. No ScopeGuard: the cockpit
             * itself is read-only, and the scenarioControl seek calls
             * are role-checked server-side. */}
            <Route path="demo" element={<ViewSuspense><DemoView /></ViewSuspense>} />
            {/* MDM 2026 stage-pivot — DHA RESCUE first-class surface.
             * Reachable from the stage-mode Decision Bridge as the
             * fourth hero use-case tile. No role gate: it's a
             * presenter-facing summary + drill-into BASTION for the
             * Class VIII / blood resupply vignette. */}
            <Route path="dha-rescue" element={<ViewSuspense><DhaRescueView /></ViewSuspense>} />
          </Route>
        </Routes>
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>
);

// Remove the static hero once React has hydrated. Done on the next animation
// frame so the React tree paints before we yank the placeholder — no
// flash-of-unstyled-content.
requestAnimationFrame(() => {
  const hero = document.getElementById("spire-static-hero");
  if (hero) hero.remove();
});
