import { Option } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  borrowModel,
  carryOnCapital,
  equityAtLiquidation,
  leverageAfterLoops,
  liquidationPriceRatio,
  loopsRequired,
  maxLeverage,
} from "./borrow";
import { isUnavailable } from "./common";
import { DEFAULT_CONVENTIONS } from "./conventions";
import { borrowState } from "./fixtures";

const C = DEFAULT_CONVENTIONS;

describe("borrow formulas", () => {
  it("one loop at 80% LTV reaches 1.8x; infinite loops tend to 5x", () => {
    expect(leverageAfterLoops(0.8, 1)).toBeCloseTo(1.8, 10);
    expect(leverageAfterLoops(0.8, 0)).toBe(1);
    expect(leverageAfterLoops(0.8, 200)).toBeCloseTo(5, 6);
    expect(maxLeverage(0.8, 1)).toBeCloseTo(1.8, 10);
  });

  it("leverage after loops is increasing in loops and bounded by 1/(1-ltv)", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 0.95, noNaN: true }), fc.integer({ min: 0, max: 30 }), (ltv, n) => {
        const a = leverageAfterLoops(ltv, n);
        const b = leverageAfterLoops(ltv, n + 1);
        return a <= b && b <= 1 / (1 - ltv) + 1e-9;
      }),
    );
  });

  it("2x with 80% liquidation LTV liquidates at 0.625", () => {
    expect(Option.getOrThrow(liquidationPriceRatio(2, 0.8))).toBeCloseTo(0.625, 10);
    expect(Option.isNone(liquidationPriceRatio(1, 0.8))).toBe(true);
  });

  it("loopsRequired picks the smallest loop count that reaches the target", () => {
    expect(loopsRequired(1, 0.8, 3)).toEqual(Option.some(0));
    expect(loopsRequired(1.5, 0.8, 3)).toEqual(Option.some(1));
    expect(loopsRequired(2.2, 0.8, 3)).toEqual(Option.some(2));
    expect(loopsRequired(3, 0.8, 1)).toEqual(Option.none());
  });

  it("carry nets supply yield only when the convention says so", () => {
    expect(carryOnCapital(2, 0.08, Option.some(0.01), true)).toBeCloseTo(0.08 - 0.02, 10);
    expect(carryOnCapital(2, 0.08, Option.some(0.01), false)).toBeCloseTo(0.08, 10);
  });

  it("equity at liquidation is the penalty-reduced collateral minus debt, floored at -1", () => {
    expect(equityAtLiquidation(2, 0.625, 0.05)).toBeCloseTo(2 * 0.625 * 0.95 - 1 - 1, 10);
    expect(equityAtLiquidation(5, 0.1, 0.5)).toBe(-1);
  });
});

describe("borrowModel.quote", () => {
  it("1.5x in one loop is Floating, Linear, Liquidation", () => {
    const q = borrowModel.quote(borrowState(), 1.5, 90, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    expect(q.carryKind).toBe("Floating");
    expect(q.ruinMode).toBe("Liquidation");
    expect(borrowModel.decodeDetail(q).loops).toBe(1);
    expect(borrowModel.decodeDetail(q).debtPerCapital).toBeCloseTo(0.5, 10);
    expect(q.carryOnCapital).toBeCloseTo(0.08 * 0.5 - 0.01 * 1.5, 10);
  });

  it("refuses 3x under the one-loop convention with the 1.8x ceiling", () => {
    const q = borrowModel.quote(borrowState(), 3, 90, C);
    expect(isUnavailable(q) && q._tag === "LeverageNotAttainable" && Math.abs(q.maximum - 1.8) < 1e-9).toBe(true);
  });

  it("allows 3x when conventions permit more loops", () => {
    const q = borrowModel.quote(borrowState(), 3, 90, { ...C, borrow: { ...C.borrow, maxLoops: 5 } });
    expect(isUnavailable(q)).toBe(false);
  });

  it("fixed-term markets quote Fixed carry", () => {
    const s = borrowState();
    const q = borrowModel.quote({ ...s, rate: { ...s.rate, fixedTermDays: Option.some(90) } }, 1.5, 90, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    expect(q.carryKind).toBe("Fixed");
  });

  it("payoff below liquidation uses penalty-adjusted equity, not -1", () => {
    const q = borrowModel.quote(borrowState(), 1.8, 90, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    const d = borrowModel.decodeDetail(q);
    const r = Option.getOrThrow(q.ruinPriceRatio);
    expect(borrowModel.payoff(q, d, r, 90)).toBeGreaterThan(-1);
    expect(borrowModel.payoff(q, d, q.breakevenPriceRatio, 90)).toBeCloseTo(0, 10);
  });
});
