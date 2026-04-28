import { useSpireStore, ROLE_LABELS, type Role } from "../state/store";
import { Button } from "./ui";

interface Props {
  feature: string;
  requiredRoles: Role[];
  description?: string;
}

/**
 * Inline access-denied panel. Rendered when the active role doesn't have
 * authorization for a particular sub-feature (e.g. Mark Draft is restricted
 * to Data Custodian + Security Manager; other roles can see that it exists
 * but cannot submit). Maintains the security narrative — SPIRE enforces
 * role scope at the UI layer instead of silently allowing everything.
 */
export function InsufficientPrivilege({ feature, requiredRoles, description }: Props) {
  const role = useSpireStore((s) => s.role);
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div
        className="max-w-md rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
        style={{
          background:
            "linear-gradient(135deg, color-mix(in oklab, var(--color-warning) 8%, var(--color-surface)) 0%, var(--color-surface) 55%)",
        }}
      >
        <div
          className="mb-2 font-mono text-xs uppercase text-[var(--color-warning)] tracking-widest"
        >
          Insufficient Privilege
        </div>
        <div className="mb-3 font-mono text-lg font-semibold text-[var(--color-text)] tracking-wide">
          {feature} requires elevated privileges.
        </div>
        <div className="spire-body-muted mb-3">
          Current role: <span className="text-[var(--color-text)]">{ROLE_LABELS[role]}</span>.
          &nbsp;Authorized roles:&nbsp;
          <span className="text-[var(--color-text)]">
            {requiredRoles.map((r) => ROLE_LABELS[r]).join(", ")}
          </span>
          .
        </div>
        {description && (
          <div className="font-mono text-xs text-[var(--color-text-muted)] tracking-wider">
            {description}
          </div>
        )}
        <Button disabled variant="secondary" size="sm" className="mt-4">
          Request Access (unavailable in demo)
        </Button>
      </div>
    </div>
  );
}
