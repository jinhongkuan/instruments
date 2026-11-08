import { Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'

import { Comparison } from '@instruments/domain'

import { getChart } from './chartHost'
import { ChartMode } from './chartMode'
import { makeChartOption } from './echarts'
import { Message } from './message'

export const SyncChart = Command.define('SyncChart', {
  args: {
    hostId: Schema.String,
    mode: ChartMode,
    comparison: Comparison,
    separateCarry: Schema.Boolean,
    horizonDays: Schema.Number,
  },
  messages: [Message.SucceededSyncChart, Message.FailedSyncChart],
  execute: args =>
    Option.match(getChart(args.hostId), {
      onNone: () =>
        Effect.succeed(
          Message.FailedSyncChart({ reason: `No live chart for host ${args.hostId}.` }),
        ),
      onSome: chart =>
        Effect.try(() => chart.setOption(makeChartOption(args), true)).pipe(
          Effect.as(Message.SucceededSyncChart()),
          Effect.catch(error =>
            Effect.succeed(
              Message.FailedSyncChart({
                reason: error instanceof Error ? error.message : `${error}`,
              }),
            ),
          ),
        ),
    }),
})
