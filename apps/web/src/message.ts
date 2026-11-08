import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import { ChartMode } from './chartMode'

export const Message = defineMessageUnion({
  UpdatedTickerInput: { value: Schema.String },
  UpdatedCapitalInput: { value: Schema.String },
  UpdatedHorizonInput: { value: Schema.String },
  SubmittedScenario: {},
  UpdatedLeverageSlider: { position: Schema.Number },
  SelectedChartMode: { mode: ChartMode },
  SucceededMountChart: { hostId: Schema.String },
  FailedMountChart: { reason: Schema.String },
  SucceededSyncChart: {},
  FailedSyncChart: { reason: Schema.String },
})
export type Message = typeof Message.Type
