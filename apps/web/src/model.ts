import { Schema } from 'effect'

import { Comparison, Scenario } from '@instruments/domain'

import { ChartMode } from './chartMode'

export const Model = Schema.Struct({
  tickerInput: Schema.String,
  capitalInput: Schema.String,
  horizonInput: Schema.String,
  scenario: Scenario,
  comparison: Comparison,
  chartMode: ChartMode,
  mountedChartHostIds: Schema.Array(Schema.String),
  maybeChartError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
