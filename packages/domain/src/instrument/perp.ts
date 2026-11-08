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

// ---------------------------------------------------------------------------
// Formulas. All per unit of capital, long exposure, leverage L = exposure / capital.
// ---------------------------------------------------------------------------

import { Array, Option, Schema as S, pipe } from 'effect'

import {
  DAYS_PER_YEAR,
  type InstrumentModel,
  type LeveragedExposureQuote,
  type Unavailable,
  linearBreakeven,
  linearNetPayoff,
} from './common'
import type { Conventions } from './conventions'

/** Lowest tier governs small positions, which is the market-wide reference. */
export const maxLeverage = (tiers: ReadonlyArray<MarginTier>): Option.Option<number> =>
  pipe(
    Array.head(tiers),
    Option.map(tier => tier.maxLeverage),
  )

/**
 * Long at leverage L with maintenance fraction mm is liquidated when
 *   1/L + (r − 1) = mm · r   ⇒   r* = (1 − 1/L) / (1 − mm).
 * At L = 1 there is no debt and no liquidation.
 */
export const liquidationPriceRatio = (leverage: number, maintenanceFraction: number): Option.Option<number> =>
  leverage <= 1 ? Option.none() : Option.some((1 - 1 / leverage) / (1 - maintenanceFraction))

/** Per-period funding rate annualized onto notional. Positive means the long pays. */
export const annualizedFunding = (ratePerPeriod: number, periodsPerYear: number): number =>
  ratePerPeriod * periodsPerYear

export const perpModel: InstrumentModel<PerpState, PerpQuoteDetail> = {
  kind: 'Perp',

  quote: (state, leverage, horizonDays, conventions): LeveragedExposureQuote | Unavailable => {
    const maybeMax = maxLeverage(state.marginTiers)
    if (Option.isNone(maybeMax)) {
      return { _tag: 'NoObservation', kind: 'Perp', observedAt: state.observedAt }
    }
    if (leverage > maybeMax.value) {
      return {
        _tag: 'LeverageNotAttainable',
        kind: 'Perp',
        requested: leverage,
        maximum: maybeMax.value,
        reason: `Venue caps leverage at ${maybeMax.value}x for the lowest margin tier`,
      }
    }
    const tier = state.marginTiers[0]!
    if (1 / leverage <= tier.maintenanceMarginFraction) {
      return {
        _tag: 'LeverageNotAttainable',
        kind: 'Perp',
        requested: leverage,
        maximum: 1 / tier.maintenanceMarginFraction,
        reason: `Initial margin 1/${leverage} would not clear maintenance ${tier.maintenanceMarginFraction}`,
      }
    }
    const carryRate = annualizedFunding(state.funding.rate, state.fundingPeriodsPerYear)
    const carryOnCapital = carryRate * leverage
    const ruin = liquidationPriceRatio(leverage, tier.maintenanceMarginFraction)
    const detail: PerpQuoteDetail = {
      maintenanceMarginFraction: tier.maintenanceMarginFraction,
      liquidationPriceRatio: Option.getOrElse(ruin, () => 0),
      fundingRatePerPeriod: state.funding.rate,
      receivesFunding: state.funding.rate < 0,
    }
    return {
      kind: 'Perp',
      venueId: state.venueId,
      assetId: state.assetId,
      observedAt: state.observedAt,
      leverage,
      achievedLeverage: leverage,
      carryKind: 'Floating',
      carryRate,
      carryOnCapital,
      payoffShape: 'Linear',
      ruinMode: Option.isSome(ruin) ? 'Liquidation' : 'None',
      ruinPriceRatio: ruin,
      breakevenPriceRatio: linearBreakeven(leverage, carryOnCapital, horizonDays),
      capitalPerExposure: 1 / leverage,
      detail,
      conventionsVersion: conventions.version,
    }
  },

  payoff: (quote, _detail, terminal, horizonDays) =>
    Option.isSome(quote.ruinPriceRatio) && terminal <= quote.ruinPriceRatio.value
      ? -1
      : Math.max(-1, linearNetPayoff(quote.achievedLeverage, quote.carryOnCapital, terminal, horizonDays)),

  carryStep: (quote, state, stepHours) =>
    state.funding.rate * (stepHours / state.funding.periodHours) * quote.achievedLeverage,

  decodeDetail: quote => S.decodeUnknownSync(PerpQuoteDetail)(quote.detail),
}

export const perpCarryOverDays = (ratePerPeriod: number, periodsPerYear: number, leverage: number, days: number): number =>
  annualizedFunding(ratePerPeriod, periodsPerYear) * leverage * (days / DAYS_PER_YEAR)
