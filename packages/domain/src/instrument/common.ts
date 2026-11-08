import { Option, Schema } from "effect";

import type { Conventions } from "./conventions";

// ---------------------------------------------------------------------------
// Reference data shared by every instrument.
// ---------------------------------------------------------------------------

/** Canonical asset, independent of any venue's ticker. */
export const AssetId = Schema.String;
export type AssetId = typeof AssetId.Type;

export const InstrumentKind = Schema.Literals(["Perp", "SpotBorrow", "Option"]);
export type InstrumentKind = typeof InstrumentKind.Type;

/**
 * Why a venue is in the dataset. `Deep` venues price a few assets with real
 * volume (Deribit, Aave, Hyperliquid). `Broad` venues list almost anything
 * with little volume (Panoptic, Morpho, Binance futures). Comparing the two
 * for one asset is how we tell "priced" from "priced but illiquid" from
 * "not priced".
 */
export const LiquidityClass = Schema.Literals(["Deep", "Broad"]);
export type LiquidityClass = typeof LiquidityClass.Type;

export const VenueId = Schema.String;
export type VenueId = typeof VenueId.Type;

export const Venue = Schema.Struct({
  id: VenueId,
  name: Schema.String,
  kind: InstrumentKind,
  liquidityClass: LiquidityClass,
  /** Where the book settles. Regulatory status is a separate concern, out of scope for v1. */
  settlement: Schema.Literals(["OffChain", "OnChain"]),
});
export type Venue = typeof Venue.Type;

/**
 * A venue's listing of an asset for one instrument kind, with validity range.
 * Rows close when a perp is delisted, a pre-launch perp converts at TGE, a
 * pre-IPO perp settles, a ticker is renamed, or a lender freezes a reserve.
 */
export const Market = Schema.Struct({
  venueId: VenueId,
  assetId: AssetId,
  kind: InstrumentKind,
  venueSymbol: Schema.String,
  validFrom: Schema.String,
  validTo: Schema.Option(Schema.String),
});
export type Market = typeof Market.Type;

// ---------------------------------------------------------------------------
// The lens: for a target leverage, how does each instrument price the same
// exposure? Everything below is per unit of capital, so instruments compare
// without reference to any trader's size.
// ---------------------------------------------------------------------------

/** Exposure / capital. 1 is unlevered spot. */
export const Leverage = Schema.Number.check(Schema.isGreaterThan(0));
export type Leverage = typeof Leverage.Type;

/** Terminal price / entry price. 1 is unchanged. */
export const PriceRatio = Schema.Number.check(Schema.isGreaterThan(0));
export type PriceRatio = typeof PriceRatio.Type;

/** Annualized fraction. Positive means the holder pays. */
export const AnnualizedRate = Schema.Number;
export type AnnualizedRate = typeof AnnualizedRate.Type;

/**
 * How carry is charged. This is the axis the floating-carry thesis turns on,
 * so it is first-class rather than inferred from the instrument kind.
 */
export const CarryKind = Schema.Literals([
  "Floating", // reset every period by the market (perp funding, utilization-driven borrow)
  "Fixed", // agreed at entry for the term (fixed-rate borrow, dealer quote)
  "Prepaid", // paid once at entry, decays (vanilla option premium)
  "Streaming", // accrues continuously against a fee stream (Panoptic)
]);
export type CarryKind = typeof CarryKind.Type;

export const PayoffShape = Schema.Literals(["Linear", "Convex"]);
export type PayoffShape = typeof PayoffShape.Type;

/** How a position can be lost in full before the horizon. */
export const RuinMode = Schema.Literals([
  "Liquidation", // forced close when equity crosses a maintenance threshold
  "Expiry", // option expires out of the money
  "None", // cannot be forced out before horizon
]);
export type RuinMode = typeof RuinMode.Type;

/**
 * A market-wide quote for holding one unit of capital at `leverage` in one
 * instrument at one point in time. This is the row every instrument must be
 * able to produce; the dashboard, the counterfactual, and the "is this
 * instrument suitable for this asset" verdict all read from it.
 */
export const LeveragedExposureQuote = Schema.Struct({
  kind: InstrumentKind,
  venueId: VenueId,
  assetId: AssetId,
  observedAt: Schema.String,
  leverage: Leverage,
  /** Exposure actually achieved; may differ from `leverage` when the venue caps it or a chain approximates it. */
  achievedLeverage: Leverage,
  carryKind: CarryKind,
  /** Carry on notional, annualized, as quoted at `observedAt`. */
  carryRate: AnnualizedRate,
  /** Carry on capital, annualized: carryRate × achievedLeverage for linear instruments. */
  carryOnCapital: AnnualizedRate,
  payoffShape: PayoffShape,
  ruinMode: RuinMode,
  /** Price ratio at which the position is lost, if the instrument has one. */
  ruinPriceRatio: Schema.Option(PriceRatio),
  /** Price ratio at which PnL net of carry over the horizon is zero. */
  breakevenPriceRatio: PriceRatio,
  /** Capital that must be posted per unit of exposure. */
  capitalPerExposure: Schema.Number,
  /** Instrument-specific detail, kept opaque here and typed in each instrument module. */
  detail: Schema.Unknown,
  /** Which fairness conventions produced this quote. */
  conventionsVersion: Schema.String,
});
export type LeveragedExposureQuote = typeof LeveragedExposureQuote.Type;

