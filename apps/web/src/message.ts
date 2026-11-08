import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import { ChartMode } from './chartMode'

export const Message = defineMessageUnion({
  UpdatedTickerInput: { value: Schema.String },
  UpdatedLeverageSlider: { position: Schema.Number },
  UpdatedHorizonSlider: { position: Schema.Number },
  SelectedChartMode: { mode: ChartMode },
  ToggledSeparateCarry: {},
  SucceededMountChart: { hostId: Schema.String },
  FailedMountChart: { reason: Schema.String },
  SucceededSyncChart: {},
  FailedSyncChart: { reason: Schema.String },
})
export type Message = typeof Message.Type
