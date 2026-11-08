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
  expanded: boolean
  toMessage: (position: number) => Message
  toggleMessage: Message
}>

/**
 * A log-scale slider with instrument support drawn beneath it. Collapsed, all
 * three instruments share one strip: continuous caps are colored end marks,
 * contracts and expiries are pins. Expanded, each instrument gets its own
 * labelled band. The thumb is bound to the raw slider position, not the
 * resolved value, so it never jumps under the pointer.
 */
export const axisSliderView = (props: AxisSliderProps, h: HtmlBuilder<Message>): Html => {
  const pct = (value: number): string => `${(sliderFromValue(props.axis, value) * 100).toFixed(2)}%`
  const trackClass = 'relative ml-[8.5rem]'
  return h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.div(
        [h.Class('flex items-baseline justify-between gap-3')],
        [
          h.div(
            [h.Class('flex items-baseline gap-3')],
            [
              h.label([h.For(props.id), h.Class('text-sm font-semibold')], [props.title]),
              h.button(
                [
                  h.Type('button'),
                  h.Attribute('aria-expanded', props.expanded ? 'true' : 'false'),
                  h.Class('text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline'),
                  h.OnClick(props.toggleMessage),
                ],
                [props.expanded ? 'Collapse' : 'Show per instrument'],
              ),
            ],
          ),
          h.div(
            [h.Class('min-w-[7ch] text-right font-mono text-2xl font-semibold tabular-nums')],
            [props.formatValue(props.value)],
          ),
        ],
      ),
      h.p([h.Class('text-xs text-muted-foreground')], [props.description]),
      h.div(
        [h.Class(trackClass)],
        [
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
        ],
      ),
      props.expanded ? expandedBandsView(props, pct, h) : collapsedStripView(props, pct, h),
      h.div(
        [h.Class(`${trackClass} h-4 text-[10px] text-muted-foreground`)],
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

const hairline = (pct: (value: number) => string, value: number, h: HtmlBuilder<Message>): Html =>
  h.div([
    h.Class('pointer-events-none absolute top-0 bottom-0 w-px bg-foreground'),
    h.Style({ left: pct(value) }),
  ])

/** All instruments on one 12px strip, each on its own 4px lane so overlapping marks stay legible. */
const collapsedStripView = (props: AxisSliderProps, pct: (value: number) => string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center gap-3')],
    [
      h.div(
        [h.Class('flex w-[8.5rem] shrink-0 items-center gap-2 text-[10px] text-muted-foreground')],
        Array.map(props.instruments, result =>
          h.span(
            [h.Key(result.kind), h.Class('inline-flex items-center gap-1')],
            [h.span([h.Class(`inline-block size-1.5 rounded-full ${kindClass(result.kind)}`)], []), shortLabel(result)],
          ),
        ),
      ),
      h.div(
        [h.Class('relative h-3 flex-1')],
        [
          ...Array.flatMap(props.instruments, (result, lane) =>
            laneMarks(result, props.supportOf(result), pct, lane, h),
          ),
          hairline(pct, props.value, h),
        ],
      ),
    ],
  )

const shortLabel = (result: InstrumentResult): string =>
  result.kind === 'Perp' ? 'perp' : result.kind === 'SpotBorrow' ? 'borrow' : 'option'

const laneMarks = (
  result: InstrumentResult,
  support: AxisSupport,
  pct: (value: number) => string,
  lane: number,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const color = kindClass(result.kind)
  const top = `${lane * 4}px`
  switch (support._tag) {
    case 'Continuous': {
      const left = pct(support.min)
      const right = pct(support.max)
      const capped = right !== '100.00%'
      return [
        h.div([
          h.Key(`${result.kind}-bar`),
          h.Class(`absolute h-0.5 ${color} opacity-50`),
          h.Style({ top: `calc(${top} + 1px)`, left, width: `calc(${right} - ${left})` }),
        ]),
        ...(capped
          ? [
              h.div([
                h.Key(`${result.kind}-cap`),
                h.Class(`absolute h-3 w-0.5 ${color}`),
                h.Style({ top: '0px', left: right }),
                h.Title(`${result.label}: max ${support.max < 10 ? support.max.toFixed(2) : support.max.toFixed(0)}`),
              ]),
            ]
          : []),
        ...Array.map(support.pins, pin =>
          h.div([
            h.Key(`${result.kind}-${pin.label}`),
            h.Class(`absolute h-1 w-0.5 -translate-x-1/2 ${color} opacity-70`),
            h.Style({ top, left: pct(pin.value) }),
            h.Title(`${result.label}: ${pin.label}`),
          ]),
        ),
      ]
    }
    case 'Discrete':
      return Array.map(support.points, point =>
        h.div([
          h.Key(`${result.kind}-${point.label}`),
          h.Class(`absolute h-1 w-1 -translate-x-1/2 rounded-sm ${color}`),
          h.Style({ top, left: pct(point.value) }),
          h.Title(`${result.label}: ${point.value < 10 ? point.value.toFixed(2) : point.value.toFixed(0)} · ${point.label}`),
        ]),
      )
    case 'None':
      return []
  }
}

const expandedBandsView = (props: AxisSliderProps, pct: (value: number) => string, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('relative flex flex-col gap-1.5')],
    [
      ...Array.map(props.instruments, result => bandView(result, props.supportOf(result), pct, h)),
      h.div(
        [h.Class('pointer-events-none absolute top-0 bottom-0 right-0 left-[8.5rem] ml-3')],
        [hairline(pct, props.value, h)],
      ),
    ],
  )

const bandView = (
  result: InstrumentResult,
  support: AxisSupport,
  pct: (value: number) => string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Key(result.kind), h.Class('flex items-center gap-3')],
    [
      h.span([h.Class('w-[8.5rem] shrink-0 truncate text-xs text-muted-foreground')], [result.label]),
      h.div([h.Class('relative h-3 flex-1 overflow-visible')], bandMarks(result, support, pct, h)),
    ],
  )

const bandMarks = (
  result: InstrumentResult,
  support: AxisSupport,
  pct: (value: number) => string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const color = kindClass(result.kind)
  switch (support._tag) {
    case 'Continuous': {
      const left = pct(support.min)
      const right = pct(support.max)
      const capped = right !== '100.00%'
      return [
        h.div([
          h.Class(`absolute top-1 h-1 rounded-full ${color} opacity-40`),
          h.Style({ left, width: `calc(${right} - ${left})` }),
        ]),
        ...(capped
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
