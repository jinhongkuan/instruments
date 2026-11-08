import { Option } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { borrowModel, carryOnCapital } from "./borrow";
import { isUnavailable } from "./common";
import { DEFAULT_CONVENTIONS } from "./conventions";
import { borrowState } from "./fixtures";

const C = DEFAULT_CONVENTIONS;

describe("benchmark (spot + borrow at a dollar rate)", () => {
  it("carry on capital is interest on L − 1 borrowed dollars", () => {
    expect(carryOnCapital(1, 0.045)).toBe(0);
    expect(carryOnCapital(3, 0.045)).toBeCloseTo(0.09, 10);
  });

  it("quotes any leverage as Fixed, Linear, no ruin", () => {
    const q = borrowModel.quote(borrowState(), 5, 90, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    expect(q.carryKind).toBe("Fixed");
    expect(q.payoffShape).toBe("Linear");
    expect(q.ruinMode).toBe("None");
    expect(Option.isNone(q.ruinPriceRatio)).toBe(true);
    expect(q.carryOnCapital).toBeCloseTo(0.045 * 4, 10);
    expect(borrowModel.decodeDetail(q).rateSource).toBe("SOFR");
  });

  it("payoff is linear in terminal price and zero at breakeven", () => {
    const q = borrowModel.quote(borrowState(), 2, 365, C);
    if (isUnavailable(q)) throw new Error(q._tag);
    const d = borrowModel.decodeDetail(q);
    expect(borrowModel.payoff(q, d, 1.2, 365)).toBeCloseTo(0.4 - 0.045, 10);
    expect(borrowModel.payoff(q, d, q.breakevenPriceRatio, 365)).toBeCloseTo(0, 10);
    expect(borrowModel.payoff(q, d, 0.1, 365)).toBe(-1);
  });

  it("breakeven rises with leverage and horizon", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1.01, max: 20, noNaN: true }),
        fc.double({ min: 1.01, max: 20, noNaN: true }),
        fc.integer({ min: 1, max: 365 }),
        (l1, l2, h) => {
          const [lo, hi] = l1 < l2 ? [l1, l2] : [l2, l1];
          const a = borrowModel.quote(borrowState(), lo, h, C);
          const b = borrowModel.quote(borrowState(), hi, h, C);
          if (isUnavailable(a) || isUnavailable(b)) return false;
          return a.breakevenPriceRatio <= b.breakevenPriceRatio + 1e-12;
        },
      ),
    );
  });

  it("support is unbounded up to the sanity ceiling", () => {
    expect(borrowModel.support(borrowState(), C).leverage).toMatchObject({ _tag: "Continuous", min: 1, max: 1000 });
  });
});
