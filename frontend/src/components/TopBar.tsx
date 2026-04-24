import { NavLink, useNavigate } from "react-router-dom";
import clsx from "clsx";
import { ROLE_DEFAULT_VIEW, ROLE_LABELS, useSpireStore, type Role } from "../state/store";

const tabs = [
  { to: "/sentry",  label: "SENTRY" },
  { to: "/pulse",   label: "PULSE" },
  { to: "/bastion", label: "BASTION" },
];

export function TopBar() {
  const { role, setRole, operatingMode, alertCount } = useSpireStore();
  const nav = useNavigate();

  function onRoleChange(r: Role) {
    setRole(r);
    nav(ROLE_DEFAULT_VIEW[r]);
  }

  return (
    <header className="h-12 shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex h-full items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <SpireMark />
            <span className="text-sm font-semibold tracking-wide">SPIRE</span>
          </div>
          <nav className="flex items-center gap-1">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  clsx(
                    "relative px-4 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "text-[var(--color-text)]"
                      : "text-[var(--color-text-secondary)] hover:text-[var(--color-text)]",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    {tab.label}
                    {isActive && (
                      <span className="absolute inset-x-2 -bottom-[1px] h-0.5 bg-[var(--color-primary)]" />
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <RoleSelector role={role} onChange={onRoleChange} />
          <ModeBadge mode={operatingMode} />
          <AlertBadge count={alertCount} />
        </div>
      </div>
    </header>
  );
}

function SpireMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M12 2L18 22H6L12 2Z" fill="var(--color-primary)" />
      <path d="M12 2L12 22" stroke="var(--color-surface)" strokeWidth="1.2" opacity="0.3" />
    </svg>
  );
}

function RoleSelector({ role, onChange }: { role: Role; onChange: (r: Role) => void }) {
  // Native <select> on Windows is hideous over dark backgrounds -- the native
  // chrome ignores CSS color on option elements. This wrapper keeps the
  // input accessible but frames it so the dropdown blends into the bar.
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
      <span className="select-none">View as</span>
      <div className="relative">
        <select
          value={role}
          onChange={(e) => onChange(e.target.value as Role)}
          className="appearance-none rounded border border-[var(--color-border)] bg-[var(--color-bg)] py-1 pl-2 pr-7 text-[var(--color-text)] transition-colors hover:border-[var(--color-border-active)] focus:border-[var(--color-primary)] focus:outline-none"
        >
          {(Object.keys(ROLE_LABELS) as Role[]).map((k) => (
            <option key={k} value={k}>{ROLE_LABELS[k]}</option>
          ))}
        </select>
        <svg
          className="pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--color-text-muted)]"
          viewBox="0 0 12 12"
          fill="currentColor"
        >
          <path d="M2 4l4 4 4-4H2z" />
        </svg>
      </div>
    </label>
  );
}

function ModeBadge({ mode }: { mode: "full" | "lite" }) {
  const isFull = mode === "full";
  return (
    <div className="flex items-center gap-2 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs">
      <span
        className={clsx(
          "h-2 w-2 rounded-full",
          isFull ? "bg-[var(--color-success)]" : "bg-[var(--color-warning)]"
        )}
      />
      <span className="text-[var(--color-text-secondary)]">
        {isFull ? "Local" : "Lite Mode"}
      </span>
    </div>
  );
}

function AlertBadge({ count }: { count: number }) {
  const color =
    count === 0 ? "text-[var(--color-text-muted)]" :
    count < 3   ? "text-[var(--color-warning)]" :
                  "text-[var(--color-danger)]";
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className={color}>
        <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />
      </svg>
      <span className="tabular-nums text-[var(--color-text-secondary)]">{count}</span>
    </div>
  );
}
