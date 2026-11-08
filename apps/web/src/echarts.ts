import { LineChart } from 'echarts/charts'
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components'
import * as echarts from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import type { EChartsOption } from 'echarts/types/dist/shared'
import { Array, Match, Option } from 'effect'

import type { Comparison, InstrumentKind, InstrumentResult } from '@instruments/domain'

import type { ChartMode } from './chartMode'

export const registerEcharts = () => {
  echarts.use([
    AriaComponent,
    CanvasRenderer,
    GridComponent,
    LegendComponent,
    LineChart,
    MarkAreaComponent,
    MarkLineComponent,
    TooltipComponent,
  ])
  return echarts
}

export const instrumentColor = (kind: InstrumentKind): string =>
  Match.value(kind).pipe(
    Match.when('Perp', () => '#e5484d'),
    Match.when('SpotBorrow', () => '#30a46c'),
    Match.when('Option', () => '#3e7bfa'),
    Match.exhaustive,
  )

const PRICE_COLOR = '#a1a1aa'
const GRID_COLOR = 'rgba(161, 161, 170, 0.25)'

const baseOption = (): EChartsOption => ({
  animation: false,
  backgroundColor: 'transparent',
  tooltip: { trigger: 'axis', confine: true, valueFormatter: value => `${value}%` },
  legend: { bottom: 0, left: 'center', itemWidth: 16, itemHeight: 8, textStyle: { color: '#71717a', fontSize: 11 } },
  grid: { left: 56, right: 24, top: 28, bottom: 64 },
  aria: { enabled: true },
})

const percentAxis = (name: string) => ({
  type: 'value' as const,
  name,
  nameTextStyle: { color: '#71717a', fontSize: 11 },
  axisLabel: { formatter: '{value}%', color: '#71717a' },
  splitLine: { lineStyle: { color: GRID_COLOR } },
})

const round = (value: number): number => Math.round(value * 100) / 100
const ratioLabel = (ratio: number): string => `${round(ratio)}x`

/** The benchmark is a reference, so it is always dotted. Unattainable instruments drawn at their fallback are faded. */
const seriesName = (result: InstrumentResult): string =>
  result.resolved._tag === 'Unattainable'
    ? `${result.label} (${result.exposureMultiple.toFixed(2)}x fallback)`
    : result.label

const lineStyleFor = (result: InstrumentResult) => ({
  width: result.kind === 'SpotBorrow' ? 2 : 2.5,
  color: instrumentColor(result.kind),
  type: result.kind === 'SpotBorrow' ? ('dotted' as const) : ('solid' as const),
  opacity: result.resolved._tag === 'Unattainable' ? 0.45 : 1,
})

const live = (comparison: Comparison): ReadonlyArray<InstrumentResult> =>
  comparison.instruments.filter(result => result.exposureMultiple > 0)

// ---------------------------------------------------------------------------
// Payoff at horizon: one chart, x = terminal / entry price, y = PnL % of capital.
// ---------------------------------------------------------------------------