/**
 * Why a quote could not be produced. These are findings, not errors: "no
 * option market exists for this asset" is the dashboard's most useful output.
 */
export const Unavailable = Schema.Union([
  Schema.TaggedStruct("NotListed", { kind: InstrumentKind, assetId: AssetId }),
  Schema.TaggedStruct("LeverageNotAttainable", {
    kind: InstrumentKind,
    requested: Leverage,
    maximum: Leverage,
    reason: Schema.String,
  }),
  Schema.TaggedStruct("NoObservation", {
    kind: InstrumentKind,
    observedAt: Schema.String,
  }),
  Schema.TaggedStruct("OnlyBroadVenue", {
    kind: InstrumentKind,
    venueId: VenueId,
    note: Schema.String,
  }),
  Schema.TaggedStruct("UnsupportedInV1", {
    kind: InstrumentKind,
    reason: Schema.String,
  }),
]);
export type Unavailable = typeof Unavailable.Type;

/**
 * What values of an axis (leverage, horizon) an instrument can deliver for an
 * asset right now. Perps and borrow are continuous up to a cap; option
 * leverage is one point per listed contract; option horizon is continuous
 * (via rolls) with expiries as informational pins. The dashboard sliders are
 * drawn from this, and `quote` must agree with it.
 */
export const AxisPoint = Schema.Struct({
  value: Schema.Number,
  /** Human label for the pin, e.g. "100k call, 27 Mar" or "expiry 27 Mar". */
  label: Schema.String,
});
export type AxisPoint = typeof AxisPoint.Type;

export const AxisSupport = Schema.Union([
  Schema.TaggedStruct("Continuous", {
    min: Schema.Number,
    max: Schema.Number,
    /** Informational markers inside the range (expiries, tier boundaries). Soft-snap targets, never constraints. */
    pins: Schema.Array(AxisPoint),
  }),
  Schema.TaggedStruct("Discrete", { points: Schema.Array(AxisPoint) }),
  Schema.TaggedStruct("None", { reason: Schema.String }),
]);
export type AxisSupport = typeof AxisSupport.Type;

/** Both axes an instrument exposes to the lens. */
export const InstrumentSupport = Schema.Struct({
  leverage: AxisSupport,
  horizonDays: AxisSupport,
});
export type InstrumentSupport = typeof InstrumentSupport.Type;

/**
 * Which way a discrete axis may snap. Leverage snaps Down (more exposure is
 * more risk than asked for). Horizon snaps Up (a shorter tenor forces an extra
 * roll). Nearest is for axes where neither direction is riskier.
 */
export const SnapPolicy = Schema.Literals(["Down", "Up", "Nearest"]);
export type SnapPolicy = typeof SnapPolicy.Type;

export const Resolved = Schema.Union([
  Schema.TaggedStruct("Exact", { value: Schema.Number }),
  Schema.TaggedStruct("Snapped", {
    requested: Schema.Number,
    value: Schema.Number,
    label: Schema.String,
    direction: Schema.Literals(["Down", "Up"]),
  }),
  Schema.TaggedStruct("Unattainable", {
    requested: Schema.Number,
    /** Highest supported value strictly below the request, if any. The UI renders this, greyed, as the fallback. */
    fallback: Schema.Option(Schema.Number),
    /** Nearest supported value in either direction, for the message. */
    nearest: Schema.Option(Schema.Number),
    reason: Schema.String,
  }),
]);
export type Resolved = typeof Resolved.Type;

const fmt = (value: number): string => (value < 10 ? value.toFixed(2) : value.toFixed(0));

/**
 * Map a requested axis value onto what the instrument supports. Continuous
 * support is exact inside the range. Discrete support snaps per `policy`,
 * and only within `tolerance` (relative). Unattainable results still carry
 * the highest supported value below the request so the UI can show it.
 */
