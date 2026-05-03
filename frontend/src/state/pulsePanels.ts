/**
 * PULSE per-role panel-collapse defaults (operational build).
 *
 * Background: judges at MDM 2026 called the PULSE landing surface
 * cluttered. A Maint Chief opening the Risk Board ate Predicted Failures,
 * Recommend Actions, the cannib matcher, and the forecast chart — three
 * panels they didn't ask for, all expanded. In sustained pilot use that
 * stack reads as overload, not as helpful context.
 *
 * The fix is per-role panel-collapse defaults. The mapping below picks
 * which panels each role lands with expanded vs collapsed. The
 * operational build applies the mapping; the demo build keeps the
 * original "everything expanded for the panel" posture so a stage
 * walk-through still photographs well.
 *
 * Persistence model:
 *
 *   localStorage["spire.pulse.panels.<dodidHash>"] = {
 *     predictedFailures: "expanded",
 *     recommendActions:  "collapsed",
 *     ...
 *   }
 *
 * Once an operator manually expands a panel, the explicit value sticks
 * for THAT operator (DODID) until they explicitly collapse it again.
 * Each operator gets their own slot — switching identities never
 * inherits another operator's panel posture. If the auth store hasn't
 * resolved a DODID yet (e.g. first paint before /api/auth/me), we fall
 * back to keying on the role string so a fresh sign-in still gets a
 * stable, non-leaky key.
 */
import type { Role } from "./store";

export type PanelKey = "predictedFailures" | "recommendActions";
export type PanelState = "expanded" | "collapsed";

/**
 * Role → default panel posture. Operational build only.
 *
 * - maintenance_chief: Risk Board is their actual job; Predicted
 *   Failures + Recommend Actions stay folded into pills until they ask
 *   for them.
 * - g4: forecast-shaped role. Predicted Failures expanded (it feeds
 *   their parts ordering), Recommend Actions collapsed (they hand-pick
 *   their own action mix).
 * - mef_commander: wide view by design — everything expanded.
 * - security_manager / data_custodian: PULSE is not their primary
 *   surface. If they navigate here, render minimum chrome — Risk Board
 *   only, the rest pilled.
 */
const ROLE_DEFAULTS: Record<Role, Record<PanelKey, PanelState>> = {
  maintenance_chief: {
    predictedFailures: "collapsed",
    recommendActions: "collapsed",
  },
  g4: {
    predictedFailures: "expanded",
    recommendActions: "collapsed",
  },
  mef_commander: {
    predictedFailures: "expanded",
    recommendActions: "expanded",
  },
  security_manager: {
    predictedFailures: "collapsed",
    recommendActions: "collapsed",
  },
  data_custodian: {
    predictedFailures: "collapsed",
    recommendActions: "collapsed",
  },
};

/**
 * Stable, non-cryptographic 32-bit string hash (djb2 variant). Used to
 * key localStorage by an opaque slug rather than a raw DODID — keeps
 * the storage key from being a directly-readable identity if a device
 * is left logged in. Not security; just hygiene.
 */
function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // Render as unsigned hex to avoid leading-minus on negative ints.
  return (h >>> 0).toString(16);
}

/**
 * Resolve the localStorage key for a given operator. Prefer DODID hash;
 * fall back to role when the auth store hasn't filled in a DODID yet
 * (first paint, or test harnesses that bypass sign-in).
 */
export function panelStorageKey(dodid: string | null | undefined, role: Role): string {
  const slug = dodid ? hashString(dodid) : `role-${role}`;
  return `spire.pulse.panels.${slug}`;
}

/**
 * Load the operator's persisted panel-state object. Returns an empty
 * map if nothing is stored or the payload is malformed — callers fall
 * through to the role default in that case.
 */
export function loadPanelState(
  dodid: string | null | undefined,
  role: Role,
): Partial<Record<PanelKey, PanelState>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(panelStorageKey(dodid, role));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Partial<Record<PanelKey, PanelState>> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === "expanded" || v === "collapsed") {
        out[k as PanelKey] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Persist a single panel's state for the operator. Reads the existing
 * payload, mutates one key, and writes the merged object back so other
 * panels' preferences survive untouched.
 */
export function savePanelState(
  dodid: string | null | undefined,
  role: Role,
  panel: PanelKey,
  state: PanelState,
): void {
  if (typeof window === "undefined") return;
  try {
    const current = loadPanelState(dodid, role);
    current[panel] = state;
    window.localStorage.setItem(
      panelStorageKey(dodid, role),
      JSON.stringify(current),
    );
  } catch {
    /* tolerate quota / private-mode failures — collapse default still applies */
  }
}

/**
 * Resolve the effective collapsed-state for a panel:
 *
 *   1. If the operator has an explicit persisted value for this panel,
 *      use it.
 *   2. Otherwise, return the role default from ROLE_DEFAULTS.
 *
 * Caller is responsible for gating this on `isOperational()` — in demo
 * build the existing "always expanded" / per-panel `defaultCollapsedFor`
 * posture stays untouched.
 */
export function resolvePanelCollapsed(
  dodid: string | null | undefined,
  role: Role,
  panel: PanelKey,
): boolean {
  const persisted = loadPanelState(dodid, role)[panel];
  if (persisted) return persisted === "collapsed";
  return ROLE_DEFAULTS[role][panel] === "collapsed";
}
