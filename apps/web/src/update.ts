import { Array, Option, pipe } from 'effect'
import { Command, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { mockComparison } from '@instruments/domain'

import { SyncChart } from './command'
import { Message } from './message'
import type { Model } from './model'
import { kindFromChartHostId, scenarioFromInputs } from './scenario'

type UpdateReturn = Update.Return<Model, Message>

const syncChart = (model: Model, hostId: string): ReadonlyArray<Command.Command<Message>> =>
  pipe(
    kindFromChartHostId(hostId),
    Option.map(kind =>
      SyncChart({ hostId, kind, mode: model.chartMode, comparison: model.comparison }),
    ),
    Array.fromOption,
  )

const syncAllCharts = (model: Model): ReadonlyArray<Command.Command<Message>> =>
  Array.flatMap(model.mountedChartHostIds, hostId => syncChart(model, hostId))

const withSync = (model: Model): UpdateReturn => ({ model, commands: syncAllCharts(model) })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedTickerInput: ({ value }) => ({
      model: modifyFields(model, { tickerInput: () => value }),
    }),

    UpdatedCapitalInput: ({ value }) => ({
      model: modifyFields(model, { capitalInput: () => value }),
    }),

    UpdatedHorizonInput: ({ value }) => ({
      model: modifyFields(model, { horizonInput: () => value }),
    }),

    SubmittedScenario: () => {
      const scenario = scenarioFromInputs({
        tickerInput: model.tickerInput,
        capitalInput: model.capitalInput,
        horizonInput: model.horizonInput,
        entryDate: model.scenario.entryDate,
      })
      return withSync(
        modifyFields(model, {
          tickerInput: () => scenario.ticker,
          capitalInput: () => String(scenario.capitalUsd),
          horizonInput: () => String(scenario.horizonDays),
          scenario: () => scenario,
          comparison: () => mockComparison(scenario),
        }),
      )
    },

    SelectedChartMode: ({ mode }) => withSync(modifyFields(model, { chartMode: () => mode })),

    SucceededMountChart: ({ hostId }) => {
      const nextModel = modifyFields(model, {
        mountedChartHostIds: hostIds =>
          Array.contains(hostIds, hostId) ? hostIds : Array.append(hostIds, hostId),
        maybeChartError: () => Option.none(),
      })
      return {
        model: nextModel,
        commands: syncChart(nextModel, hostId),
      }
    },

    FailedMountChart: ({ reason }) => ({
      model: modifyFields(model, { maybeChartError: () => Option.some(reason) }),
    }),

    SucceededSyncChart: () => ({
      model: modifyFields(model, { maybeChartError: () => Option.none() }),
    }),

    FailedSyncChart: ({ reason }) => ({
      model: modifyFields(model, { maybeChartError: () => Option.some(reason) }),
    }),
  })
