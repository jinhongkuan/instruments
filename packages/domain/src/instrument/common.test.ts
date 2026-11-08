import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { type LeverageSupport, resolveLeverage } from "./common";

describe("resolveLeverage", () => {
  const cont: LeverageSupport = { _tag: "Continuous", min: 1, max: 1.8 };
  const disc: LeverageSupport = {
    _tag: "Discrete",
    points: [
      { leverage: 5.36, label: "90k" },
      { leverage: 6.88, label: "100k" },
      { leverage: 10, label: "120k" },
    ],
  };

  it("continuous is exact inside the range and unattainable beyond the cap", () => {
    expect(resolveLeverage(cont, 1.5, 0.25)).toEqual({ _tag: "Exact", leverage: 1.5 });
    const r = resolveLeverage(cont, 3, 0.25);
    expect(r._tag === "Unattainable" && Option.getOrThrow(r.nearest) === 1.8).toBe(true);
  });

  it("discrete snaps down within tolerance", () => {
    const r = resolveLeverage(disc, 7, 0.25);
    expect(r._tag === "SnappedDown" && r.leverage === 6.88 && r.label === "100k").toBe(true);
  });

  it("discrete never snaps up even when the point above is nearer", () => {
    const r = resolveLeverage(disc, 9, 0.25);
    expect(r._tag === "SnappedDown" && r.leverage === 6.88).toBe(true);
  });

  it("discrete is unattainable below the lowest pin or beyond tolerance", () => {
    const low = resolveLeverage(disc, 3, 0.25);
    expect(low._tag === "Unattainable" && Option.getOrThrow(low.nearest) === 5.36).toBe(true);
    const far = resolveLeverage(disc, 20, 0.25);
    expect(far._tag === "Unattainable" && Option.getOrThrow(far.nearest) === 10).toBe(true);
  });

  it("exact hit on a pin is Exact", () => {
    expect(resolveLeverage(disc, 10, 0.25)).toEqual({ _tag: "Exact", leverage: 10 });
  });
});
