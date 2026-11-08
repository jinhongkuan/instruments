import { Schema } from 'effect'

import { CarryKind, InstrumentKind, InstrumentSupport, Resolved } from './instrument/common'

/** The three ways to hold leveraged long exposure. Rows of the README table. */
export const INSTRUMENT_KINDS: ReadonlyArray<InstrumentKind> = ['Perp', 'SpotBorrow', 'Option']

/** Fix the question: long X, capital C, horizon H, entered on D. */
export const Scenario = Schema.Struct({
  ticker: Schema.String,
  capitalUsd: Schema.Number,
  horizonDays: Schema.Number,
  entryDate: Schema.String,
  /** Requested exposure / capital. Each instrument resolves it against its own support. */
  leverage: Schema.Number,
})
export type Scenario = typeof Scenario.Type

export const SeriesPoint = Schema.Struct({
  day: Schema.Number,
  value: Schema.Number,
})
export type SeriesPoint = typeof SeriesPoint.Type

/**
 * PnL per unit of capital at the horizon for one terminal price ratio. Carry
 * shifts the curve vertically; when carry is floating, the shift is uncertain,
 * so low/high bound a band and mid is the median. Fixed and prepaid carry
 * collapse the band to the line (low = mid = high).
 */
export const PayoffPoint = Schema.Struct({
  terminalPriceRatio: Schema.Number,
  /** PnL before any carry: the pure price leg. */
  beforeCarry: Schema.Number,
  low: Schema.Number,
  mid: Schema.Number,
  high: Schema.Number,
})
export type PayoffPoint = typeof PayoffPoint.Type

/** Carry over the horizon as a percent of capital, with the uncertainty the instrument carries at entry. */
export const CarryBand = Schema.Struct({
  kind: CarryKind,
  low: Schema.Number,
  mid: Schema.Number,
  high: Schema.Number,
  /** Where the band came from, for the footnote: e.g. "p10–p90 of 90-day funding windows (synthetic)". */
  basis: Schema.String,
})
export type CarryBand = typeof CarryBand.Type

export const PathEvent = Schema.Struct({
  day: Schema.Number,
  kind: Schema.Literals(['Liquidation', 'MarginCall', 'Expiry']),
  detail: Schema.String,
})
export type PathEvent = typeof PathEvent.Type

export const InstrumentResult = Schema.Struct({
  kind: InstrumentKind,
  label: Schema.String,
  venue: Schema.String,
  /** What this instrument can deliver for the asset on each axis; drives the slider bands. */
  support: InstrumentSupport,
  /** How the requested leverage resolved: exact, snapped down, or unattainable (card greys out, fallback shown). */
  resolved: Resolved,
  /** How the requested horizon resolved. */
  horizonResolved: Resolved,
  /** Leverage the series were computed at: the resolved value, or the fallback when unattainable. 0 if none. */
  exposureMultiple: Schema.Number,
  carryBand: CarryBand,
  /** Price ratio below which the position is lost if touched at any point on the path. None for options. */
  ruinPriceRatio: Schema.Option(Schema.Number),
  carryPctOfCapital: Schema.Array(SeriesPoint),
  payoffAtHorizon: Schema.Array(PayoffPoint),
  /**
   * Probability (0–1) of losing the whole position by each holding period, at
   * the resolved leverage. Perp: path touches the liquidation ratio. Option:
   * the final contract expires out of the money. Benchmark: zero, nothing can
   * force it out. `day` is the holding period in days.
   */
  ruinProbabilityByHorizon: Schema.Array(SeriesPoint),
  equityPctOfCapital: Schema.Array(SeriesPoint),
  pathEvents: Schema.Array(PathEvent),
  summary: Schema.Struct({
    totalCarryPct: Schema.Number,
    terminalPnlPct: Schema.Number,
    maxDrawdownPct: Schema.Number,
    liquidated: Schema.Boolean,
  }),
})
export type InstrumentResult = typeof InstrumentResult.Type

export const Comparison = Schema.Struct({
  scenario: Scenario,
  priceRatio: Schema.Array(SeriesPoint),
  instruments: Schema.Array(InstrumentResult),
  synthetic: Schema.Boolean,
})
export type Comparison = typeof Comparison.Type
