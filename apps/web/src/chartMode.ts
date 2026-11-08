import { Schema } from 'effect'

export const ChartMode = Schema.Literals(['Payoff', 'Ruin'])
export type ChartMode = typeof ChartMode.Type

export const CHART_MODES: ReadonlyArray<ChartMode> = ['Payoff', 'Ruin']

export const chartModeLabel = (mode: ChartMode): string =>
  mode === 'Payoff' ? 'Payoff at horizon' : 'Chance of losing it all'

export const chartModeDescription = (mode: ChartMode): string =>
  mode === 'Payoff'
    ? 'PnL at the end of the holding period against the price it ends at. The dotted line is the benchmark: spot bought with unlimited credit at the dollar rate. Carry shifts each curve down; where it floats, the shift is a band.'
    : 'Probability of losing the whole position by each holding period, at the chosen leverage. Perp: price touches the liquidation level at any point. Option: the final contract expires worthless. Benchmark: nothing can force it out.'
