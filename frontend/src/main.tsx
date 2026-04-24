import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import App from "./App";
import { SentryView } from "./views/SentryView";
import { PulseView } from "./views/PulseView";
import { BastionView } from "./views/BastionView";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />}>
          <Route index element={<Navigate to="/sentry" replace />} />
          <Route path="sentry/*" element={<SentryView />} />
          <Route path="pulse/*" element={<PulseView />} />
          <Route path="bastion/*" element={<BastionView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>
);
