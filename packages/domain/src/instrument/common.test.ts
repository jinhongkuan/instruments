import { Option } from "effect";
import { describe, expect, it } from "vitest";

import { type AxisSupport, resolveAxis, resolveHorizon, resolveLeverage, resolvedValue } from "./common";

describe("resolveAxis", () => {
  const cont: AxisSupport = { _tag: "Continuous", min: 1, max: 1.8, pins: [] };
  const disc: AxisSupport = {
    _tag: "Discrete",
    points: [
      { value: 5.36, label: "90k" },
      { value: 6.88, label: "100k" },
      { value: 10, label: "120k" },
    ],
  };

  it("continuous is exact inside the range; beyond the cap it is unattainable with the cap as fallback", () => {
    expect(resolveLeverage(cont, 1.5, 0.25)).toEqual({ _tag: "Exact", value: 1.5 });
    const r = resolveLeverage(cont, 3, 0.25);
    expect(r._tag === "Unattainable" && Option.getOrThrow(r.fallback) === 1.8).toBe(true);
    expect(Option.getOrThrow(resolvedValue(r))).toBe(1.8);
  });

  it("leverage snaps down within tolerance", () => {
    const r = resolveLeverage(disc, 7, 0.25);
    expect(r._tag === "Snapped" && r.value === 6.88 && r.direction === "Down" && r.label === "100k").toBe(true);
  });

  it("leverage never snaps up even when the point above is nearer", () => {
    const r = resolveLeverage(disc, 9, 0.25);
    expect(r._tag === "Snapped" && r.value === 6.88).toBe(true);
  });

  it("unattainable leverage still reports the highest pin below as fallback", () => {
    const far = resolveLeverage(disc, 20, 0.25);
    expect(far._tag === "Unattainable" && Option.getOrThrow(far.fallback) === 10).toBe(true);
    const low = resolveLeverage(disc, 3, 0.25);
    expect(low._tag === "Unattainable" && Option.isNone(low.fallback) && Option.getOrThrow(low.nearest) === 5.36).toBe(true);
  });

  it("exact hit on a pin is Exact", () => {
    expect(resolveLeverage(disc, 10, 0.25)).toEqual({ _tag: "Exact", value: 10 });
  });

  it("horizon snaps up on discrete support", () => {
    const terms: AxisSupport = {
      _tag: "Discrete",
      points: [
        { value: 30, label: "30d" },
        { value: 90, label: "90d" },
      ],
    };
    const r = resolveHorizon(terms, 75, 0.25);
    expect(r._tag === "Snapped" && r.value === 90 && r.direction === "Up").toBe(true);
    const beyond = resolveHorizon(terms, 200, 0.25);
    expect(beyond._tag === "Unattainable" && Option.getOrThrow(beyond.fallback) === 90).toBe(true);
  });

  it("nearest policy picks the closer pin in either direction", () => {
    const r = resolveAxis(disc, 9.5, 0.25, "Nearest");
    expect(r._tag === "Snapped" && r.value === 10 && r.direction === "Up").toBe(true);
  });
});
