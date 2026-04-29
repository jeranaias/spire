import { describe, expect, it } from "vitest";
import { adjustedDailyRate, deriveRequirement } from "./logistics";

// Pure-function coverage for the required-quantity rule. The four API endpoints
// (`computeUnitMetrics`, `POST /units/:id/supply`, the custom-item PATCH, and
// the supply restore POST) all delegate to this helper, so adding a branch
// only requires a unit test here — no DB seeding needed.

describe("deriveRequirement", () => {
  describe("override === 0 (not a requirement)", () => {
    it("reports zero required, zero shortfall, and green status", () => {
      const r = deriveRequirement({
        override: 0,
        onHand: 0,
        dailyConsumption: 100,
        missionDays: 30,
      });
      expect(r).toEqual({
        required: 0,
        isRequirement: false,
        shortfall: 0,
        status: "green",
      });
    });

    it("ignores on-hand and consumption when override is zero", () => {
      // Even with depleted stock and a heavy daily burn, override=0 must
      // suppress the requirement entirely.
      const r = deriveRequirement({
        override: 0,
        onHand: 9999,
        dailyConsumption: 5,
        missionDays: 14,
      });
      expect(r.isRequirement).toBe(false);
      expect(r.required).toBe(0);
      expect(r.shortfall).toBe(0);
      expect(r.status).toBe("green");
    });
  });

  describe("override > 0 (coverage-based status)", () => {
    it("returns green with zero shortfall when fully covered", () => {
      const r = deriveRequirement({
        override: 200,
        onHand: 200,
        dailyConsumption: 0,
        missionDays: 30,
      });
      expect(r).toEqual({
        required: 200,
        isRequirement: true,
        shortfall: 0,
        status: "green",
      });
    });

    it("returns green when on hand exceeds the override", () => {
      const r = deriveRequirement({
        override: 100,
        onHand: 250,
        dailyConsumption: 0,
        missionDays: 30,
      });
      expect(r.status).toBe("green");
      expect(r.shortfall).toBe(0);
    });

    it("returns amber for coverage between 40% and 100%", () => {
      // 100 / 200 = 50% coverage
      const r = deriveRequirement({
        override: 200,
        onHand: 100,
        dailyConsumption: 0,
        missionDays: 30,
      });
      expect(r.status).toBe("amber");
      expect(r.shortfall).toBe(100);
    });

    it("returns amber exactly at the 40% boundary", () => {
      // 80 / 200 = 40% coverage — boundary is inclusive
      const r = deriveRequirement({
        override: 200,
        onHand: 80,
        dailyConsumption: 0,
        missionDays: 30,
      });
      expect(r.status).toBe("amber");
    });

    it("returns red when coverage is below 40%", () => {
      // 50 / 200 = 25% coverage
      const r = deriveRequirement({
        override: 200,
        onHand: 50,
        dailyConsumption: 0,
        missionDays: 30,
      });
      expect(r.status).toBe("red");
      expect(r.shortfall).toBe(150);
    });

    it("ignores daily consumption / mission days when an override is set", () => {
      // Auto-computed would be 100 × 30 = 3000, but the planner override
      // of 500 supersedes it.
      const r = deriveRequirement({
        override: 500,
        onHand: 500,
        dailyConsumption: 100,
        missionDays: 30,
      });
      expect(r.required).toBe(500);
      expect(r.shortfall).toBe(0);
      expect(r.status).toBe("green");
    });
  });

  describe("override === null (auto-computed)", () => {
    it("derives required from daily burn × mission days", () => {
      const r = deriveRequirement({
        override: null,
        onHand: 1500,
        dailyConsumption: 100,
        missionDays: 30,
      });
      expect(r.required).toBe(3000);
      expect(r.isRequirement).toBe(true);
      expect(r.shortfall).toBe(1500);
      // 1500 / 100 = 15 days of supply → green per statusFromDays
      expect(r.status).toBe("green");
    });

    it("treats undefined override the same as null (auto-computed)", () => {
      const r = deriveRequirement({
        override: undefined,
        onHand: 1500,
        dailyConsumption: 100,
        missionDays: 30,
      });
      expect(r.required).toBe(3000);
      expect(r.isRequirement).toBe(true);
    });

    it("returns amber when DOS falls between 2 and 5 days", () => {
      // 250 on hand at 100/day = 2.5 DOS → amber
      const r = deriveRequirement({
        override: null,
        onHand: 250,
        dailyConsumption: 100,
        missionDays: 30,
      });
      expect(r.required).toBe(3000);
      expect(r.shortfall).toBe(2750);
      expect(r.status).toBe("amber");
    });

    it("returns red when DOS is below 2", () => {
      // 50 on hand at 100/day = 0.5 DOS → red
      const r = deriveRequirement({
        override: null,
        onHand: 50,
        dailyConsumption: 100,
        missionDays: 30,
      });
      expect(r.status).toBe("red");
      expect(r.shortfall).toBe(2950);
    });

    it("treats zero daily consumption as effectively unlimited DOS (green)", () => {
      // No daily burn → DOS = 999 → green; required collapses to 0 because
      // burn × days = 0, so any positive on-hand has zero shortfall.
      const r = deriveRequirement({
        override: null,
        onHand: 0,
        dailyConsumption: 0,
        missionDays: 30,
      });
      expect(r.required).toBe(0);
      expect(r.shortfall).toBe(0);
      expect(r.status).toBe("green");
    });

    it("never reports a negative shortfall when on hand exceeds the requirement", () => {
      const r = deriveRequirement({
        override: null,
        onHand: 5000,
        dailyConsumption: 100,
        missionDays: 30,
      });
      expect(r.required).toBe(3000);
      expect(r.shortfall).toBe(0);
    });
  });
});

