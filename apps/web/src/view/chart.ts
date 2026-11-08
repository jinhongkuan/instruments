import * as echarts from 'echarts/core'
import { Effect, Option, Queue, Schema, Stream } from 'effect'
import { Mount } from 'foldkit'
import type { Html } from 'foldkit/html'
import { HtmlBuilder } from 'foldkit/html'

import type { InstrumentResult } from '@instruments/domain'

import { removeChart, setChart } from '../chartHost'
import { type ChartMode, chartModeLabel } from '../chartMode'
import { Message } from '../message'
import { chartHostId } from '../scenario'
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

export const chartCardView = (
  result: InstrumentResult,
  mode: ChartMode,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.Key(result.kind),
      h.Class(
        result.resolved._tag === 'Unattainable'
          ? 'flex flex-col rounded-xl border border-dashed bg-card text-card-foreground opacity-60 grayscale'
          : 'flex flex-col rounded-xl border bg-card text-card-foreground shadow-sm',
      ),
    ],
    [
      h.header(
        [h.Class('flex items-start justify-between gap-3 border-b px-4 py-3')],
        [
          h.div(
            [],
            [
              h.div(
                [h.Class('flex items-center gap-2')],
                [
                  h.span([h.Class(`inline-block size-2.5 rounded-full ${kindClass(result.kind)}`)], []),
                  h.h3([h.Class('text-sm font-semibold leading-none')], [result.label]),
                ],
              ),
              h.p(
                [h.Class('mt-1 text-xs text-muted-foreground')],
                [`${result.venue} · ${leverageLabel(result)}`],
              ),
            ],
          ),
          h.span(
            [h.Class('rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-secondary-foreground')],
            [chartModeLabel(mode)],
          ),
        ],
      ),
      h.div([
        h.Class('h-64 w-full'),
        h.AriaLabel(`${result.label} ${chartModeLabel(mode)} chart`),
        h.OnMount(MountChart({ hostId: chartHostId(result.kind) })),
      ]),
      h.footer(
        [h.Class('grid grid-cols-3 gap-2 border-t px-4 py-3 text-xs')],
        [
          ...(!hasSeries(result)
            ? [h.div([h.Class('col-span-3 text-muted-foreground')], [result.resolved._tag === 'Unattainable' ? result.resolved.reason : 'No data'])]
            : [
                statView('Carry', formatPercent(result.summary.totalCarryPct), h),
                statView('Terminal PnL', formatPercent(result.summary.terminalPnlPct), h),
                statView(
                  'Worst drawdown',
                  result.summary.liquidated ? 'liquidated' : formatPercent(result.summary.maxDrawdownPct),
                  h,
                ),
              ]),
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
