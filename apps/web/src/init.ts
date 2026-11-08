import { Option } from 'effect'
import { Runtime } from 'foldkit'

import { mockComparison } from '@instruments/domain'

import type { Message } from './message'
import { Model } from './model'
import { DEFAULT_SCENARIO } from './scenario'

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    tickerInput: DEFAULT_SCENARIO.ticker,
    capitalInput: String(DEFAULT_SCENARIO.capitalUsd),
    horizonInput: String(DEFAULT_SCENARIO.horizonDays),
    scenario: DEFAULT_SCENARIO,
    comparison: mockComparison(DEFAULT_SCENARIO),
    chartMode: 'Carry',
    mountedChartHostIds: [],
    maybeChartError: Option.none(),
  },
})
