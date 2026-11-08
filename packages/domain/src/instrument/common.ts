import { Schema } from "effect";

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
