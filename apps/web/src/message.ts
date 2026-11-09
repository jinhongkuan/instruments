import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import { Manifest, TickerBundle } from '@instruments/domain'

import { ChartMode } from './chartMode'
import { AxisId } from './model'

export const Message = defineMessageUnion({
  UpdatedTickerInput: { value: Schema.String },
  UpdatedLeverageSlider: { position: Schema.Number },
  UpdatedHorizonSlider: { position: Schema.Number },
  SelectedChartMode: { mode: ChartMode },
  ToggledSeparateCarry: {},
  ToggledAxisExpanded: { axis: AxisId },
  SucceededMountChart: { hostId: Schema.String },
  FailedMountChart: { reason: Schema.String },
  SucceededSyncChart: {},
  FailedSyncChart: { reason: Schema.String },
  SucceededFetchManifest: { manifest: Manifest },
  FailedFetchManifest: { reason: Schema.String },
  SucceededFetchBundle: { bundle: TickerBundle },
  FailedFetchBundle: { ticker: Schema.String, reason: Schema.String },
  ClickedRetryMarketData: {},
})
export type Message = typeof Message.Type
