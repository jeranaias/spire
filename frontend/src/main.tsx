import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
// HashRouter over BrowserRouter: SPIRE is designed to run from a local file
// path as well as a localhost server. HashRouter works in both contexts and
// keeps deep links (sentry/review, pulse/cannibalization) functional if a
// judge reloads or clicks a share link while we're offline.
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";

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
import { ClassificationBand } from "./components/ClassificationBand";
import { registerRoleSource } from "./api";
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

// Expose the active role to the API layer. Every GET/POST now splices it as
// `?role=...` so the backend's scoping filter applies per-call.
registerRoleSource(() => useSpireStore.getState().role);

// Send users to their role-appropriate home view on first load.
function HomeRoute() {
  const role = useSpireStore.getState().role;
  return <Navigate to={ROLE_DEFAULT_VIEW[role] ?? "/bastion"} replace />;
}

// Lightweight Suspense fallback — uses the live ClassificationBand so the
// CAPCO U-banner is always visible while a view chunk is loading. Keeps
// the chrome continuous and prevents a "flash of empty" between navs.
function ViewSuspense({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="flex h-full flex-col">
          <ClassificationBand />
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
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<HomeRoute />} />
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
