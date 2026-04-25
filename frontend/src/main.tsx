import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// HashRouter over BrowserRouter: SPIRE is designed to run from a local file
// path as well as a localhost server. HashRouter works in both contexts and
// keeps deep links (sentry/review, pulse/cannibalization) functional if a
// judge reloads or clicks a share link while we're offline.
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import { SentryView } from "./views/SentryView";
import { PulseView } from "./views/PulseView";
import { BastionView } from "./views/BastionView";
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
          </Route>
        </Routes>
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>
);
