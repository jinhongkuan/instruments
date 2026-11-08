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
import { Array, Match, Option, pipe } from 'effect'

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
  tooltip: { trigger: 'axis', confine: true },
  legend: { bottom: 0, left: 'center', itemWidth: 14, itemHeight: 8, textStyle: { color: '#71717a', fontSize: 11 } },
  grid: { left: 48, right: 20, top: 28, bottom: 56 },
  aria: { enabled: true },
})

const percentAxis = (name: string) => ({
  type: 'value' as const,
  name,
  nameTextStyle: { color: '#71717a', fontSize: 11 },
  axisLabel: { formatter: '{value}%', color: '#71717a' },
  splitLine: { lineStyle: { color: GRID_COLOR } },
})

const dayAxis = (days: ReadonlyArray<number>) => ({
  type: 'category' as const,
  boundaryGap: false,
  data: Array.map(days, day => `d${day}`),
  axisLabel: { color: '#71717a' },
})

const round = (value: number): number => Math.round(value * 100) / 100

const carryOption = (result: InstrumentResult): EChartsOption => ({
  ...baseOption(),
  xAxis: dayAxis(Array.map(result.carryPctOfCapital, point => point.day)),
  yAxis: percentAxis('% of capital'),
  series: [
    {
      name: 'carry paid',
      type: 'line',
      showSymbol: false,
      lineStyle: { width: 2.5, color: instrumentColor(result.kind) },
      itemStyle: { color: instrumentColor(result.kind) },
      areaStyle: { color: instrumentColor(result.kind), opacity: 0.12 },
      data: Array.map(result.carryPctOfCapital, point => round(point.value)),
    },
  ],
})

const ratioLabel = (ratio: number): string => `${round(ratio)}x`

const nearestGridLabel = (result: InstrumentResult, ratio: number): string =>
  pipe(
    result.payoffAtHorizon,
    Array.map(point => point.terminalPriceRatio),
    ratios => ratios.reduce((best, r) => (Math.abs(r - ratio) < Math.abs(best - ratio) ? r : best), ratios[0] ?? 1),
    ratioLabel,
  )

const payoffOption = (result: InstrumentResult, separateCarry: boolean): EChartsOption => {
  const color = instrumentColor(result.kind)
  const labels = Array.map(result.payoffAtHorizon, point => ratioLabel(point.terminalPriceRatio))
  const hasBand = result.carryBand.high - result.carryBand.low > 1e-9
  const firstLabel = labels[0] ?? '0.5x'
  type RuinMarks = Readonly<{
    lines: ReadonlyArray<{ xAxis: string; name: string; lineStyle: { color: string; width: number }; label: { formatter: string; color: string; fontSize: number; position: 'insideEndTop' } }>
    areas: ReadonlyArray<[{ xAxis: string }, { xAxis: string }]>
  }>
  const ruinMarks: RuinMarks = Option.match(result.ruinPriceRatio, {
    onNone: () => ({ lines: [], areas: [] }),
    onSome: ratio => {
      const at = nearestGridLabel(result, ratio)
      return {
        lines: [{ xAxis: at, name: 'liquidated if touched', lineStyle: { color: '#ef4444', width: 1.5 }, label: { formatter: 'liquidation', color: '#ef4444', fontSize: 10, position: 'insideEndTop' } }],
        areas: [[{ xAxis: firstLabel }, { xAxis: at }]],
      }
    },
  })
  const bandSeries = hasBand
    ? [
        {
          name: 'carry band (low)',
          type: 'line' as const,
          stack: 'band',
          showSymbol: false,
          silent: true,
          lineStyle: { opacity: 0 },
          itemStyle: { color },
          tooltip: { show: false },
          data: Array.map(result.payoffAtHorizon, point => round(point.low)),
        },
        {
          name: 'carry band',
          type: 'line' as const,
          stack: 'band',
          showSymbol: false,
          silent: true,
          lineStyle: { opacity: 0 },
          itemStyle: { color },
          areaStyle: { color, opacity: 0.16 },
          data: Array.map(result.payoffAtHorizon, point => round(point.high - point.low)),
        },
      ]
    : []
  const counterfactual = Option.match(result.fixedCounterfactual, {
    onNone: () => [],
    onSome: series => [
      {
        name: 'fixed-rate quote',
        type: 'line' as const,
        showSymbol: false,
        lineStyle: { width: 1.5, color: '#52525b', type: 'dashed' as const },
        itemStyle: { color: '#52525b' },
        data: Array.map(series, point => round(point.value)),
      },
    ],
  })
  const beforeCarry = separateCarry
    ? [
        {
          name: 'before carry',
          type: 'line' as const,
          showSymbol: false,
          lineStyle: { width: 1.5, color, type: 'dotted' as const },
          itemStyle: { color },
          data: Array.map(result.payoffAtHorizon, point => round(point.beforeCarry)),
        },
      ]
    : []
  return {
    ...baseOption(),
    tooltip: { trigger: 'axis', confine: true, valueFormatter: value => `${value}%` },
    legend: { ...baseOption().legend, data: ['net payoff', ...(hasBand ? ['carry band'] : []), ...(counterfactual.length > 0 ? ['fixed-rate quote'] : []), ...(separateCarry ? ['before carry'] : [])] },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      name: 'price at end / price at entry',
      nameLocation: 'middle',
      nameGap: 22,
      nameTextStyle: { color: '#71717a', fontSize: 11 },
      data: labels,
      axisLabel: { color: '#71717a', interval: 7 },
    },
    yAxis: percentAxis('PnL % of capital'),
    series: [
      ...bandSeries,
      ...counterfactual,
      ...beforeCarry,
      {
        name: 'net payoff',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 2.5, color },
        itemStyle: { color },
        data: Array.map(result.payoffAtHorizon, point => round(point.mid)),
        markLine: {
          symbol: 'none',
          silent: true,
          lineStyle: { color: PRICE_COLOR, type: 'dashed' },
          label: { color: '#71717a', fontSize: 10 },
          data: [{ yAxis: 0, name: 'breakeven' }, { xAxis: '1x', name: 'entry' }, ...ruinMarks.lines] as never,
        },
        markArea: {
          silent: true,
          itemStyle: { color: '#ef4444', opacity: 0.06 },
          data: [...ruinMarks.areas],
        },
      },
    ],
  }
}

