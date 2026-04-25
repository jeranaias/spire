import { create } from "zustand";

export type Role =
  | "maintenance_chief"
  | "g4"
  | "mef_commander"
  | "data_custodian"
  | "security_manager";

export type OperatingMode = "full" | "lite";
export type ToastTone = "ok" | "info" | "warn" | "error";

// Information-density mode. `dense` is the existing staff layout (more
// columns, tighter padding, smaller type). `sparse` bumps font tiers, pads
// cards, hides decorative columns — for Marines on iPads in motor pools
// where tap targets and breathing room matter more than info per square inch.
export type Density = "dense" | "sparse";

export interface Toast {
  id: string;
  tone: ToastTone;
  text: string;
  // Optional "undo" lane — when present, rendered as a button that resolves the action.
  undo?: { label: string; onUndo: () => void };
  // Optional click-through link — rendered as an external-opening anchor.
  link?: { label: string; href: string };
  ttlMs?: number;
}

export type CommsState = "CONNECTED" | "DEGRADED" | "DISCONNECTED";

export interface SpireState {
  role: Role;
  operatingMode: OperatingMode;
  alertCount: number;

  // SENTRY batch context — hoisted out of SentryView local state so that
  // switching operator role via the TopBar dropdown (which unmounts the
  // view) no longer nukes the in-flight batch.
  sentryBatchId: string | null;
  sentryJobId: string | null;

  // Cross-tab selection (Risk Board → Cannibalization, Heatmap → Risk Board, …).
  selectedAssetId: string | null;

  // FPCON indicator. BRAVO is the steady state; a ThermalHawk sim temporarily
  // escalates to CHARLIE for the duration of the incident.
  fpcon: "NORMAL" | "ALPHA" | "BRAVO" | "CHARLIE" | "DELTA";

  // GC-7 Air-gap deployment mode — comms-state + queue depth for the
  // StatusFooter pulse + TopBar toggle.
  commsState: CommsState;
  airGapActive: boolean;
  queueDepth: number;

  // Toast queue.
  toasts: Toast[];

  // Track-G3 — density toggle. Persisted per role in localStorage.
  density: Density;

  setRole: (r: Role) => void;
  setOperatingMode: (m: OperatingMode) => void;
  setAlertCount: (n: number) => void;
  setSentryBatch: (batchId: string | null, jobId: string | null) => void;
  setSelectedAssetId: (id: string | null) => void;
  setFpcon: (level: SpireState["fpcon"]) => void;
  setCommsState: (s: CommsState) => void;
  setAirGap: (active: boolean) => void;
  setQueueDepth: (n: number) => void;
  setDensity: (d: Density) => void;
  pushToast: (t: Omit<Toast, "id">) => string;
  dismissToast: (id: string) => void;
}

export const ROLE_LABELS: Record<Role, string> = {
  maintenance_chief: "Maintenance Chief (CLB-6)",
  g4: "G-4 (2d MLG)",
  mef_commander: "MEF Commander",
  data_custodian: "Data Custodian",
  security_manager: "Security Manager",
};

// Where the role dropdown lands each persona on switch. Mapped per the
// adversarial review recommendation: ops roles land on BASTION; Maintenance
// Chief on PULSE; Data Custodian on SENTRY.
export const ROLE_DEFAULT_VIEW: Record<Role, string> = {
  maintenance_chief: "/pulse",
  g4: "/bastion",
  mef_commander: "/bastion",
  data_custodian: "/sentry",
  security_manager: "/bastion",
};

// Roles expected to have authority on each view. If a role visits a view
// outside this set, the frontend renders an "Out-of-scope" overlay.
export const VIEW_SCOPE: Record<string, Role[]> = {
  "/sentry":  ["data_custodian", "security_manager"],
  "/pulse":   ["maintenance_chief", "g4", "mef_commander"],
  "/bastion": ["mef_commander", "g4", "security_manager", "maintenance_chief"],
};

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Density localStorage helpers — keyed per role so the field-Marine on
// CLB-6's iPad doesn't drag a sparse layout into the G-4 staff seat.
function densityKey(role: Role): string {
  return `spire.density.${role}`;
}
function loadDensity(role: Role): Density {
  try {
    const raw = window.localStorage.getItem(densityKey(role));
    if (raw === "dense" || raw === "sparse") return raw;
  } catch {
    /* SSR / private mode tolerant */
  }
  return "dense";
}
function saveDensity(role: Role, d: Density): void {
  try {
    window.localStorage.setItem(densityKey(role), d);
  } catch {
    /* tolerant */
  }
}

const INITIAL_ROLE: Role = "mef_commander";

export const useSpireStore = create<SpireState>((set, get) => ({
  role: INITIAL_ROLE,
  operatingMode: "full",
  alertCount: 0,
  sentryBatchId: null,
  sentryJobId: null,
  selectedAssetId: null,
  fpcon: "BRAVO",
  commsState: "CONNECTED",
  airGapActive: false,
  queueDepth: 0,
  toasts: [],
  density: typeof window !== "undefined" ? loadDensity(INITIAL_ROLE) : "dense",
  setRole: (role) =>
    set({
      role,
      // Re-hydrate density from per-role localStorage on every role swap.
      density: typeof window !== "undefined" ? loadDensity(role) : "dense",
    }),
  setOperatingMode: (operatingMode) => set({ operatingMode }),
  setAlertCount: (alertCount) => set({ alertCount }),
  setSentryBatch: (sentryBatchId, sentryJobId) => set({ sentryBatchId, sentryJobId }),
  setSelectedAssetId: (selectedAssetId) => set({ selectedAssetId }),
  setFpcon: (fpcon) => set({ fpcon }),
  setCommsState: (commsState) => set({ commsState }),
  setAirGap: (airGapActive) => set({ airGapActive }),
  setQueueDepth: (queueDepth) => set({ queueDepth }),
  setDensity: (density) => {
    saveDensity(get().role, density);
    set({ density });
  },
  pushToast: (t) => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }));
    const ttl = t.ttlMs ?? 3000;
    window.setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
    }, ttl);
    return id;
  },
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));
