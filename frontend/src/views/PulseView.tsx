import { useRef } from "react";
import { Routes, Route, NavLink, useLocation, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { FleetOverviewTab } from "./pulse/FleetOverviewTab";
import { RiskBoardTab } from "./pulse/RiskBoardTab";
import { CannibalizationTab } from "./pulse/CannibalizationTab";
import { ForecastTab } from "./pulse/ForecastTab";

// Walkthrough #28 — numbered prefix on each tab + ARIA tablist + arrow
// keyboard navigation. Active tab gets a thicker underline + bg tint.
const tabs = [
  { to: "/pulse/overview", number: "01", label: "Overview" },
  { to: "/pulse/risk",     number: "02", label: "Risk" },
  { to: "/pulse/cannib",   number: "03", label: "Cannib" },
  { to: "/pulse/forecast", number: "04", label: "Forecast" },
];

export function PulseView() {
  return (
    <div className="flex h-full flex-col">
      <h1 className="sr-only">PULSE · Readiness &amp; Forecast</h1>
      <PulseSubnav />
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route index element={<FleetOverviewTab />} />
          <Route path="overview"  element={<FleetOverviewTab />} />
          <Route path="risk"      element={<RiskBoardTab />} />
          <Route path="cannib"    element={<CannibalizationTab />} />
          <Route path="forecast"  element={<ForecastTab />} />
        </Routes>
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
              <span className="mr-1.5 text-[var(--color-text-muted)]">{t.number}</span>
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