export const resolveAxis = (
  support: AxisSupport,
  requested: number,
  tolerance: number,
  policy: SnapPolicy,
): Resolved => {
  switch (support._tag) {
    case "None":
      return { _tag: "Unattainable", requested, fallback: Option.none(), nearest: Option.none(), reason: support.reason };
    case "Continuous":
      if (requested < support.min) {
        return {
          _tag: "Unattainable",
          requested,
          fallback: Option.none(),
          nearest: Option.some(support.min),
          reason: `Minimum is ${fmt(support.min)}`,
        };
      }
      if (requested > support.max) {
        return {
          _tag: "Unattainable",
          requested,
          fallback: Option.some(support.max),
          nearest: Option.some(support.max),
          reason: `Maximum is ${fmt(support.max)}`,
        };
      }
      return { _tag: "Exact", value: requested };
    case "Discrete": {
      const sorted = [...support.points].sort((a, b) => a.value - b.value);
      const exact = sorted.find(p => Math.abs(p.value - requested) <= 1e-9 * Math.max(1, requested));
      if (exact) {
        return { _tag: "Exact", value: exact.value };
      }
      const below = [...sorted].reverse().find(p => p.value < requested);
      const above = sorted.find(p => p.value > requested);
      const nearestAny = [...sorted].sort(
        (a, b) => Math.abs(a.value - requested) - Math.abs(b.value - requested),
      )[0];
      const candidate =
        policy === "Down" ? below : policy === "Up" ? above : nearestAny;
      const fallback = Option.fromNullishOr(below?.value);
      const nearest = Option.fromNullishOr(nearestAny?.value);
      if (candidate === undefined) {
        return {
          _tag: "Unattainable",
          requested,
          fallback,
          nearest,
          reason:
            policy === "Down"
              ? nearestAny
                ? `Lowest listed is ${fmt(nearestAny.value)}`
                : "Nothing listed"
              : policy === "Up"
                ? nearestAny
                  ? `Longest listed is ${fmt(nearestAny.value)}`
                  : "Nothing listed"
                : "Nothing listed",
        };
      }
      const error = Math.abs(requested - candidate.value) / requested;
      if (error > tolerance) {
        return {
          _tag: "Unattainable",
          requested,
          fallback,
          nearest,
          reason: `Nearest ${policy === "Down" ? "at or below" : policy === "Up" ? "at or above" : "listed"} is ${fmt(candidate.value)} (${(error * 100).toFixed(0)}% off)`,
        };
      }
      return {
        _tag: "Snapped",
        requested,
        value: candidate.value,
        label: candidate.label,
        direction: candidate.value < requested ? "Down" : "Up",
      };
    }
  }
};

/** Leverage always snaps down. */
export const resolveLeverage = (support: AxisSupport, requested: number, tolerance: number): Resolved =>
  resolveAxis(support, requested, tolerance, "Down");

/** Horizon snaps up when discrete (fixed-term markets); continuous support is exact. */
export const resolveHorizon = (support: AxisSupport, requestedDays: number, tolerance: number): Resolved =>
  resolveAxis(support, requestedDays, tolerance, "Up");

export const resolvedValue = (resolved: Resolved): Option.Option<number> =>
  resolved._tag === "Unattainable" ? resolved.fallback : Option.some(resolved.value);

export const isUnavailable = (
  value: LeveragedExposureQuote | Unavailable,
): value is Unavailable => "_tag" in value;

/**
 * Depth is out of scope for v1 but the slot exists. When present, a quote may
 * carry the size at which slippage crosses a threshold, and the verdict logic
 * can downgrade "priced" to "priced but illiquid".
 */
export const DepthHint = Schema.Struct({
  notionalAt1PctSlippage: Schema.Option(Schema.Number),
  openInterestNotional: Schema.Option(Schema.Number),
  dailyNotionalVolume: Schema.Option(Schema.Number),
});
export type DepthHint = typeof DepthHint.Type;

/**
 * The contract every instrument module implements. Pure functions over
 * observed market state; no I/O. `State` is the instrument's own observation
 * type (funding and margin tiers for perps, rates and LTVs for borrow, a chain
 * for options). `Detail` is the typed form of the quote's opaque `detail`.
 */
export interface InstrumentModel<State, Detail> {
  readonly kind: InstrumentKind;
  /** Build the market-wide quote for one unit of capital at the requested leverage. */
  readonly quote: (
    state: State,
    leverage: Leverage,
    horizonDays: number,
    conventions: Conventions,
  ) => LeveragedExposureQuote | Unavailable;
  /** PnL per unit of capital at the horizon for a terminal price ratio, net of carry over the horizon. */
  readonly payoff: (
    quote: LeveragedExposureQuote,
    detail: Detail,
    terminal: PriceRatio,
    horizonDays: number,
  ) => number;
  /** Carry accrued per unit of capital over one observation step; positive means the holder paid. */
  readonly carryStep: (
    quote: LeveragedExposureQuote,
    state: State,
    stepHours: number,
  ) => number;
  /** Recover the typed detail from a quote's opaque `detail` field. */
  readonly decodeDetail: (quote: LeveragedExposureQuote) => Detail;
  /** Which leverages and horizons this instrument can deliver from the given state. `quote` must agree with it. */
  readonly support: (state: State, conventions: Conventions) => InstrumentSupport;
}

export const DAYS_PER_YEAR = 365;
export const HOURS_PER_YEAR = 8760;

/** PnL on a linear instrument at leverage L, net of annualized carry on capital over the horizon. */
export const linearNetPayoff = (
  leverage: number,
  carryOnCapital: number,
  terminal: number,
  horizonDays: number,
): number =>
  leverage * (terminal - 1) - carryOnCapital * (horizonDays / DAYS_PER_YEAR);

/** Terminal ratio at which linearNetPayoff is zero. */
export const linearBreakeven = (
  leverage: number,
  carryOnCapital: number,
  horizonDays: number,
): number => 1 + (carryOnCapital * (horizonDays / DAYS_PER_YEAR)) / leverage;
