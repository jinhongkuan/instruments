import { Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'

import { Comparison, InstrumentKind } from '@instruments/domain'

import { getChart } from './chartHost'
import { ChartMode } from './chartMode'
import { makeChartOption } from './echarts'
import { Message } from './message'

export const SyncChart = Command.define('SyncChart', {
  args: {
    hostId: Schema.String,
    kind: InstrumentKind,
    mode: ChartMode,
    comparison: Comparison,
    separateCarry: Schema.Boolean,
  },
  messages: [Message.SucceededSyncChart, Message.FailedSyncChart],
  execute: args =>
    Option.match(getChart(args.hostId), {
      onNone: () =>
        Effect.succeed(
          Message.FailedSyncChart({ reason: `No live chart for host ${args.hostId}.` }),
        ),
      onSome: chart =>
        Option.match(makeChartOption(args), {
          onNone: () =>
            Effect.succeed(
              Message.FailedSyncChart({ reason: `No result for instrument ${args.kind}.` }),
            ),
          onSome: option =>
            Effect.try(() => chart.setOption(option, true)).pipe(
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
    }),
})