const payoffOption = (comparison: Comparison, separateCarry: boolean): EChartsOption => {
  const results = live(comparison)
  const grid = results[0]?.payoffAtHorizon ?? []
  const labels = Array.map(grid, point => ratioLabel(point.terminalPriceRatio))
  const firstLabel = labels[0] ?? '0.5x'
  const nearestLabel = (ratio: number): string =>
    ratioLabel(
      Array.map(grid, point => point.terminalPriceRatio).reduce(
        (best, r) => (Math.abs(r - ratio) < Math.abs(best - ratio) ? r : best),
        grid[0]?.terminalPriceRatio ?? 1,
      ),
    )

  const bands = results.flatMap(result =>
    result.carryBand.high - result.carryBand.low > 1e-9
      ? [
          {
            name: `${seriesName(result)} band`,
            type: 'line' as const,
            stack: `band-${result.kind}`,
            showSymbol: false,
            silent: true,
            lineStyle: { opacity: 0 },
            itemStyle: { color: instrumentColor(result.kind) },
            tooltip: { show: false },
            data: Array.map(result.payoffAtHorizon, point => round(point.low)),
          },
          {
            name: `${seriesName(result)} carry band`,
            type: 'line' as const,
            stack: `band-${result.kind}`,
            showSymbol: false,
            silent: true,
            lineStyle: { opacity: 0 },
            itemStyle: { color: instrumentColor(result.kind) },
            areaStyle: { color: instrumentColor(result.kind), opacity: result.resolved._tag === 'Unattainable' ? 0.07 : 0.14 },
            tooltip: { show: false },
            data: Array.map(result.payoffAtHorizon, point => round(point.high - point.low)),
          },
        ]
      : [],
  )

  const beforeCarry = separateCarry
    ? results
        .filter(result => result.kind !== 'SpotBorrow')
        .map(result => ({
          name: `${seriesName(result)} before carry`,
          type: 'line' as const,
          showSymbol: false,
          lineStyle: { width: 1.25, color: instrumentColor(result.kind), type: 'dashed' as const, opacity: 0.7 },
          itemStyle: { color: instrumentColor(result.kind) },
          data: Array.map(result.payoffAtHorizon, point => round(point.beforeCarry)),
        }))
    : []

  const ruinLines = results.flatMap(result =>
    Option.match(result.ruinPriceRatio, {
      onNone: () => [],
      onSome: ratio => [
        {
          xAxis: nearestLabel(ratio),
          name: `${result.label} liquidation`,
          lineStyle: { color: instrumentColor(result.kind), width: 1.25, type: 'dashed' as const },
          label: { formatter: 'liquidation', color: instrumentColor(result.kind), fontSize: 10, position: 'insideEndTop' as const },
        },
      ],
    }),
  )
  const ruinAreas = results.flatMap(result =>
    Option.match(result.ruinPriceRatio, {
      onNone: () => [],
      onSome: ratio => [[{ xAxis: firstLabel }, { xAxis: nearestLabel(ratio) }] as [{ xAxis: string }, { xAxis: string }]],
    }),
  )

  const lines = results.map((result, index) => ({
    name: seriesName(result),
    type: 'line' as const,
    showSymbol: false,
    lineStyle: lineStyleFor(result),
    itemStyle: { color: instrumentColor(result.kind) },
    data: Array.map(result.payoffAtHorizon, point => round(point.mid)),
    ...(index === 0
      ? {
          markLine: {
            symbol: 'none',
            silent: true,
            lineStyle: { color: PRICE_COLOR, type: 'dashed' as const },
            label: { color: '#71717a', fontSize: 10 },
            data: [{ yAxis: 0, name: 'breakeven' }, { xAxis: '1x', name: 'entry' }, ...ruinLines] as never,
          },
          markArea: { silent: true, itemStyle: { color: '#e5484d', opacity: 0.05 }, data: [...ruinAreas] },
        }
      : {}),
  }))

  return {
    ...baseOption(),
    legend: { ...baseOption().legend, data: [...results.map(seriesName), ...beforeCarry.map(series => series.name)] },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      name: 'price at end / price at entry',
      nameLocation: 'middle',
      nameGap: 22,
      nameTextStyle: { color: '#71717a', fontSize: 11 },
      data: labels,
      axisLabel: { color: '#71717a', interval: 4 },
    },
    yAxis: percentAxis('PnL % of capital'),
    series: [...bands, ...beforeCarry, ...lines],
  }
}

// ---------------------------------------------------------------------------
// Ruin: probability of total loss by holding period, one line per instrument.
// ---------------------------------------------------------------------------

const ruinOption = (comparison: Comparison, horizonDays: number): EChartsOption => {
  const results = live(comparison)
  const horizons = Array.map(results[0]?.ruinProbabilityByHorizon ?? [], point => point.day)
  const label = (days: number): string => (days >= 365 ? `${(days / 365).toFixed(days % 365 === 0 ? 0 : 1)}y` : `${days}d`)
  const current = horizons.reduce((best, d) => (Math.abs(d - horizonDays) < Math.abs(best - horizonDays) ? d : best), horizons[0] ?? 7)
  return {
    ...baseOption(),
    tooltip: { trigger: 'axis', confine: true, valueFormatter: value => `${value}%` },
    legend: { ...baseOption().legend, data: results.map(seriesName) },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      name: 'holding period',
      nameLocation: 'middle',
      nameGap: 28,
      nameTextStyle: { color: '#71717a', fontSize: 11 },
      data: Array.map(horizons, label),
      axisLabel: { color: '#71717a' },
    },
    yAxis: { ...percentAxis('probability of total loss'), min: 0, max: 100 },
    series: results.map((result, index) => ({
      name: seriesName(result),
      type: 'line' as const,
      showSymbol: true,
      symbolSize: 6,
      lineStyle: lineStyleFor(result),
      itemStyle: { color: instrumentColor(result.kind) },
      ...(result.kind === 'Perp' ? { areaStyle: { color: instrumentColor(result.kind), opacity: 0.08 } } : {}),
      data: Array.map(result.ruinProbabilityByHorizon, point => round(point.value * 100)),
      ...(index === 0
        ? {
            markLine: {
              symbol: 'none',
              silent: true,
              lineStyle: { color: PRICE_COLOR, type: 'dashed' as const },
              label: { color: '#71717a', fontSize: 10, formatter: 'selected' },
              data: [{ xAxis: label(current) }] as never,
            },
          }
        : {}),
    })),
  }
}

export type ChartOptionArgs = Readonly<{
  mode: ChartMode
  comparison: Comparison
  separateCarry: boolean
  horizonDays: number
}>

export const makeChartOption = (args: ChartOptionArgs): EChartsOption =>
  Match.value(args.mode).pipe(
    Match.when('Payoff', () => payoffOption(args.comparison, args.separateCarry)),
    Match.when('Ruin', () => ruinOption(args.comparison, args.horizonDays)),
    Match.exhaustive,
  )