// Regression coverage for adjustedDailyRate.
//
// The calculator bill renders `line.dailyConsumption.toFixed(2) + "/day"`.
// That value must equal baseDailyRate × climateMult × tempoMult × personnel —
// no extra multiplication by personnel in the display layer.
//
// Pinning these values here means any drift in the multiplier tables or the
// formula itself fails fast in CI, before the change reaches planners.

describe("adjustedDailyRate", () => {
  describe("default scenario — 40 PAX, Temperate, Sustained (all multipliers = 1.0)", () => {
    it("MRE: 3.0 base × 1.0 × 1.0 × 40 = 120", () => {
      expect(adjustedDailyRate(3.0, "I", "temperate", "sustained", 40)).toBe(120);
    });

    it("Potable Water: 1.5 base × 1.0 × 1.0 × 40 = 60", () => {
      expect(adjustedDailyRate(1.5, "I", "temperate", "sustained", 40)).toBe(60);
    });
  });

  describe("climate multipliers", () => {
    it("arid boosts Class I by 1.6× — 3.0 × 1.6 × 1.0 × 40 ≈ 192", () => {
      expect(adjustedDailyRate(3.0, "I", "arid", "sustained", 40)).toBeCloseTo(192, 8);
    });

    it("tropical boosts Class I by 1.25× — 3.0 × 1.25 × 1.0 × 40 = 150", () => {
      expect(adjustedDailyRate(3.0, "I", "tropical", "sustained", 40)).toBeCloseTo(150, 8);
    });

    it("arctic boosts Class I by 1.35× — 3.0 × 1.35 × 1.0 × 40 ≈ 162", () => {
      expect(adjustedDailyRate(3.0, "I", "arctic", "sustained", 40)).toBeCloseTo(162, 8);
    });
  });

  describe("op-tempo multipliers", () => {
    it("high tempo boosts Class I by 1.1× — 3.0 × 1.0 × 1.1 × 40 ≈ 132", () => {
      expect(adjustedDailyRate(3.0, "I", "temperate", "high", 40)).toBeCloseTo(132, 8);
    });

    it("combat tempo boosts Class I by 1.15× — 3.0 × 1.0 × 1.15 × 40 ≈ 138", () => {
      expect(adjustedDailyRate(3.0, "I", "temperate", "combat", 40)).toBeCloseTo(138, 8);
    });

    it("garrison tempo reduces Class I to 0.9× — 3.0 × 1.0 × 0.9 × 40 ≈ 108", () => {
      expect(adjustedDailyRate(3.0, "I", "temperate", "garrison", 40)).toBeCloseTo(108, 8);
    });
  });

  describe("personnel scaling", () => {
    it("rate scales linearly with personnel — doubling PAX doubles the output", () => {
      const rate40 = adjustedDailyRate(3.0, "I", "temperate", "sustained", 40);
      const rate80 = adjustedDailyRate(3.0, "I", "temperate", "sustained", 80);
      expect(rate80).toBe(rate40 * 2);
    });

    it("zero personnel yields zero daily rate", () => {
      expect(adjustedDailyRate(3.0, "I", "temperate", "sustained", 0)).toBe(0);
    });
  });
});
