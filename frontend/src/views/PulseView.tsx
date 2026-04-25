import { Routes, Route, NavLink, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { FleetOverviewTab } from "./pulse/FleetOverviewTab";
import { RiskBoardTab } from "./pulse/RiskBoardTab";
import { CannibalizationTab } from "./pulse/CannibalizationTab";
import { ForecastTab } from "./pulse/ForecastTab";

const tabs = [
  { to: "/pulse/overview",      label: "Fleet Overview" },
  { to: "/pulse/risk",          label: "Risk Board" },
  { to: "/pulse/cannib",        label: "Cannibalization" },
  { to: "/pulse/forecast",      label: "Forecast" },
];

export function PulseView() {
  return (
    <div className="flex h-full flex-col">
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
  return (
    <div className="h-10 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
      <div className="flex h-full items-center gap-0">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === "/pulse/overview"}
            onClick={(e) => {
              if (t.to === "/pulse/overview") {
                e.preventDefault();
                nav("/pulse/overview");
              }
            }}
            className={({ isActive }) =>
              clsx(
                "relative px-4 py-2 font-mono text-sm font-semibold uppercase tracking-wider transition-colors",
                isActive
                  ? "text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
              )
            }
          >
            {({ isActive }) => (
              <>
                {t.label}
                {isActive && (
                  <>
                    <span
                      className="absolute inset-x-2 -bottom-[1px] h-[2px]"
                      style={{
                        background: "var(--color-primary)",
                        boxShadow: "0 0 8px var(--color-primary)",
                      }}
                    />
                    <span className="absolute left-1 top-1/2 h-1 w-1 -translate-y-1/2 rounded-full bg-[var(--color-primary)]" />
                  </>
                )}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
