// Marine Corps logistics calculation helpers.
// Multipliers approximate planning factors from MCWP 4-11 (Tactical-Level Logistics)
// and the Marine Corps Planner's Reference. Values are conservative defaults
// suitable for small-unit planning; this is a calculator, not an AAR.

export type Climate = "temperate" | "arid" | "tropical" | "arctic";
export type OpTempo = "garrison" | "sustained" | "high" | "combat";
export type SupplyClass = "I" | "III" | "V" | "VIII" | "IX";

export const CLIMATE_MULTIPLIERS: Record<
  Climate,
  Partial<Record<SupplyClass, number>>
> = {
  temperate: { I: 1.0, III: 1.0, V: 1.0, VIII: 1.0, IX: 1.0 },
  arid: { I: 1.6, III: 1.15, V: 1.0, VIII: 1.1, IX: 1.05 },
  tropical: { I: 1.25, III: 1.05, V: 1.0, VIII: 1.2, IX: 1.05 },
  arctic: { I: 1.35, III: 1.6, V: 1.0, VIII: 1.15, IX: 1.1 },
};

export const TEMPO_MULTIPLIERS: Record<
  OpTempo,
  Partial<Record<SupplyClass, number>>
> = {
  garrison: { I: 0.9, III: 0.7, V: 0.1, VIII: 0.5, IX: 0.6 },
  sustained: { I: 1.0, III: 1.0, V: 1.0, VIII: 1.0, IX: 1.0 },
  high: { I: 1.1, III: 1.4, V: 2.5, VIII: 1.4, IX: 1.3 },
  combat: { I: 1.15, III: 1.6, V: 5.0, VIII: 2.0, IX: 1.6 },
};

export function adjustedDailyRate(
  baseDailyRate: number,
  supplyClass: SupplyClass,
  climate: Climate,
  opTempo: OpTempo,
  personnel: number,
): number {
  const climateMult = CLIMATE_MULTIPLIERS[climate]?.[supplyClass] ?? 1.0;
  const tempoMult = TEMPO_MULTIPLIERS[opTempo]?.[supplyClass] ?? 1.0;
  return baseDailyRate * climateMult * tempoMult * personnel;
}

export type SupplyStatus = "green" | "amber" | "red";

export function statusFromDays(days: number): SupplyStatus {
  if (!Number.isFinite(days)) return "green";
  if (days < 2) return "red";
  if (days < 5) return "amber";
  return "green";
}

export const CLASS_LABELS: Record<SupplyClass, string> = {
  I: "Subsistence",
  III: "POL & Power",
  V: "Ammunition",
  VIII: "Medical",
  IX: "Repair Parts",
};

export const CLASS_ORDER: SupplyClass[] = ["I", "III", "V", "VIII", "IX"];

/** Classes included in Days-of-Supply planning and readiness scoring. */
export const DOS_CLASSES: SupplyClass[] = ["I", "III", "V", "VIII"];
