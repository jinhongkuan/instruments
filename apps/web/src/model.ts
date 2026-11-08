import { Schema } from 'effect'

import { Comparison, Scenario } from '@instruments/domain'

import { ChartMode } from './chartMode'

export const Model = Schema.Struct({
  tickerInput: Schema.String,
  scenario: Scenario,
  comparison: Comparison,
  chartMode: ChartMode,
  /** Raw slider positions in [0, 1]. Kept separate from the resolved scenario so the thumb never jumps under the pointer. */
  leveragePosition: Schema.Number,
  horizonPosition: Schema.Number,
  mountedChartHostIds: Schema.Array(Schema.String),
  maybeChartError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
