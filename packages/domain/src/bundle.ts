import { Schema } from 'effect'

import { LocalDate } from './instrument/calendar'

// ---------------------------------------------------------------------------
// The per-ticker bundle: everything the dashboard needs for one ticker, as
// precomputed by the hourly derive job and served as a static file. The
// browser runs the instrument models on it, so a slider move never touches
// the network. Optional values are null (not Option) so the JSON stays plain.
// ---------------------------------------------------------------------------

export const BUNDLE_VERSION = 1

/** Days of history kept for every time series. Bounds what horizons the data can support. */
export const RETENTION_DAYS = 90

/** Funding windows and ruin curves are computed at these holding periods (days). */
export const HORIZON_BUCKET_DAYS: ReadonlyArray<number> = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60]

/** A horizon is offered only if this many non-overlapping windows fit in the history. */
export const MIN_INDEPENDENT_WINDOWS = 3

/** Ruin curves are computed at these leverages (capped by the venue's maximum) and interpolated between. */
export const LEVERAGE_BUCKETS: ReadonlyArray<number> = [1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50]

/** Option ATM history is kept at these fixed tenors (days). */
export const ATM_TENOR_DAYS: ReadonlyArray<number> = [7, 14, 30, 60, 90, 180]

const Quantiles = {
  p10: Schema.Number,
  p50: Schema.Number,
  p90: Schema.Number,
}

/**
 * Realized funding over every window of `horizonDays` in the history, as a
 * fraction of notional paid by a long (0.004 = 0.4% of notional). Windows
 * that span a gap in the data are excluded, never interpolated.
 */
export const FundingWindow = Schema.Struct({
  horizonDays: Schema.Number,
  /** Overlapping hourly-start windows that fit in the history. */
  windows: Schema.Number,
  /** Non-overlapping windows that fit; what the band really rests on. */
  independent: Schema.Number,
  ...Quantiles,
})
export type FundingWindow = typeof FundingWindow.Type

/** Fraction of historical start hours from which a long at `leverage` was liquidated within each horizon. */
export const RuinCurve = Schema.Struct({
  leverage: Schema.Number,
  byHorizon: Schema.Array(
    Schema.Struct({
      days: Schema.Number,
      probability: Schema.Number,
      /** Start hours with a full window of data behind them. */
      starts: Schema.Number,
    }),
  ),
})
export type RuinCurve = typeof RuinCurve.Type

export const PerpBlock = Schema.Struct({
  venue: Schema.Literal('Hyperliquid'),
  venueSymbol: Schema.String,
  maxLeverage: Schema.Number,
  /** Hyperliquid maintenance margin is half the initial margin at max leverage. */
  maintenanceMarginFraction: Schema.Number,
  /** Latest hourly funding rate (fraction of notional per hour). */
  fundingRateHourly: Schema.Number,
  /** False while the latest hour is the venue's current estimate, before settlement. */
  latestFundingSettled: Schema.Boolean,
  markPrice: Schema.Number,
  /** USD notional traded on the venue in the last 24 hours. Null when the venue did not report it. */
  dayNotionalVolumeUsd: Schema.NullOr(Schema.Number),
  openInterestUsd: Schema.NullOr(Schema.Number),
  /** Hours of funding history behind the windows. */
  historyHours: Schema.Number,
  /** Longest horizon (days) with at least MIN_INDEPENDENT_WINDOWS behind it. */
  maxHorizonDays: Schema.Number,
  fundingWindows: Schema.Array(FundingWindow),
  ruinCurves: Schema.Array(RuinCurve),
  /** Annualized volatility of hourly log returns over the history. */
  realizedVol: Schema.NullOr(Schema.Number),
})
export type PerpBlock = typeof PerpBlock.Type

export const ChainCall = Schema.Struct({
  instrumentName: Schema.String,
  expiry: Schema.String,
  strike: Schema.Number,
  /** Mark premium in USD per unit of underlying. */
  premiumUsd: Schema.Number,
  bidUsd: Schema.NullOr(Schema.Number),
  askUsd: Schema.NullOr(Schema.Number),
  /** Annualized implied volatility (fraction). */
  iv: Schema.Number,
  /** Black-76 delta from mark IV. */
  delta: Schema.Number,
  /** Forward for this expiry. */
  underlyingPrice: Schema.Number,
})
export type ChainCall = typeof ChainCall.Type

export const AtmTenor = Schema.Struct({
  tenorDays: Schema.Number,
  iv: Schema.Number,
  premiumFraction: Schema.Number,
  /** Distribution of this tenor's ATM implied vol over the retained history. */
  ivHistory: Schema.Struct({ samples: Schema.Number, ...Quantiles }),
})
export type AtmTenor = typeof AtmTenor.Type

export const OptionBlock = Schema.Struct({
  venue: Schema.Literal('Deribit'),
  /** Deribit currency or USDC-linear prefix the chain came from, e.g. "BTC" or "SOL_USDC". */
  chain: Schema.String,
  observedAt: Schema.String,
  calls: Schema.Array(ChainCall),
  atmByTenor: Schema.Array(AtmTenor),
})
export type OptionBlock = typeof OptionBlock.Type

export const BenchmarkBlock = Schema.Struct({
  source: Schema.String,
  /** Annualized, simple (0.0392 = 3.92%). */
  apr: Schema.Number,
  effectiveDate: LocalDate,
  publishedAt: Schema.String,
})
export type BenchmarkBlock = typeof BenchmarkBlock.Type

/** When each source last delivered data that this bundle used. */
export const SourceFreshness = Schema.Struct({
  source: Schema.String,
  asOf: Schema.String,
})
export type SourceFreshness = typeof SourceFreshness.Type

export const TickerBundle = Schema.Struct({
  version: Schema.Literal(BUNDLE_VERSION),
  ticker: Schema.String,
  generatedAt: Schema.String,
  conventionsVersion: Schema.String,
  perp: Schema.NullOr(PerpBlock),
  option: Schema.NullOr(OptionBlock),
  benchmark: Schema.NullOr(BenchmarkBlock),
  sources: Schema.Array(SourceFreshness),
})
export type TickerBundle = typeof TickerBundle.Type

/**
 * Written last, after every bundle of the hour, so it only ever points at a
 * complete set. Short-cached; the bundles it points at are immutable.
 */
export const Manifest = Schema.Struct({
  version: Schema.Literal(BUNDLE_VERSION),
  generatedAt: Schema.String,
  /** Key prefix of this hour's bundles, e.g. "v/2026-11-08T05". Bundle key: `${prefix}/t/${ticker}.json`. */
  prefix: Schema.String,
  /** Tickers with a bundle in this version. */
  tickers: Schema.Array(Schema.String),
})
export type Manifest = typeof Manifest.Type

export const bundleKey = (prefix: string, ticker: string): string => `${prefix}/t/${ticker.toUpperCase()}.json`

export const MANIFEST_KEY = 'manifest.json'
