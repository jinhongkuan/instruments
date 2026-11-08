import * as echarts from 'echarts/core'
import { Effect, Option, Queue, Schema, Stream } from 'effect'
import { Mount } from 'foldkit'
import type { Html } from 'foldkit/html'
import { HtmlBuilder } from 'foldkit/html'

import type { InstrumentResult } from '@instruments/domain'

import { removeChart, setChart } from '../chartHost'
import { type ChartMode, chartModeLabel } from '../chartMode'
import { Message } from '../message'
import { CHART_HOST_ID } from '../scenario'
import { formatPercent } from './format'

type MountChartMessage =
  | typeof Message.SucceededMountChart.Type
  | typeof Message.FailedMountChart.Type

const toChartMountError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(`Failed to mount chart: ${error}`)

const observeResize = (element: HTMLElement, chart: ReturnType<typeof echarts.init>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const resizeObserver = new ResizeObserver(() => chart.resize())
      resizeObserver.observe(element)
      return resizeObserver
    }),
    resizeObserver => Effect.sync(() => resizeObserver.disconnect()),
  )

const mountChart = (element: Element, hostId: string) =>
  Stream.callback<MountChartMessage>(queue =>
    Effect.gen(function* () {
      if (!(element instanceof HTMLElement)) {
        Queue.offerUnsafe(
          queue,
          Message.FailedMountChart({ reason: 'Chart host is not an HTMLElement.' }),
        )
        return yield* Effect.never
      }

      const chart = yield* Effect.acquireRelease(
        Effect.try({
          try: () => echarts.init(element, undefined, { renderer: 'canvas' }),
          catch: toChartMountError,
        }),
        chart => Effect.sync(() => removeChart(hostId, chart)),
      )
      setChart(hostId, chart)
      yield* observeResize(element, chart)

      Queue.offerUnsafe(queue, Message.SucceededMountChart({ hostId }))
      return yield* Effect.never
    }).pipe(
      Effect.catch(error =>
        Effect.sync(() =>
          Queue.offerUnsafe(queue, Message.FailedMountChart({ reason: error.message })),
        ),
      ),
    ),
  )

export const MountChart = Mount.defineStream('MountChart', {
  args: { hostId: Schema.String },
  messages: [Message.SucceededMountChart, Message.FailedMountChart],
  execute: ({ element, hostId }) => mountChart(element, hostId),
})

export const kindClass = (kind: InstrumentResult['kind']): string =>
  kind === 'Perp' ? 'bg-chart-perp' : kind === 'SpotBorrow' ? 'bg-chart-borrow' : 'bg-chart-option'

const leverageLabel = (result: InstrumentResult): string => {
  const r = result.resolved
  if (r._tag === 'Exact') {
    return `${r.value.toFixed(2)}x`
  }
  if (r._tag === 'Snapped') {
    return `${r.value.toFixed(2)}x (snapped ${r.direction === 'Down' ? 'down' : 'up'} from ${r.requested.toFixed(2)}x, ${r.label})`
  }
  return Option.match(r.fallback, {
    onNone: () => `not available at ${r.requested.toFixed(2)}x`,
    onSome: fallback => `showing ${fallback.toFixed(2)}x, the highest available below ${r.requested.toFixed(2)}x`,
  })
}

const hasSeries = (result: InstrumentResult): boolean => result.exposureMultiple > 0

const carryKindLabel = (kind: InstrumentResult['carryBand']['kind']): string =>
  kind === 'Floating' ? 'Floating' : kind === 'Fixed' ? 'Fixed' : kind === 'Prepaid' ? 'Prepaid' : 'Streaming'

/** One chart for all instruments. The benchmark is the dotted line everything else is read against. */
export const chartPanelView = (mode: ChartMode, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('rounded-xl border bg-card text-card-foreground shadow-sm')],
    [
      h.div([
        h.Class('h-[26rem] w-full'),
        h.AriaLabel(`${chartModeLabel(mode)} chart`),
        h.OnMount(MountChart({ hostId: CHART_HOST_ID })),
      ]),
    ],
  )

/** Per-instrument numbers under the chart. Greys out when the request could not be met. */
export const statsCardView = (result: InstrumentResult, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.Key(result.kind),
      h.Class(
        result.resolved._tag === 'Unattainable'
          ? 'flex flex-col gap-2 rounded-xl border border-dashed bg-card p-4 text-card-foreground opacity-60 grayscale'
          : 'flex flex-col gap-2 rounded-xl border bg-card p-4 text-card-foreground shadow-sm',
      ),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-2')],
        [
          h.span(
            [h.Class(`inline-block h-0.5 w-5 ${kindClass(result.kind)} ${result.kind === 'SpotBorrow' ? 'opacity-70 [border-top:2px_dotted] bg-transparent border-chart-borrow' : ''}`)],
            [],
          ),
          h.h3([h.Class('text-sm font-semibold leading-none')], [result.label]),
        ],
      ),
      h.p([h.Class('text-xs text-muted-foreground')], [`${result.venue} · ${leverageLabel(result)}`]),
      h.p(
        [h.Class('text-[11px] text-muted-foreground')],
        [`${carryKindLabel(result.carryBand.kind)} carry · ${result.carryBand.basis}`],
      ),
      h.div(
        [h.Class('mt-1 grid grid-cols-3 gap-2 border-t pt-3 text-xs')],
        !hasSeries(result)
          ? [h.div([h.Class('col-span-3 text-muted-foreground')], [result.resolved._tag === 'Unattainable' ? result.resolved.reason : 'No data'])]
          : [
              statView(
                result.carryBand.kind === 'Floating' ? 'Carry (p10–p90)' : 'Carry',
                result.carryBand.high - result.carryBand.low > 1e-9
                  ? `${formatPercent(result.carryBand.low)} to ${formatPercent(result.carryBand.high)}`
                  : formatPercent(result.carryBand.mid),
                h,
              ),
              statView('Terminal PnL', formatPercent(result.summary.terminalPnlPct), h),
              statView(
                'Worst drawdown',
                result.summary.liquidated ? 'liquidated' : formatPercent(result.summary.maxDrawdownPct),
                h,
              ),
            ],
      ),
    ],
  )

const statView = (label: string, value: string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      h.div([h.Class('text-muted-foreground')], [label]),
      h.div([h.Class('font-medium tabular-nums')], [value]),
    ],
  )
