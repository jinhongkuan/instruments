import { Option } from 'effect'
import { Runtime } from 'foldkit'

import { mockComparison } from '@instruments/domain'

import type { Message } from './message'
import { Model } from './model'
import { DEFAULT_SCENARIO, HORIZON_AXIS, LEVERAGE_AXIS, sliderFromValue } from './scenario'

export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    tickerInput: DEFAULT_SCENARIO.ticker,
    scenario: DEFAULT_SCENARIO,
    comparison: mockComparison(DEFAULT_SCENARIO),
    chartMode: 'Payoff',
    separateCarry: false,
    leveragePosition: sliderFromValue(LEVERAGE_AXIS, DEFAULT_SCENARIO.leverage),
    horizonPosition: sliderFromValue(HORIZON_AXIS, DEFAULT_SCENARIO.horizonDays),
    expandedAxis: Option.none(),
    mountedChartHostIds: [],
    maybeChartError: Option.none(),
  },
})
