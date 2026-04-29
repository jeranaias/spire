// Marine Corps logistics calculation helpers.
// Multipliers approximate planning factors from MCWP 4-11 (Tactical-Level Logistics)
// and the Marine Corps Planner's Reference. Values are conservative defaults
// suitable for small-unit planning; this is a calculator, not an AAR.

import type { catalogItemsTable, supplyEntriesTable } from "@workspace/db";

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

export interface RequirementInputs {
  /**
   * Planner-set override:
   *   - `null` / `undefined` → auto-compute requirement from daily burn × mission days
   *   - `0` → planner declared this is not a requirement for this unit
   *   - positive number → planner override; status comes from coverage (onHand / required)
   */
  override: number | null | undefined;
  onHand: number;
  dailyConsumption: number;
  missionDays: number;
}

export interface RequirementResult {
  required: number;
  isRequirement: boolean;
  shortfall: number;
  status: SupplyStatus;
}

/**
 * Single source of truth for the required-quantity rule used across the API.
 *
 * Keep all four endpoints (`computeUnitMetrics`, `POST /units/:id/supply`,
 * `PATCH /units/:id/supply/:itemId/custom-item`, and
 * `POST /units/:id/supply/:itemId/restore`) on this helper so the override
 * semantics cannot drift between code paths.
 */
export function deriveRequirement({
  override,
  onHand,
  dailyConsumption,
  missionDays,
}: RequirementInputs): RequirementResult {
  if (override === 0) {
    return { required: 0, isRequirement: false, shortfall: 0, status: "green" };
  }
  if (override !== null && override !== undefined) {
    const required = override;
    const shortfall = Math.max(0, required - onHand);
    const coverage = required > 0 ? onHand / required : 0;
    const status: SupplyStatus =
      coverage >= 1 ? "green" : coverage >= 0.4 ? "amber" : "red";
    return { required, isRequirement: true, shortfall, status };
  }
  const required = dailyConsumption * missionDays;
  const shortfall = Math.max(0, required - onHand);
  const daysOfSupply = dailyConsumption > 0 ? onHand / dailyConsumption : 999;
  return {
    required,
    isRequirement: true,
    shortfall,
    status: statusFromDays(daysOfSupply),
  };
}

/** Round to 2 decimal places, treating non-finite values as 0. */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

export interface SupplyEntryResponseInputs {
  entry: typeof supplyEntriesTable.$inferSelect;
  item: typeof catalogItemsTable.$inferSelect;
  dailyConsumption: number;
  requirement: RequirementResult;
  burnBreakdown?: string | null;
  combatLoadTarget?: number | null;
}

/**
 * Single source of truth for the enriched SupplyEntry response shape.
 *
 * Keep all four call sites that return a full SupplyEntry to the client
 * (`computeUnitMetrics` row enrichment, `POST /units/:id/supply`,
 * `PATCH /units/:id/supply/:itemId/custom-item`, and
 * `POST /units/:id/supply/:itemId/restore`) on this helper so the response
 * shape cannot drift between code paths. New SupplyEntry fields should be
 * added here and to the OpenAPI/Zod `SupplyEntry` schema — nowhere else.
 */
export function buildSupplyEntryResponse({
  entry,
  item,
  dailyConsumption,
  requirement,
  burnBreakdown = null,
  combatLoadTarget = null,
}: SupplyEntryResponseInputs) {
  const onHand = entry.onHand;
  const daysOfSupply = dailyConsumption > 0 ? onHand / dailyConsumption : 999;
  return {
    id: entry.id,
    unitId: entry.unitId,
    itemId: entry.itemId,
    item: {
      id: item.id,
      supplyClass: item.supplyClass,
      name: item.name,
      nsn: item.nsn,
      unit: item.unit,
      baseDailyRate: item.baseDailyRate,
      criticality: item.criticality,
      notes: item.notes,
      isCustom: item.isCustom,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    },
    onHand,
    dailyConsumption: round2(dailyConsumption),
    daysOfSupply: round2(daysOfSupply),
    required: round2(requirement.required),
    shortfall: round2(requirement.shortfall),
    status: requirement.status,
    requiredOverride: entry.requiredOverride ?? null,
    isRequirement: requirement.isRequirement,
    burnBreakdown,
    combatLoadTarget,
    updatedAt: entry.updatedAt.toISOString(),
  };
}
