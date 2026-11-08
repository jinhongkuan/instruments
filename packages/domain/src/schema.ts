import { Schema } from 'effect'

import { InstrumentKind } from './instrument/common'

/** The three ways to hold leveraged long exposure. Rows of the README table. */
export const INSTRUMENT_KINDS: ReadonlyArray<InstrumentKind> = ['Perp', 'SpotBorrow', 'Option']

/** Fix the question: long X, capital C, horizon H, entered on D. */
export const Scenario = Schema.Struct({
  ticker: Schema.String,
  capitalUsd: Schema.Number,
  horizonDays: Schema.Number,
  entryDate: Schema.String,
})
export type Scenario = typeof Scenario.Type

export const SeriesPoint = Schema.Struct({
  day: Schema.Number,
  value: Schema.Number,
})
export type SeriesPoint = typeof SeriesPoint.Type

export const PayoffPoint = Schema.Struct({
  terminalPriceRatio: Schema.Number,
  pnlPctOfCapital: Schema.Number,
})
export type PayoffPoint = typeof PayoffPoint.Type

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
  exposureMultiple: Schema.Number,
  carryPctOfCapital: Schema.Array(SeriesPoint),
  payoffAtHorizon: Schema.Array(PayoffPoint),
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
