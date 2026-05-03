import { useRef } from "react";
import { Routes, Route, NavLink, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { FleetOverviewTab } from "./pulse/FleetOverviewTab";
import { RiskBoardTab } from "./pulse/RiskBoardTab";
import { CannibalizationTab } from "./pulse/CannibalizationTab";
import { ForecastTab } from "./pulse/ForecastTab";
import { ModelTab } from "./pulse/ModelTab";
import { UseCaseStrip } from "../components/UseCaseStrip";
import { AwaitingIngestEmpty } from "../components/AwaitingIngestEmpty";
import { DemoOnly } from "../state/buildMode";
import { useDatasetStatus } from "../hooks/useDatasetStatus";

// Walkthrough #28 — numbered prefix on each tab + ARIA tablist + arrow
// keyboard navigation. Active tab gets a thicker underline + bg tint.
const tabs = [
  { to: "/pulse/overview", number: "01", label: "Overview" },
  { to: "/pulse/risk",     number: "02", label: "Risk" },
  { to: "/pulse/cannib",   number: "03", label: "Cannib" },
  { to: "/pulse/forecast", number: "04", label: "Forecast" },
  { to: "/pulse/model",    number: "05", label: "Model" },
];

export function PulseView() {
  // Task #183 — container-level dataset-empty gate so every PULSE tab
  // (overview/risk/cannib/forecast/model) shows the same Awaiting-ingest
  // placeholder while the singleton is empty. This is the single source
  // of truth for PULSE empty-state; the per-tab fetches still defend
  // their typed state against {empty:true} envelopes for safety, but
  // they should never see one once this gate fires.
  // During the first poll cycle `status` is null and the previous
  // `=== true` check evaluated to false, letting the tabs render and
  // hit their fetches before the empty gate could fire. After a wipe
  // those fetches return `{empty: true}` envelopes that the typed
  // tabs choke on. Treat "still loading first status" as empty until
  // proven populated; the second render flips it correctly.
  const { status: datasetStatus, loading } = useDatasetStatus();
  const isEmpty = datasetStatus?.empty !== false || (loading && !datasetStatus);

  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">PULSE · Readiness &amp; Forecast</h1>
      <UseCaseStrip number="13" title="PULSE" subtitle="PARTS DEMAND FORECASTING — CONTESTED LOG · Class IX MAGTF" accent="var(--color-warning)" />
      <PulseSubnav />
      <div className="flex-1 overflow-hidden">
        {isEmpty ? (
          <AwaitingIngestEmpty
            surface="PULSE"
            description="PULSE forecasts and risk surfaces hydrate from the live GCSS-MC export. Drop the three sanitized CSVs into DECISION BRIDGE to populate every PULSE tab."
          />
        ) : (
          <Routes>
            <Route index element={<FleetOverviewTab />} />
            <Route path="overview"  element={<FleetOverviewTab />} />
            <Route path="risk"      element={<RiskBoardTab />} />
            <Route path="cannib"    element={<CannibalizationTab />} />
            <Route path="forecast"  element={<ForecastTab />} />
            <Route path="model"     element={<ModelTab />} />
          </Routes>
        )}
      </div>
    </div>
  );
}

function PulseSubnav() {
  const nav = useNavigate();
  const loc = useLocation();
  const tablistRef = useRef<HTMLDivElement>(null);

  // Walkthrough #46 — arrow keys move focus + activate tabs.
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const buttons = tablistRef.current?.querySelectorAll<HTMLAnchorElement>('[role="tab"]');
    if (!buttons) return;
    const idx = Array.from(buttons).findIndex((b) => b === document.activeElement);
    if (idx < 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const next = e.key === "ArrowRight" ? (idx + 1) % buttons.length : (idx - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
      nav(tabs[next].to);
    } else if (e.key === "Home") {
      e.preventDefault();
      buttons[0].focus();
      nav(tabs[0].to);
    } else if (e.key === "End") {
      e.preventDefault();
      buttons[buttons.length - 1].focus();
      nav(tabs[tabs.length - 1].to);
    }
  }

  return (
    <div className="h-12 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
      <div
        role="tablist"
        aria-label="PULSE views"
        ref={tablistRef}
        onKeyDown={onKeyDown}
        className="flex h-full items-center gap-0"
      >
        {tabs.map((t) => {
          const isActive =
            loc.pathname === t.to ||
            (t.to === "/pulse/overview" && (loc.pathname === "/pulse" || loc.pathname === "/pulse/"));
          return (
            <NavLink
              key={t.to}
              to={t.to}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              end={t.to === "/pulse/overview"}
              onClick={(e) => {
                if (t.to === "/pulse/overview") {
                  e.preventDefault();
                  nav("/pulse/overview");
                }
              }}
              className={clsx(
                "relative px-4 py-2 font-mono text-sm font-semibold uppercase tracking-wider transition-colors",
                isActive
                  ? "text-[var(--color-text)] bg-[color-mix(in_oklab,var(--color-primary)_10%,transparent)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
              )}
            >
              {/* Tab numerals are stage decoration — they help an audience
               * parse "we're at step 02 of the PULSE walk" but operators
               * navigate by label. Demo build keeps them; pilot build
               * drops them so the subnav reads as plain mission-mode tabs. */}
              <DemoOnly>
                <span className="mr-1.5 text-[var(--color-text-muted)]">{t.number}</span>
              </DemoOnly>
              {t.label}
              {isActive && (
                <>
                  <span
                    className="absolute inset-x-2 -bottom-[1px] h-[3px]"
                    style={{
                      background: "var(--color-primary)",
                      boxShadow: "0 0 8px var(--color-primary)",
                    }}
                  />
                  <span className="absolute left-1 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-[var(--color-primary)]" />
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </div>
  );
}
