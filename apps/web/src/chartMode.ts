import { Schema } from 'effect'

export const ChartMode = Schema.Literals(['Carry', 'Payoff', 'Path'])
export type ChartMode = typeof ChartMode.Type

export const CHART_MODES: ReadonlyArray<ChartMode> = ['Carry', 'Payoff', 'Path']

export const chartModeLabel = (mode: ChartMode): string =>
  mode === 'Carry' ? 'Cumulative carry' : mode === 'Payoff' ? 'Payoff at horizon' : 'Path risk'

export const chartModeDescription = (mode: ChartMode): string =>
  mode === 'Carry'
    ? 'What holding the position cost over time, as a percent of capital.'
    : mode === 'Payoff'
      ? 'Profit or loss at the horizon against the terminal price, net of carry.'
      : 'Equity along the realized path, with the day the position would have died.'
