import { Option } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isUnavailable } from "./common";
import { DEFAULT_CONVENTIONS } from "./conventions";
import { perpState } from "./fixtures";
import { annualizedFunding, liquidationPriceRatio, perpModel } from "./perp";

const C = DEFAULT_CONVENTIONS;

describe("perp formulas", () => {
  it("3x with 5% maintenance liquidates near 0.70", () => {
    expect(Option.getOrThrow(liquidationPriceRatio(3, 0.05))).toBeCloseTo(0.7018, 4);
  });

  it("1x cannot be liquidated", () => {
    expect(Option.isNone(liquidationPriceRatio(1, 0.05))).toBe(true);
  });

  it("maintenance at or above initial margin is rejected by quote, not silently liquidated at entry", () => {
    const state = perpState({ marginTiers: [{ notionalUpTo: Option.none(), maxLeverage: 40, maintenanceMarginFraction: 0.2 }] });
    const q = perpModel.quote(state, 5, 30, C);
    expect(isUnavailable(q) && q._tag === "LeverageNotAttainable").toBe(true);
  });

  it("liquidation ratio rises with leverage and with maintenance", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.01, max: 50, noNaN: true }),
        fc.double({ min: 1.01, max: 50, noNaN: true }),
        fc.double({ min: 0.001, max: 0.2, noNaN: true }),
        (l1, l2, mm) => {
          const [lo, hi] = l1 < l2 ? [l1, l2] : [l2, l1];
          fc.pre(mm < 1 / hi); // otherwise the position is under-margined at entry
          const rLo = Option.getOrThrow(liquidationPriceRatio(lo, mm));
          const rHi = Option.getOrThrow(liquidationPriceRatio(hi, mm));
          return rLo <= rHi && rHi < 1;
        },
      ),
    );
  });

  it("annualizes hourly and 8-hourly funding to the same APR for the same per-year payment", () => {
    expect(annualizedFunding(0.0000125, 8760)).toBeCloseTo(annualizedFunding(0.0001, 1095), 10);
  });
});

describe("perpModel.quote", () => {
  it("produces a Floating, Linear, Liquidation quote at 3x", () => {
    const q = perpModel.quote(perpState(), 3, 90, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    expect(q.carryKind).toBe("Floating");
    expect(q.payoffShape).toBe("Linear");
    expect(q.ruinMode).toBe("Liquidation");
    expect(q.achievedLeverage).toBe(3);
    expect(q.carryOnCapital).toBeCloseTo(0.0000125 * 8760 * 3, 10);
    expect(q.capitalPerExposure).toBeCloseTo(1 / 3, 10);
  });

  it("negative funding means the long is paid: carry is negative", () => {
    const state = perpState();
    const q = perpModel.quote({ ...state, funding: { ...state.funding, rate: -0.0001 } }, 2, 30, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    expect(q.carryOnCapital).toBeLessThan(0);
    expect(perpModel.decodeDetail(q).receivesFunding).toBe(true);
  });

  it("refuses leverage above the tier cap with the cap in the reason", () => {
    const q = perpModel.quote(perpState(), 50, 30, C);
    expect(isUnavailable(q) && q._tag === "LeverageNotAttainable" && q.maximum === 40).toBe(true);
  });

  it("payoff is linear above liquidation and -1 at or below it", () => {
    const q = perpModel.quote(perpState(), 3, 90, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    const d = perpModel.decodeDetail(q);
    expect(perpModel.payoff(q, d, 1.1, 90)).toBeCloseTo(0.3 - q.carryOnCapital * (90 / 365), 10);
    expect(perpModel.payoff(q, d, Option.getOrThrow(q.ruinPriceRatio), 90)).toBe(-1);
    expect(perpModel.payoff(q, d, q.breakevenPriceRatio, 90)).toBeCloseTo(0, 10);
  });

  it("carryStep over one hour equals the per-period rate times leverage", () => {
    const state = perpState();
    const q = perpModel.quote(state, 4, 90, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    expect(perpModel.carryStep(q, state, 1)).toBeCloseTo(0.0000125 * 4, 12);
  });
});
