// Task #162 — pure projection math for the Cannibalization propose modal.
//
// Extracted from ConfirmProposeModal so the donor + recipient
// before → after MC% computation (and the readiness-floor breach logic)
// can be unit-tested independently of React rendering. The modal still
// owns the visual chrome; this module owns the numbers.

// Minimum projected donor unit MC% before we flag the strip as "would
// push donor unit below readiness floor." Mirrors the 70% threshold the
// backend's strippable-donor matcher uses to decide whether an MC hull
// at a unit "can spare" the part.
export const DONOR_MC_FLOOR = 0.70;

// Per-proposal delta carried into the projection math. Each
// proposed-but-not-yet-committed strip contributes +1 MC to the
// recipient unit (the deadlined recipient becomes mission capable
// once the part is installed) and -1 MC to the donor unit when the
// donor was itself MC at proposal time.
export type PendingDelta = {
  recipient_unit: string;
  donor_unit: string;
  donor_was_mc: boolean;
};

export type ProjectionInput = {
  recipient_unit: string;
  recipient_unit_mc_count: number;
  recipient_unit_total: number;
  donor_unit: string;
  donor_unit_mc_count: number;
  donor_unit_total: number;
  donor_was_mc: boolean;
  pendingProposals: PendingDelta[];
};

export type Projection = {
  sameUnit: boolean;
  willDropMc: 0 | 1;
  recipientBeforeMc: number;
  recipientBeforeRate: number;
  recipientAfterRate: number;
  recipientAfterMc: number;
  donorBeforeMc: number;
  donorBeforeRate: number;
  donorAfterRate: number;
  donorAfterMc: number;
  donorBreach: boolean;
  donorAlreadyBelow: boolean;
};

function clamp(mc: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total, mc)) / total;
}

function pendingDelta(unit: string, pending: PendingDelta[]): number {
  let d = 0;
  for (const p of pending) {
    if (p.recipient_unit === unit) d += 1;
    if (p.donor_unit === unit && p.donor_was_mc) d -= 1;
  }
  return d;
}

export function computeProposeProjection(input: ProjectionInput): Projection {
  const sameUnit = input.recipient_unit === input.donor_unit;
  const willDropMc: 0 | 1 = input.donor_was_mc ? 1 : 0;

  const recipientPending = pendingDelta(input.recipient_unit, input.pendingProposals);
  const donorPending = sameUnit
    ? recipientPending
    : pendingDelta(input.donor_unit, input.pendingProposals);

  const recipientBeforeMc = input.recipient_unit_mc_count + recipientPending;
  const recipientBeforeRate = clamp(recipientBeforeMc, input.recipient_unit_total);
  const recipientAfterMc = recipientBeforeMc + 1
    + (sameUnit ? -willDropMc : 0);
  const recipientAfterRate = clamp(recipientAfterMc, input.recipient_unit_total);

  const donorBeforeMc = input.donor_unit_mc_count + donorPending;
  const donorBeforeRate = clamp(donorBeforeMc, input.donor_unit_total);
  const donorAfterMc = donorBeforeMc - willDropMc
    + (sameUnit ? 1 : 0);
  const donorAfterRate = clamp(donorAfterMc, input.donor_unit_total);

  // Threshold breach: stripping this MC hull would push the donor unit
  // below the readiness floor. Only meaningful when the strip actually
  // drops an MC hull (otherwise donor MC% is unchanged) and the donor
  // unit's projected after-rate crosses the floor. We deliberately
  // compare AFTER (not BEFORE) — a unit already below the floor that
  // stays unchanged shouldn't generate a new banner here, but a strip
  // that takes a unit from above to below should.
  const donorIsHighImpact = willDropMc === 1;
  const donorBreach = donorIsHighImpact
    && input.donor_unit_total > 0
    && donorAfterRate < DONOR_MC_FLOOR
    && donorBeforeRate >= DONOR_MC_FLOOR;
  const donorAlreadyBelow = donorIsHighImpact
    && input.donor_unit_total > 0
    && donorBeforeRate < DONOR_MC_FLOOR;

  return {
    sameUnit,
    willDropMc,
    recipientBeforeMc,
    recipientBeforeRate,
    recipientAfterRate,
    recipientAfterMc,
    donorBeforeMc,
    donorBeforeRate,
    donorAfterRate,
    donorAfterMc,
    donorBreach,
    donorAlreadyBelow,
  };
}
