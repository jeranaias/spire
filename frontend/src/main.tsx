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
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Navigate to="/sentry" replace />} />
            <Route path="sentry/*" element={<SentryView />} />
            <Route path="pulse/*" element={<PulseView />} />
            <Route path="bastion/*" element={<BastionView />} />
          </Route>
        </Routes>
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>
);
