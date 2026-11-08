import { Schema } from 'effect'

import { AssetId, Leverage, PriceRatio, VenueId } from './common'

// ---------------------------------------------------------------------------
// Perpetual future. Linear payoff, floating carry (funding), liquidation on
// the venue's mark price, no expiry. Leverage is a direct parameter.
// ---------------------------------------------------------------------------

/** One funding period as recorded by the venue. Rate is the per-period rate charged on notional. */
export const FundingObservation = Schema.Struct({
  venueId: VenueId,
  assetId: AssetId,
  periodStart: Schema.String,
  periodHours: Schema.Number,
  /** Fraction of notional for the period. Positive means longs pay shorts. */
  rate: Schema.Number,
  /** Premium component, when the venue publishes it separately from the interest term. */
  premium: Schema.Option(Schema.Number),
  /** Price used to compute the payment; oracle on Hyperliquid, mark elsewhere. */
  notionalPrice: Schema.Number,
  markPrice: Schema.Option(Schema.Number),
})
export type FundingObservation = typeof FundingObservation.Type

/** Margin requirements, often tiered by notional. v1 uses the lowest tier. */
export const MarginTier = Schema.Struct({
  notionalUpTo: Schema.Option(Schema.Number),
  maxLeverage: Leverage,
  maintenanceMarginFraction: Schema.Number,
})
export type MarginTier = typeof MarginTier.Type

/** Everything the perp model needs at one observation time. */
export const PerpState = Schema.Struct({
  venueId: VenueId,
  assetId: AssetId,
  observedAt: Schema.String,
  funding: FundingObservation,
  marginTiers: Schema.Array(MarginTier),
  /** Trailing realized funding, annualized, for the fixed-rate counterfactual (Option B). */
  trailingFundingRate: Schema.Option(Schema.Number),
  /** Hyperliquid pays hourly; Binance every 8h. Needed to annualize correctly. */
  fundingPeriodsPerYear: Schema.Number,
})
export type PerpState = typeof PerpState.Type

/** Perp-specific detail carried on a LeveragedExposureQuote. */
export const PerpQuoteDetail = Schema.Struct({
  maintenanceMarginFraction: Schema.Number,
  /** Price ratio that triggers liquidation for a long at the achieved leverage. */
  liquidationPriceRatio: PriceRatio,
  /** Per-period funding rate at observation, before annualizing. */
  fundingRatePerPeriod: Schema.Number,
  /** Whether the quote is for the side that currently receives funding. */
  receivesFunding: Schema.Boolean,
})
export type PerpQuoteDetail = typeof PerpQuoteDetail.Type

// Edge cases this module must handle (tracked here so the spec can test them):
// - funding sign flips: carry becomes negative for longs; carryRate must keep its sign
// - missing funding period: NoObservation, never interpolate silently
// - requested leverage above tier max: LeverageNotAttainable with the cap
// - mark/oracle divergence: liquidation is on mark, funding notional on oracle
// - venues with 8h periods vs 1h: annualize by fundingPeriodsPerYear, never by 8760 blindly
