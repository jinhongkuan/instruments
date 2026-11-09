import { Option } from 'effect'
import { Runtime } from 'foldkit'

import { FetchManifest } from './command'
import { DataSource } from './data'
import type { Message } from './message'
import { Model } from './model'
import { DEFAULT_SCENARIO, HORIZON_AXIS, LEVERAGE_AXIS, sliderFromValue } from './scenario'

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    tickerInput: DEFAULT_SCENARIO.ticker,
    scenario: DEFAULT_SCENARIO,
    maybeComparison: Option.none(),
    dataSource: DataSource.LoadingMarketData(),
    maybeManifest: Option.none(),
    chartMode: 'Payoff',
    separateCarry: false,
    leveragePosition: sliderFromValue(LEVERAGE_AXIS, DEFAULT_SCENARIO.leverage),
    horizonPosition: sliderFromValue(HORIZON_AXIS, DEFAULT_SCENARIO.horizonDays),
    expandedAxis: Option.none(),
    mountedChartHostIds: [],
    maybeChartError: Option.none(),
  },
  commands: [FetchManifest()],
})
