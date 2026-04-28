import type { ReactNode } from "react";
import { useSpireStore, VIEW_SCOPE, ROLE_LABELS, ROLE_DEFAULT_VIEW } from "../state/store";
import { useNavigate } from "react-router-dom";
import { Button } from "./ui";

interface Props {
  // Route prefix — "/sentry", "/pulse", "/bastion"
  view: keyof typeof VIEW_SCOPE;
  children: ReactNode;
}

export function ScopeGuard({ view, children }: Props) {
  const role = useSpireStore((s) => s.role);
  const allowed = VIEW_SCOPE[view] ?? [];
  const nav = useNavigate();
  const inScope = allowed.includes(role);

  if (inScope) return <>{children}</>;

  const home = ROLE_DEFAULT_VIEW[role] ?? "/bastion";

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div
        className="max-w-lg rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in oklab, var(--color-warning) 6%, var(--color-surface)) 0%, var(--color-surface) 60%)",
        }}
      >
        <div
          className="mb-2 font-mono text-xs uppercase text-[var(--color-warning)] tracking-widest"
        >
          Out of Scope · Access Restricted
        </div>
        <div className="mb-3 font-mono text-lg font-semibold text-[var(--color-text)] tracking-wide">
          {view.toUpperCase().replace("/", "")} is not in your authorization scope.
        </div>
        <div className="mb-4 font-mono text-sm text-[var(--color-text-secondary)] tracking-wide">
          Current role: <span className="text-[var(--color-text)]">{ROLE_LABELS[role]}</span>.
          &nbsp;This view is restricted to:&nbsp;
          <span className="text-[var(--color-text)]">
            {allowed.map((r) => ROLE_LABELS[r]).join(", ")}
          </span>
          .
        </div>
        <div className="mb-4 font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
          In production, SPIRE honours role-based access control via CAC token
          and Keycloak role mapping. This overlay simulates that enforcement.
        </div>
        <Button onClick={() => nav(home)} size="sm">
          Return to {home}
        </Button>
      </div>
    </div>
  );
}
