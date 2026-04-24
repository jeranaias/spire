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
      <div className="flex h-full items-center gap-1">
        {tabs.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.to === "/pulse/overview"}
            onClick={(e) => {
              // ensure /pulse lands on overview
              if (t.to === "/pulse/overview") {
                e.preventDefault();
                nav("/pulse/overview");
              }
            }}
            className={({ isActive }) =>
              clsx(
                "rounded-sm px-3 py-1 text-xs font-medium transition-colors",
                isActive
                  ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]"
                  : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]",
              )
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>
    </div>
  );
}
