import { create } from "zustand";

export type Role =
  | "maintenance_chief"
  | "g4"
  | "mef_commander"
  | "data_custodian"
  | "security_manager";

export type OperatingMode = "full" | "lite";

export interface SpireState {
  role: Role;
  operatingMode: OperatingMode;
  alertCount: number;
  sentryReady: boolean;
  pulseReady: boolean;
  bastionReady: boolean;
  setRole: (r: Role) => void;
  setOperatingMode: (m: OperatingMode) => void;
}

export const ROLE_LABELS: Record<Role, string> = {
  maintenance_chief: "Maintenance Chief (CLB-6)",
  g4: "G-4 (2d MLG)",
  mef_commander: "MEF Commander",
  data_custodian: "Data Custodian",
  security_manager: "Security Manager",
};

export const ROLE_DEFAULT_VIEW: Record<Role, string> = {
  maintenance_chief: "/pulse",
  g4: "/pulse",
  mef_commander: "/bastion",
  data_custodian: "/sentry",
  security_manager: "/sentry",
};

export const useSpireStore = create<SpireState>((set) => ({
  role: "data_custodian",
  operatingMode: "full",
  alertCount: 0,
  sentryReady: false,
  pulseReady: false,
  bastionReady: false,
  setRole: (role) => set({ role }),
  setOperatingMode: (operatingMode) => set({ operatingMode }),
}));
