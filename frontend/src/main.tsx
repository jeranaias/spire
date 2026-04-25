import { StrictMode } from "react";
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
import { SentryView } from "./views/SentryView";
import { PulseView } from "./views/PulseView";
import { BastionView } from "./views/BastionView";
import { AdminView } from "./views/AdminView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ScopeGuard } from "./components/ScopeGuard";
import { registerRoleSource } from "./api";
import { useSpireStore, ROLE_DEFAULT_VIEW } from "./state/store";
import "./index.css";

// Expose the active role to the API layer. Every GET/POST now splices it as
// `?role=...` so the backend's scoping filter applies per-call.
registerRoleSource(() => useSpireStore.getState().role);

// Send users to their role-appropriate home view on first load.
function HomeRoute() {
  const role = useSpireStore.getState().role;
  return <Navigate to={ROLE_DEFAULT_VIEW[role] ?? "/bastion"} replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<HomeRoute />} />
            <Route
              path="sentry/*"
              element={
                <ScopeGuard view="/sentry">
                  <SentryView />
                </ScopeGuard>
              }
            />
            <Route
              path="pulse/*"
              element={
                <ScopeGuard view="/pulse">
                  <PulseView />
                </ScopeGuard>
              }
            />
            <Route
              path="bastion/*"
              element={
                <ScopeGuard view="/bastion">
                  <BastionView />
                </ScopeGuard>
              }
            />
            {/* GC-6 Admin / Training Flywheel — Security Manager only,
             * scope-gated inside the view itself. */}
            <Route path="admin" element={<AdminView />} />
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
