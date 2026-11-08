import { Array } from 'effect'
import type { Html } from 'foldkit/html'
import { HtmlBuilder } from 'foldkit/html'

import type { AxisSupport, InstrumentResult } from '@instruments/domain'

import type { Message } from '../message'
import { type LogAxis, sliderFromValue } from '../scenario'
import { kindClass } from './chart'

const SLIDER_STEPS = 1000

export type AxisSliderProps = Readonly<{
  id: string
  title: string
  description: string
  axis: LogAxis
  position: number
  value: number
  formatValue: (value: number) => string
  ticks: ReadonlyArray<number>
  supportOf: (result: InstrumentResult) => AxisSupport
  instruments: ReadonlyArray<InstrumentResult>
  toMessage: (position: number) => Message
}>

/**
 * A log-scale slider with one band per instrument. Continuous support is a
 * faint bar closed by a colored vertical end mark; pins are listed contracts
 * or expiries. The thumb is bound to the raw slider position, not the
 * resolved value, so it never jumps under the pointer; the resolved value is
 * printed beside the title and drawn as a hairline across the bands.
 */
export const axisSliderView = (props: AxisSliderProps, h: HtmlBuilder<Message>): Html => {
  const pct = (value: number): string => `${(sliderFromValue(props.axis, value) * 100).toFixed(2)}%`
  return h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.div(
        [h.Class('flex items-baseline justify-between gap-3')],
        [
          h.div(
            [],
            [
              h.label([h.For(props.id), h.Class('text-sm font-semibold')], [props.title]),
              h.p([h.Class('text-xs text-muted-foreground')], [props.description]),
            ],
          ),
          h.div(
            [h.Class('min-w-[7ch] text-right font-mono text-2xl font-semibold tabular-nums')],
            [props.formatValue(props.value)],
          ),
        ],
      ),
      h.input([
        h.Id(props.id),
        h.Type('range'),
        h.Min('0'),
        h.Max(String(SLIDER_STEPS)),
        h.Step('1'),
        h.Value(String(Math.round(props.position * SLIDER_STEPS))),
        h.AriaLabel(props.title),
        h.Class('w-full accent-foreground'),
        h.OnInput(value => props.toMessage(Number(value) / SLIDER_STEPS)),
      ]),
      h.div(
        [h.Class('relative flex flex-col gap-1.5 pt-1')],
        [
          ...Array.map(props.instruments, result => bandView(result, props.supportOf(result), pct, h)),
          h.div([
            h.Class('pointer-events-none absolute top-0 bottom-0 left-[7.5rem] right-0'),
          ], [
            h.div([
              h.Class('absolute top-0 bottom-0 w-px bg-foreground'),
              h.Style({ left: pct(props.value) }),
            ]),
          ]),
        ],
      ),
      h.div(
        [h.Class('relative ml-[7.5rem] h-4 text-[10px] text-muted-foreground')],
        Array.map(props.ticks, tick =>
          h.span(
            [h.Key(String(tick)), h.Class('absolute -translate-x-1/2 tabular-nums'), h.Style({ left: pct(tick) })],
            [props.formatValue(tick)],
          ),
        ),
      ),
    ],
  )
}

const bandView = (
  result: InstrumentResult,
  support: AxisSupport,
  pct: (value: number) => string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Key(result.kind), h.Class('flex items-center gap-3')],
    [
      h.span([h.Class('w-[6.75rem] shrink-0 truncate text-xs text-muted-foreground')], [result.label]),
      h.div([h.Class('relative h-3 flex-1 overflow-visible')], bandMarks(result, support, pct, h)),
    ],
  )

const clampPct = (pct: (value: number) => string, value: number): string => pct(value)

const bandMarks = (
  result: InstrumentResult,
  support: AxisSupport,
  pct: (value: number) => string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const color = kindClass(result.kind)
  switch (support._tag) {
    case 'Continuous': {
      const left = clampPct(pct, support.min)
      const right = clampPct(pct, support.max)
      const capped = sliderFromValue({ min: 1, max: Number.MAX_SAFE_INTEGER }, support.max) < 1
      return [
        h.div([
          h.Class(`absolute top-1 h-1 rounded-full ${color} opacity-40`),
          h.Style({ left, width: `calc(${right} - ${left})` }),
        ]),
        ...(capped && right !== '100.00%'
          ? [
              h.div([h.Class(`absolute top-0 h-3 w-0.5 ${color}`), h.Style({ left: right })]),
              h.span(
                [
                  h.Class('absolute -top-0.5 translate-x-1.5 whitespace-nowrap text-[10px] tabular-nums text-muted-foreground'),
                  h.Style({ left: right }),
                ],
                [`max ${support.max < 10 ? support.max.toFixed(2) : support.max.toFixed(0)}`],
              ),
            ]
          : []),
        ...Array.map(support.pins, pin =>
          h.div([
            h.Key(pin.label),
            h.Class(`absolute top-0.5 h-2 w-0.5 -translate-x-1/2 ${color} opacity-70`),
            h.Style({ left: pct(pin.value) }),
            h.Title(pin.label),
          ]),
        ),
      ]
    }
    case 'Discrete':
      return Array.map(support.points, point =>
        h.div([
          h.Key(point.label),
          h.Class(`absolute top-0 h-3 w-1 -translate-x-1/2 rounded-sm ${color}`),
          h.Style({ left: pct(point.value) }),
          h.Title(`${point.value < 10 ? point.value.toFixed(2) : point.value.toFixed(0)} · ${point.label}`),
        ]),
      )
    case 'None':
      return [h.span([h.Class('absolute top-0 text-[10px] text-muted-foreground')], [support.reason])]
  }
}
