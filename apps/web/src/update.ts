import { Array, Option } from 'effect'
import { Command, Update } from 'foldkit'
import { modifyFields } from 'foldkit/struct'

import { type AxisSupport, type Comparison, type Manifest, type Scenario, comparisonFromBundle } from '@instruments/domain'

import { FetchBundle, FetchManifest, SyncChart } from './command'
import { DataSource } from './data'
import { Message } from './message'
import type { Model } from './model'
import {
  HORIZON_AXIS,
  LEVERAGE_AXIS,
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

const instrumentsOf = (model: Model) =>
  Option.match(model.maybeComparison, { onNone: () => [], onSome: comparison => comparison.instruments })

const leveragePins = (model: Model): ReadonlyArray<number> =>
  instrumentsOf(model).flatMap(result => pinsOf(result.support.leverage))

const horizonPins = (model: Model): ReadonlyArray<number> =>
  instrumentsOf(model).flatMap(result =>
    result.support.horizonDays._tag === 'Continuous'
      ? result.support.horizonDays.pins.map(point => point.value)
      : pinsOf(result.support.horizonDays),
  )

const syncChart = (model: Model, hostId: string): ReadonlyArray<Command.Command<Message>> =>
  Option.match(model.maybeComparison, {
    onNone: () => [],
    onSome: comparison => [
      SyncChart({
        hostId,
        mode: model.chartMode,
        comparison,
        separateCarry: model.separateCarry,
        horizonDays: model.scenario.horizonDays,
      }),
    ],
  })

const syncAllCharts = (model: Model): ReadonlyArray<Command.Command<Message>> =>
  Array.flatMap(model.mountedChartHostIds, hostId => syncChart(model, hostId))

const withSync = (model: Model): UpdateReturn => ({ model, commands: syncAllCharts(model) })

const comparisonFor = (dataSource: DataSource, scenario: Scenario): Option.Option<Comparison> =>
  dataSource._tag === 'Live' && dataSource.bundle.ticker === scenario.ticker
    ? Option.some(comparisonFromBundle(dataSource.bundle, scenario))
    : Option.none()

const withScenario = (model: Model, scenario: Scenario): Model => {
  const maybeComparison = comparisonFor(model.dataSource, scenario)
  return modifyFields(model, {
    scenario: () => scenario,
    maybeComparison: () => maybeComparison,
    // Without data the chart panel is not rendered, so its host unmounts; it re-registers on remount.
    mountedChartHostIds: hostIds => (Option.isNone(maybeComparison) ? [] : hostIds),
  })
}

const withDataSource = (model: Model, dataSource: DataSource): Model =>
  withScenario(modifyFields(model, { dataSource: () => dataSource }), model.scenario)

const noMarketData = (ticker: string): DataSource =>
  DataSource.Unavailable({ reason: `${ticker} is not listed on Hyperliquid or Deribit, so there is nothing to price.`, retryable: false })

/** Point the model at a ticker: fetch its bundle when the manifest lists it, otherwise say why it is synthetic. */
const loadTicker = (model: Model, manifest: Manifest, ticker: string): UpdateReturn =>
  Array.contains(manifest.tickers, ticker)
    ? {
        model: withDataSource(model, DataSource.LoadingMarketData()),
        commands: [...syncAllCharts(model), FetchBundle({ prefix: manifest.prefix, ticker })],
      }
    : withSync(withDataSource(model, noMarketData(ticker)))

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedTickerInput: ({ value }) => {
      const ticker = normalizeTicker(value)
      const next = modifyFields(model, { tickerInput: () => value })
      if (ticker.length === 0 || ticker === model.scenario.ticker) {
        return { model: next }
      }
      const retargeted = withScenario(next, { ...model.scenario, ticker })
      return Option.match(model.maybeManifest, {
        onNone: () => withSync(retargeted),
        onSome: manifest => loadTicker(retargeted, manifest, ticker),
      })
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

    SucceededFetchManifest: ({ manifest }) =>
      loadTicker(modifyFields(model, { maybeManifest: () => Option.some(manifest) }), manifest, model.scenario.ticker),

    FailedFetchManifest: ({ reason }) =>
      withSync(withDataSource(model, DataSource.Unavailable({ reason: `Market data could not be loaded (${reason}).`, retryable: true }))),

    SucceededFetchBundle: ({ bundle }) =>
      bundle.ticker !== model.scenario.ticker
        ? { model }
        : Option.match(model.maybeManifest, {
            onNone: () => ({ model }),
            onSome: manifest => withSync(withDataSource(model, DataSource.Live({ manifest, bundle }))),
          }),

    FailedFetchBundle: ({ ticker, reason }) =>
      ticker !== model.scenario.ticker
        ? { model }
        : withSync(withDataSource(model, DataSource.Unavailable({ reason: `${ticker} could not be loaded (${reason}).`, retryable: true }))),

    ClickedRetryMarketData: () => ({
      model: withDataSource(model, DataSource.LoadingMarketData()),
      commands: [FetchManifest()],
    }),
  })
