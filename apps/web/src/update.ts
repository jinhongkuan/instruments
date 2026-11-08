import { Array, Option, pipe } from 'effect'
import { Command, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { type AxisSupport, type Scenario, mockComparison } from '@instruments/domain'

import { SyncChart } from './command'
import { Message } from './message'
import type { Model } from './model'
import {
  HORIZON_AXIS,
  LEVERAGE_AXIS,
  kindFromChartHostId,
  normalizeTicker,
  softSnapDown,
  softSnapNearest,
  valueFromSlider,
} from './scenario'

type UpdateReturn = Update.Return<Model, Message>

const LEVERAGE_SNAP_WINDOW = 0.04
const HORIZON_SNAP_WINDOW = 0.06

const pinsOf = (support: AxisSupport): ReadonlyArray<number> =>
  support._tag === 'Discrete'
    ? support.points.map(point => point.value)
    : support._tag === 'Continuous'
      ? [...support.pins.map(point => point.value), support.max]
      : []

const leveragePins = (model: Model): ReadonlyArray<number> =>
  model.comparison.instruments.flatMap(result => pinsOf(result.support.leverage))

const horizonPins = (model: Model): ReadonlyArray<number> =>
  model.comparison.instruments.flatMap(result =>
    result.support.horizonDays._tag === 'Continuous'
      ? result.support.horizonDays.pins.map(point => point.value)
      : pinsOf(result.support.horizonDays),
  )

const syncChart = (model: Model, hostId: string): ReadonlyArray<Command.Command<Message>> =>
  pipe(
    kindFromChartHostId(hostId),
    Option.map(kind =>
      SyncChart({ hostId, kind, mode: model.chartMode, comparison: model.comparison, separateCarry: model.separateCarry }),
    ),
    Array.fromOption,
  )

const syncAllCharts = (model: Model): ReadonlyArray<Command.Command<Message>> =>
  Array.flatMap(model.mountedChartHostIds, hostId => syncChart(model, hostId))

const withSync = (model: Model): UpdateReturn => ({ model, commands: syncAllCharts(model) })

const withScenario = (model: Model, scenario: Scenario): Model =>
  modifyFields(model, {
    scenario: () => scenario,
    comparison: () => mockComparison(scenario),
  })

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedTickerInput: ({ value }) => {
      const ticker = normalizeTicker(value)
      const next = modifyFields(model, { tickerInput: () => value })
      return ticker.length === 0 || ticker === model.scenario.ticker
        ? { model: next }
        : withSync(withScenario(next, { ...model.scenario, ticker }))
    },

    UpdatedLeverageSlider: ({ position }) => {
      const raw = valueFromSlider(LEVERAGE_AXIS, position)
      const leverage = Math.round(softSnapDown(raw, leveragePins(model), LEVERAGE_SNAP_WINDOW) * 100) / 100
      return withSync(
        withScenario(modifyFields(model, { leveragePosition: () => position }), { ...model.scenario, leverage }),
      )
    },

    UpdatedHorizonSlider: ({ position }) => {
      const raw = valueFromSlider(HORIZON_AXIS, position)
      const horizonDays = Math.round(softSnapNearest(raw, horizonPins(model), HORIZON_SNAP_WINDOW))
      return withSync(
        withScenario(modifyFields(model, { horizonPosition: () => position }), { ...model.scenario, horizonDays }),
      )
    },

    SelectedChartMode: ({ mode }) => withSync(modifyFields(model, { chartMode: () => mode })),

    ToggledSeparateCarry: () => withSync(modifyFields(model, { separateCarry: separate => !separate })),

    ToggledAxisExpanded: ({ axis }) => ({
      model: modifyFields(model, {
        expandedAxis: expanded =>
          Option.exists(expanded, current => current === axis) ? Option.none() : Option.some(axis),
      }),
    }),

    SucceededMountChart: ({ hostId }) => {
      const nextModel = modifyFields(model, {
        mountedChartHostIds: hostIds =>
          Array.contains(hostIds, hostId) ? hostIds : Array.append(hostIds, hostId),
        maybeChartError: () => Option.none(),
      })
      return { model: nextModel, commands: syncChart(nextModel, hostId) }
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
