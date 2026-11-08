import { Schema } from 'effect'

import { Comparison, Scenario } from '@instruments/domain'

import { ChartMode } from './chartMode'

export const AxisId = Schema.Literals(['leverage', 'horizon'])
export type AxisId = typeof AxisId.Type

export const Model = Schema.Struct({
  tickerInput: Schema.String,
  scenario: Scenario,
  comparison: Comparison,
  chartMode: ChartMode,
  /** Payoff chart: draw the pure price leg as a separate line so carry is visible as the gap. */
  separateCarry: Schema.Boolean,
  /** Raw slider positions in [0, 1]. Kept separate from the resolved scenario so the thumb never jumps under the pointer. */
  leveragePosition: Schema.Number,
  horizonPosition: Schema.Number,
  /** Which axis shows its per-instrument bands. At most one is expanded; the rest show the collapsed strip. */
  expandedAxis: Schema.Option(AxisId),
  mountedChartHostIds: Schema.Array(Schema.String),
  maybeChartError: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type
