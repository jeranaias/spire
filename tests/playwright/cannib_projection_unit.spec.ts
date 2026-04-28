// Task #162 — focused unit tests for the projection helper that drives
// the propose-modal "before → after" panel. These don't open a browser;
// they import the pure helper directly and exercise:
//   1. multi-pending delta accumulation across queued proposals on the
//      same donor / recipient unit (the panel must reflect the queue, not
//      just the single strip in isolation),
//   2. the readiness-floor warning trigger (donorBreach) — fires only
//      when the strip drops a unit from at/above 70% MC to below 70%,
//   3. the "already-below floor" companion flag (donorAlreadyBelow),
//   4. the same-unit (intra-unit) cannibalization net effect.

import { test, expect } from "@playwright/test";
import {
  computeProposeProjection,
  DONOR_MC_FLOOR,
  type PendingDelta,
} from "../../frontend/src/views/pulse/cannibProjection";

test.describe("Task #162 — computeProposeProjection (pure helper)", () => {
  test("readiness-floor warning fires when strip pushes donor below 70%", () => {
    // Donor unit: 8/10 MC = 80%. Stripping one MC hull → 7/10 = 70%
    // (exactly at floor, NOT a breach because 70.0 is not < 70.0).
    const atFloor = computeProposeProjection({
      recipient_unit: "CLB-6",
      recipient_unit_mc_count: 5,
      recipient_unit_total: 10,
      donor_unit: "7TH-ESB",
      donor_unit_mc_count: 8,
      donor_unit_total: 10,
      donor_was_mc: true,
      pendingProposals: [],
    });
    expect(atFloor.donorBeforeRate).toBeCloseTo(0.80, 4);
    expect(atFloor.donorAfterRate).toBeCloseTo(0.70, 4);
    expect(atFloor.donorBreach).toBe(false);
    expect(atFloor.donorAlreadyBelow).toBe(false);

    // Donor unit: 7/10 MC = 70% exact. Stripping one MC hull → 6/10 = 60%
    // (this IS a breach: starts ≥ floor, ends < floor).
    const breach = computeProposeProjection({
      recipient_unit: "CLB-6",
      recipient_unit_mc_count: 5,
      recipient_unit_total: 10,
      donor_unit: "7TH-ESB",
      donor_unit_mc_count: 7,
      donor_unit_total: 10,
      donor_was_mc: true,
      pendingProposals: [],
    });
    expect(breach.donorBeforeRate).toBeGreaterThanOrEqual(DONOR_MC_FLOOR);
    expect(breach.donorAfterRate).toBeLessThan(DONOR_MC_FLOOR);
    expect(breach.donorBreach).toBe(true);
    expect(breach.donorAlreadyBelow).toBe(false);

    // Donor unit already at 6/10 = 60% MC. Stripping another MC hull →
    // 5/10 = 50% — not a breach (no fresh cross), but already-below
    // banner should fire.
    const alreadyBelow = computeProposeProjection({
      recipient_unit: "CLB-6",
      recipient_unit_mc_count: 5,
      recipient_unit_total: 10,
      donor_unit: "7TH-ESB",
      donor_unit_mc_count: 6,
      donor_unit_total: 10,
      donor_was_mc: true,
      pendingProposals: [],
    });
    expect(alreadyBelow.donorBreach).toBe(false);
    expect(alreadyBelow.donorAlreadyBelow).toBe(true);

    // PMC / NMC strippable donor: stripping does NOT decrement MC
    // count (donor was never in the MC tally), so neither banner fires
    // even when the unit happens to be below the floor.
    const pmcDonor = computeProposeProjection({
      recipient_unit: "CLB-6",
      recipient_unit_mc_count: 4,
      recipient_unit_total: 10,
      donor_unit: "7TH-ESB",
      donor_unit_mc_count: 5,
      donor_unit_total: 10,
      donor_was_mc: false,
      pendingProposals: [],
    });
    expect(pmcDonor.donorBreach).toBe(false);
    expect(pmcDonor.donorAlreadyBelow).toBe(false);
    expect(pmcDonor.donorBeforeRate).toBeCloseTo(pmcDonor.donorAfterRate, 4);
  });

  test("multi-pending delta accumulates correctly across queued proposals", () => {
    // Two prior queued proposals already strip MC hulls from 7TH-ESB
    // and feed them into CLB-6. The new proposal is a third strip.
    const pending: PendingDelta[] = [
      { recipient_unit: "CLB-6", donor_unit: "7TH-ESB", donor_was_mc: true },
      { recipient_unit: "CLB-6", donor_unit: "7TH-ESB", donor_was_mc: true },
    ];

    // Donor 7TH-ESB starts at 9/10 = 90%. After the two pending strips
    // baseline drops to 7/10 = 70%. The third strip (this one) drops
    // it to 6/10 = 60% → breach.
    const proj = computeProposeProjection({
      recipient_unit: "CLB-6",
      recipient_unit_mc_count: 4,
      recipient_unit_total: 10,
      donor_unit: "7TH-ESB",
      donor_unit_mc_count: 9,
      donor_unit_total: 10,
      donor_was_mc: true,
      pendingProposals: pending,
    });

    expect(proj.donorBeforeMc).toBe(7);
    expect(proj.donorBeforeRate).toBeCloseTo(0.70, 4);
    expect(proj.donorAfterMc).toBe(6);
    expect(proj.donorAfterRate).toBeCloseTo(0.60, 4);
    expect(proj.donorBreach).toBe(true);

    // Recipient CLB-6 baseline 4/10 = 40%, +2 from pending → 6/10 = 60%,
    // +1 this strip → 7/10 = 70%.
    expect(proj.recipientBeforeMc).toBe(6);
    expect(proj.recipientBeforeRate).toBeCloseTo(0.60, 4);
    expect(proj.recipientAfterMc).toBe(7);
    expect(proj.recipientAfterRate).toBeCloseTo(0.70, 4);

    // PMC donor in the queue should NOT decrement the donor unit's MC
    // count, even though it counts as an MC win for the recipient.
    const mixed: PendingDelta[] = [
      { recipient_unit: "CLB-6", donor_unit: "7TH-ESB", donor_was_mc: false },
      { recipient_unit: "CLB-6", donor_unit: "7TH-ESB", donor_was_mc: true },
    ];
    const projMixed = computeProposeProjection({
      recipient_unit: "CLB-6",
      recipient_unit_mc_count: 4,
      recipient_unit_total: 10,
      donor_unit: "7TH-ESB",
      donor_unit_mc_count: 9,
      donor_unit_total: 10,
      donor_was_mc: true,
      pendingProposals: mixed,
    });
    // Donor: 9 - 1 (only the MC pending one) = 8, then -1 this strip = 7.
    expect(projMixed.donorBeforeMc).toBe(8);
    expect(projMixed.donorAfterMc).toBe(7);
    // Recipient still gets +2 from queue + 1 this strip.
    expect(projMixed.recipientBeforeMc).toBe(6);
    expect(projMixed.recipientAfterMc).toBe(7);
  });

  test("same-unit (intra-unit) cannibalization nets the two effects on one tally", () => {
    // 5/10 = 50% MC. Strip an MC hull AND install on a deadlined hull
    // in the same unit → the two cancel out exactly on the donor side
    // (-1) and recipient side (+1) so MC count is unchanged.
    const proj = computeProposeProjection({
      recipient_unit: "CLB-6",
      recipient_unit_mc_count: 5,
      recipient_unit_total: 10,
      donor_unit: "CLB-6",
      donor_unit_mc_count: 5,
      donor_unit_total: 10,
      donor_was_mc: true,
      pendingProposals: [],
    });
    expect(proj.sameUnit).toBe(true);
    expect(proj.recipientBeforeMc).toBe(5);
    expect(proj.recipientAfterMc).toBe(5);
    expect(proj.donorBeforeMc).toBe(5);
    expect(proj.donorAfterMc).toBe(5);
    expect(proj.donorBreach).toBe(false);

    // Same-unit case where a prior pending proposal already shifted the
    // tally: pending was a CROSS-unit strip from CLB-6 to 7TH-ESB
    // (donor=CLB-6, recipient=7TH-ESB) which decrements CLB-6 MC count.
    const pending: PendingDelta[] = [
      { recipient_unit: "7TH-ESB", donor_unit: "CLB-6", donor_was_mc: true },
    ];
    const proj2 = computeProposeProjection({
      recipient_unit: "CLB-6",
      recipient_unit_mc_count: 5,
      recipient_unit_total: 10,
      donor_unit: "CLB-6",
      donor_unit_mc_count: 5,
      donor_unit_total: 10,
      donor_was_mc: true,
      pendingProposals: pending,
    });
    expect(proj2.sameUnit).toBe(true);
    // Pending pushed CLB-6 down by 1 → before = 4. Same-unit strip
    // nets to zero, so after also = 4.
    expect(proj2.donorBeforeMc).toBe(4);
    expect(proj2.donorAfterMc).toBe(4);
    expect(proj2.recipientBeforeMc).toBe(4);
    expect(proj2.recipientAfterMc).toBe(4);
  });
});