const pathOption = (result: InstrumentResult, comparison: Comparison): EChartsOption => {
  const days = Array.map(result.equityPctOfCapital, point => point.day)
  const eventLines = Array.map(result.pathEvents, event => ({
    xAxis: `d${event.day}`,
    name: event.kind,
    lineStyle: { color: '#ef4444', width: 1.5 },
    label: { formatter: event.kind, color: '#ef4444', fontSize: 10 },
  }))
  return {
    ...baseOption(),
    xAxis: dayAxis(days),
    yAxis: [
      percentAxis('equity % of capital'),
      {
        type: 'value',
        name: 'price / entry',
        nameTextStyle: { color: '#71717a', fontSize: 11 },
        axisLabel: { formatter: '{value}x', color: '#71717a' },
        splitLine: { show: false },
        scale: true,
      },
    ],
    series: [
      {
        name: 'equity',
        type: 'line',
        showSymbol: false,
        lineStyle: { width: 2.5, color: instrumentColor(result.kind) },
        itemStyle: { color: instrumentColor(result.kind) },
        data: Array.map(result.equityPctOfCapital, point => round(point.value)),
        markLine: {
          symbol: 'none',
          silent: true,
          lineStyle: { type: 'dashed' },
          data: eventLines,
        },
      },
      {
        name: 'price',
        type: 'line',
        yAxisIndex: 1,
        showSymbol: false,
        lineStyle: { width: 1.5, color: PRICE_COLOR, type: 'dotted' },
        itemStyle: { color: PRICE_COLOR },
        data: Array.map(comparison.priceRatio, point => round(point.value)),
      },
    ],
  }
}

export type ChartOptionArgs = Readonly<{
  kind: InstrumentKind
  mode: ChartMode
  comparison: Comparison
  separateCarry: boolean
}>

const unavailableOption = (reason: string): EChartsOption => ({
  animation: false,
  backgroundColor: 'transparent',
  title: {
    text: 'Not available at this leverage',
    subtext: reason,
    left: 'center',
    top: 'middle',
    textStyle: { color: '#71717a', fontSize: 13, fontWeight: 500 },
    subtextStyle: { color: '#a1a1aa', fontSize: 11 },
  },
})

export const makeChartOption = (args: ChartOptionArgs): Option.Option<EChartsOption> =>
  pipe(
    Array.findFirst(args.comparison.instruments, result => result.kind === args.kind),
    Option.map(result =>
      result.exposureMultiple === 0
        ? unavailableOption(result.resolved._tag === 'Unattainable' ? result.resolved.reason : 'No data')
        : Match.value(args.mode).pipe(
        Match.when('Carry', () => carryOption(result)),
        Match.when('Payoff', () => payoffOption(result, args.separateCarry)),
        Match.when('Path', () => pathOption(result, args.comparison)),
        Match.exhaustive,
        ),
    ),
  )
