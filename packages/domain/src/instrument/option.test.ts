import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { isUnavailable } from "./common";
import { DEFAULT_CONVENTIONS } from "./conventions";
import { call, optionState } from "./fixtures";
import {
  callBreakeven,
  callPayoff,
  effectiveLeverage,
  optionModel,
  rollsRequired,
  selectContract,
  spreadFraction,
} from "./option";

const C = DEFAULT_CONVENTIONS;
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

describe("option formulas", () => {
  it("effective leverage is delta times spot over premium", () => {
    expect(effectiveLeverage(0.55, 100_000, 8_000)).toBeCloseTo(6.875, 10);
  });

  it("rolls: zero when expiry covers the horizon, ceil(h/dte) - 1 otherwise", () => {
    expect(rollsRequired(90, 120)).toBe(0);
    expect(rollsRequired(90, 90)).toBe(0);
    expect(rollsRequired(90, 30)).toBe(2);
    expect(rollsRequired(91, 30)).toBe(3);
  });

  it("spread fraction uses bid/ask when present, fallback otherwise", () => {
    expect(spreadFraction(call(), 0.02)).toBeCloseTo(200 / 8_000, 10);
    expect(spreadFraction(call({ bid: Option.none() }), 0.02)).toBe(0.02);
  });

  it("call payoff is -1 at or below strike and linear above; breakeven at (K + P)/S", () => {
    expect(callPayoff(100_000, 8_000, 100_000, 0.9)).toBe(-1);
    expect(callPayoff(100_000, 8_000, 100_000, 1.0)).toBe(-1);
    expect(callPayoff(100_000, 8_000, 100_000, 1.16)).toBeCloseTo(1, 10);
    expect(callBreakeven(100_000, 8_000, 100_000, 0)).toBeCloseTo(1.08, 10);
    expect(callPayoff(100_000, 8_000, 100_000, callBreakeven(100_000, 8_000, 100_000, 0))).toBeCloseTo(0, 10);
  });
});

describe("selectContract", () => {
  const chain = [
    call({ strike: 90_000, premium: 14_000, delta: Option.some(0.75) }), // Ω ≈ 5.36
    call({ strike: 100_000, premium: 8_000, delta: Option.some(0.55) }), // Ω ≈ 6.88
    call({ strike: 120_000, premium: 2_500, delta: Option.some(0.25) }), // Ω = 10
    call({ type: "Put", strike: 100_000, premium: 7_000, delta: Option.some(-0.45) }),
    call({ strike: 100_000, premium: 1_000, delta: Option.some(0.5), expiry: Option.some("2026-01-03T08:00:00.000Z") }),
  ];

  it("picks the highest call at or below the target leverage and ignores puts", () => {
    const c = Option.getOrThrow(selectContract(chain, OBSERVED_AT, 7, 7));
    expect(c.quote.strike).toBe(100_000);
    expect(c.quote.premium).toBe(8_000);
  });

  it("snaps down: a 9x request takes the 6.9x call, not the nearer 10x call", () => {
    const c = Option.getOrThrow(selectContract(chain, OBSERVED_AT, 9, 7));
    expect(c.omega).toBeCloseTo(6.875, 6);
  });

  it("falls back to the nearest contract when nothing sits below the target", () => {
    const c = Option.getOrThrow(selectContract(chain, OBSERVED_AT, 2, 7));
    expect(c.omega).toBeCloseTo(5.357, 2);
  });

  it("ignores contracts expiring sooner than minDaysToExpiry", () => {
    const c = Option.getOrThrow(selectContract(chain, OBSERVED_AT, 50, 7));
    expect(c.quote.premium).not.toBe(1_000);
  });

  it("returns none for an empty or all-put chain", () => {
    expect(Option.isNone(selectContract([], OBSERVED_AT, 5, 7))).toBe(true);
    expect(Option.isNone(selectContract([chain[3]!], OBSERVED_AT, 5, 7))).toBe(true);
  });
});

describe("optionModel.quote", () => {
  const chain = [
    call({ strike: 90_000, premium: 14_000, delta: Option.some(0.75) }),
    call({ strike: 100_000, premium: 8_000, delta: Option.some(0.55) }),
    call({ strike: 120_000, premium: 2_500, delta: Option.some(0.25) }),
  ];

  it("NotListed on an empty chain", () => {
    const q = optionModel.quote(optionState([]), 5, 90, C);
    expect(isUnavailable(q) && q._tag === "NotListed").toBe(true);
  });

  it("UnsupportedInV1 for perpetual-style options", () => {
    const q = optionModel.quote(optionState(chain, { style: "Perpetual" }), 5, 90, C);
    expect(isUnavailable(q) && q._tag === "UnsupportedInV1").toBe(true);
  });

  it("LeverageNotAttainable when the nearest contract is outside tolerance", () => {
    const q = optionModel.quote(optionState(chain), 40, 90, C);
    expect(isUnavailable(q) && q._tag === "LeverageNotAttainable" && Math.abs(q.maximum - 10) < 1e-9).toBe(true);
  });

  it("never snaps up: a 4x request has no call at or below it within reach", () => {
    const q = optionModel.quote(optionState(chain), 4, 90, C);
    expect(isUnavailable(q) && q._tag === "LeverageNotAttainable").toBe(true);
  });

  it("support lists one pin per eligible call, sorted by leverage", () => {
    const s = optionModel.support(optionState(chain), C);
    if (s._tag !== "Discrete") throw new Error(s._tag);
    expect(s.points.map(p => Number(p.leverage.toFixed(2)))).toEqual([5.36, 6.88, 10]);
    expect(s.points[1]!.label).toBe("100,000 call, 2026-03-27");
  });

  it("a 7x request lands on the ATM call: Prepaid, Convex, Expiry, no rolls for an 85-day tenor", () => {
    const q = optionModel.quote(optionState(chain), 7, 60, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    const d = optionModel.decodeDetail(q);
    expect(q.carryKind).toBe("Prepaid");
    expect(q.payoffShape).toBe("Convex");
    expect(q.ruinMode).toBe("Expiry");
    expect(q.achievedLeverage).toBeCloseTo(6.875, 6);
    expect(d.rollsRequired).toBe(0);
    expect(Option.getOrThrow(q.ruinPriceRatio)).toBeCloseTo(1, 10);
    expect(q.breakevenPriceRatio).toBeCloseTo(1.08, 10);
    expect(q.capitalPerExposure).toBeCloseTo(1 / 6.875, 6);
  });

  it("a horizon longer than the tenor requires rolls and raises the breakeven by the spread", () => {
    const q = optionModel.quote(optionState(chain), 7, 200, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    const d = optionModel.decodeDetail(q);
    expect(d.rollsRequired).toBe(2);
    expect(q.breakevenPriceRatio).toBeGreaterThan(1.08);
    expect(optionModel.payoff(q, d, q.breakevenPriceRatio, 200)).toBeCloseTo(0, 10);
  });

  it("payoff is capital-losing at the strike and convex above it", () => {
    const q = optionModel.quote(optionState(chain), 7, 60, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    const d = optionModel.decodeDetail(q);
    expect(optionModel.payoff(q, d, 1.0, 60)).toBe(-1);
    const p1 = optionModel.payoff(q, d, 1.2, 60);
    const p2 = optionModel.payoff(q, d, 1.4, 60);
    expect(p2 - p1).toBeCloseTo(p1 - optionModel.payoff(q, d, 1.0, 60) + 1 - 1, 6);
    expect(p1).toBeCloseTo(0.2 * 100_000 / 8_000 - 1, 10);
  });
});
