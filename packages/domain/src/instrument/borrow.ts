import { Option, Schema } from 'effect'

import {
  AssetId,
  type InstrumentModel,
  type LeveragedExposureQuote,
  type Unavailable,
  VenueId,
  linearBreakeven,
  linearNetPayoff,
} from './common'
import { LocalDate } from './calendar'

// ---------------------------------------------------------------------------
// Spot + borrow, as a BENCHMARK. The holder is assumed to have unlimited
// credit at a dollar interest rate, buys spot with it, and can never be
// liquidated. It is the "against a loan" baseline from the floating-carry
// thesis: linear payoff, fixed carry, no ruin. Its job is to expose what the
// perp and the option charge for the same exposure without credit. No lending
// market is modeled; the only input is the rate.
// ---------------------------------------------------------------------------

/**
 * A dollar interest rate observation: SOFR, a T-bill yield, or a stablecoin term rate.
 * A published rate describes one business day and applies until the next one, so
 * Friday's SOFR covers the weekend. Whether it is late is decided by the source's
 * publication schedule (see `publication.ts`), not by its age.
 */
export const BenchmarkRate = Schema.Struct({
  /** The business day the rate describes. */
  effectiveDate: LocalDate,
  /** When we first saw it. For SOFR this is at least one business day after `effectiveDate`. */
  publishedAt: Schema.String,
  /** Annualized, simple interest. */
  apr: Schema.Number,
  /** Where the number came from, e.g. "SOFR", "US 3M T-bill", "USDC 90d term". */
  source: Schema.String,
  /** Tenor the rate is quoted for, when it is a term rate. None means overnight / floating. */
  termDays: Schema.Option(Schema.Number),
})
export type BenchmarkRate = typeof BenchmarkRate.Type

export const BorrowState = Schema.Struct({
  venueId: VenueId,
  assetId: AssetId,
  observedAt: Schema.String,
  rate: BenchmarkRate,
})
export type BorrowState = typeof BorrowState.Type

export const BorrowQuoteDetail = Schema.Struct({
  /** Borrowed dollars per unit of capital to reach the leverage. */
  debtPerCapital: Schema.Number,
  rateSource: Schema.String,
  rateApr: Schema.Number,
  /** Business day the rate describes, so the UI can say "rate for Thu 5 Nov" rather than an age. */
  rateEffectiveDate: LocalDate,
})
export type BorrowQuoteDetail = typeof BorrowQuoteDetail.Type

/** Unlimited credit has no collateral cap; this is a sanity ceiling, not a market constraint. */
export const BENCHMARK_LEVERAGE_CAP = 1000

/** Annualized carry on capital: interest on the borrowed leg, L − 1 dollars per unit of capital. */
export const carryOnCapital = (leverage: number, apr: number): number => apr * (leverage - 1)

export const borrowModel: InstrumentModel<BorrowState, BorrowQuoteDetail> = {
  kind: 'SpotBorrow',

  quote: (state, leverage, horizonDays, conventions): LeveragedExposureQuote | Unavailable => {
    if (leverage > BENCHMARK_LEVERAGE_CAP) {
      return {
        _tag: 'LeverageNotAttainable',
        kind: 'SpotBorrow',
        requested: leverage,
        maximum: BENCHMARK_LEVERAGE_CAP,
        reason: 'Benchmark ceiling',
      }
    }
    const carry = carryOnCapital(leverage, state.rate.apr)
    const detail: BorrowQuoteDetail = {
      debtPerCapital: leverage - 1,
      rateSource: state.rate.source,
      rateApr: state.rate.apr,
      rateEffectiveDate: state.rate.effectiveDate,
    }
    return {
      kind: 'SpotBorrow',
      venueId: state.venueId,
      assetId: state.assetId,
      observedAt: state.observedAt,
      leverage,
      achievedLeverage: leverage,
      // The rate at entry is locked for the horizon by convention; it is a benchmark, not a market.
      carryKind: conventions.benchmark.lockRateForHorizon ? 'Fixed' : 'Floating',
      carryRate: leverage > 0 ? carry / leverage : 0,
      carryOnCapital: carry,
      payoffShape: 'Linear',
      ruinMode: 'None',
      ruinPriceRatio: Option.none(),
      breakevenPriceRatio: linearBreakeven(leverage, carry, horizonDays),
      capitalPerExposure: 1 / leverage,
      detail,
      conventionsVersion: conventions.version,
    }
  },

  payoff: (quote, _detail, terminal, horizonDays) =>
    Math.max(-1, linearNetPayoff(quote.achievedLeverage, quote.carryOnCapital, terminal, horizonDays)),

  carryStep: (quote, _state, stepHours) => quote.carryOnCapital * (stepHours / 8760),

  decodeDetail: quote => Schema.decodeUnknownSync(BorrowQuoteDetail)(quote.detail),

  support: () => ({
    leverage: { _tag: 'Continuous', min: 1, max: BENCHMARK_LEVERAGE_CAP, pins: [] },
    horizonDays: { _tag: 'Continuous', min: 1, max: 3650, pins: [] },
  }),
}

// Edge cases this module must handle:
// - the rate is a benchmark, so there is no "not listed": every asset gets a line
// - a term rate shorter than the horizon would need a roll; v1 locks the entry rate by convention and says so
// - negative rates (historical EUR/JPY) make carry negative; nothing here assumes apr >= 0
