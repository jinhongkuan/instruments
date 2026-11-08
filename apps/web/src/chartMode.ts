import { Schema } from 'effect'

export const ChartMode = Schema.Literals(['Carry', 'Payoff', 'Path', 'Ruin'])
export type ChartMode = typeof ChartMode.Type

export const CHART_MODES: ReadonlyArray<ChartMode> = ['Payoff', 'Ruin', 'Carry', 'Path']

export const chartModeLabel = (mode: ChartMode): string =>
  mode === 'Carry'
    ? 'Cumulative carry'
    : mode === 'Payoff'
      ? 'Payoff at horizon'
      : mode === 'Ruin'
        ? 'Chance of losing it all'
        : 'Path risk'

export const chartModeDescription = (mode: ChartMode): string =>
  mode === 'Carry'
    ? 'What holding the position cost over time, as a percent of capital.'
    : mode === 'Payoff'
      ? 'PnL at the end of the holding period against the price it ends at. The dotted line is the benchmark: spot bought with unlimited credit at the dollar rate. Carry shifts each curve down; where it floats, the shift is a band.'
      : mode === 'Ruin'
        ? 'Probability of losing the whole position by each holding period, at the chosen leverage. Perp: price touches the liquidation level at any point. Option: the final contract expires worthless. Benchmark: nothing can force it out.'
        : 'Equity along the realized path, with the day the position would have died.'
