import { LineChart } from 'echarts/charts'
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
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
  legend: { top: 4, right: 8, textStyle: { color: '#71717a', fontSize: 11 } },
  grid: { left: 48, right: 20, top: 36, bottom: 32 },
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

const payoffOption = (result: InstrumentResult): EChartsOption => ({
  ...baseOption(),
  tooltip: { trigger: 'axis', confine: true, valueFormatter: value => `${value}%` },
  xAxis: {
    type: 'category',
    boundaryGap: false,
    name: 'terminal / entry',
    nameLocation: 'middle',
    nameGap: 22,
    nameTextStyle: { color: '#71717a', fontSize: 11 },
    data: Array.map(result.payoffAtHorizon, point => `${round(point.terminalPriceRatio)}x`),
    axisLabel: { color: '#71717a', interval: 7 },
  },
  yAxis: percentAxis('PnL % of capital'),
  series: [
    {
      name: 'net payoff',
      type: 'line',
      showSymbol: false,
      lineStyle: { width: 2.5, color: instrumentColor(result.kind) },
      itemStyle: { color: instrumentColor(result.kind) },
      data: Array.map(result.payoffAtHorizon, point => round(point.pnlPctOfCapital)),
      markLine: {
        symbol: 'none',
        silent: true,
        lineStyle: { color: PRICE_COLOR, type: 'dashed' },
        label: { color: '#71717a', fontSize: 10 },
        data: [{ yAxis: 0, name: 'breakeven' }, { xAxis: '1x', name: 'entry' }],
      },
    },
  ],
})

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
        Match.when('Payoff', () => payoffOption(result)),
        Match.when('Path', () => pathOption(result, args.comparison)),
        Match.exhaustive,
        ),
    ),
  )
