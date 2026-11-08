import { Array } from 'effect'
import type { Html } from 'foldkit/html'
import { HtmlBuilder } from 'foldkit/html'

import type { InstrumentResult } from '@instruments/domain'

import { Message } from '../message'
import type { Model } from '../model'
import { LEVERAGE_MAX, LEVERAGE_MIN, sliderFromLeverage } from '../scenario'
import { kindClass } from './chart'

const SLIDER_STEPS = 1000
const TICKS = [1, 2, 3, 5, 10, 20, 50]

const pct = (leverage: number): string => `${(sliderFromLeverage(leverage) * 100).toFixed(2)}%`

/**
 * One band per instrument under a shared log-scale slider. Continuous support
 * is a solid bar closed by a colored vertical end mark; discrete support is a
 * row of pins, one per listed contract. The current request is a hairline
 * across all bands, so the user sees which instruments it lands on.
 */
export const leverageSliderView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm')],
    [
      h.div(
        [h.Class('flex items-baseline justify-between gap-3')],
        [
          h.div(
            [],
            [
              h.h3([h.Class('text-sm font-semibold')], ['Leverage']),
              h.p(
                [h.Class('text-xs text-muted-foreground')],
                ['Exposure per unit of capital. Bars show where each instrument can price it; pins are listed contracts. Requests snap down to a pin, never up.'],
              ),
            ],
          ),
          h.div(
            [h.Class('font-mono text-2xl font-semibold tabular-nums')],
            [`${model.scenario.leverage.toFixed(2)}x`],
          ),
        ],
      ),
      h.input([
        h.Id('leverage'),
        h.Type('range'),
        h.Min('0'),
        h.Max(String(SLIDER_STEPS)),
        h.Step('1'),
        h.Value(String(Math.round(sliderFromLeverage(model.scenario.leverage) * SLIDER_STEPS))),
        h.AriaLabel('Requested leverage'),
        h.Class('w-full accent-foreground'),
        h.OnInput(value => Message.UpdatedLeverageSlider({ position: Number(value) / SLIDER_STEPS })),
      ]),
      h.div(
        [h.Class('relative flex flex-col gap-1.5 pt-1')],
        [
          ...Array.map(model.comparison.instruments, result => bandView(result, h)),
          h.div([
            h.Class('pointer-events-none absolute top-0 bottom-0 w-px bg-foreground'),
            h.Style({ left: pct(model.scenario.leverage) }),
          ]),
        ],
      ),
      h.div(
        [h.Class('relative h-4 text-[10px] text-muted-foreground')],
        Array.map(TICKS, tick =>
          h.span(
            [h.Key(String(tick)), h.Class('absolute -translate-x-1/2 tabular-nums'), h.Style({ left: pct(tick) })],
            [`${tick}x`],
          ),
        ),
      ),
    ],
  )

const bandView = (result: InstrumentResult, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Key(result.kind), h.Class('flex items-center gap-3')],
    [
      h.span([h.Class('w-28 shrink-0 truncate text-xs text-muted-foreground')], [result.label]),
      h.div([h.Class('relative h-3 flex-1')], bandMarks(result, h)),
    ],
  )

const bandMarks = (result: InstrumentResult, h: HtmlBuilder<Message>): ReadonlyArray<Html> => {
  const color = kindClass(result.kind)
  switch (result.support._tag) {
    case 'Continuous': {
      const left = pct(Math.max(LEVERAGE_MIN, result.support.min))
      const right = pct(Math.min(LEVERAGE_MAX, result.support.max))
      return [
        h.div([
          h.Class(`absolute top-1 h-1 rounded-full ${color} opacity-40`),
          h.Style({ left, width: `calc(${right} - ${left})` }),
        ]),
        h.div([h.Class(`absolute top-0 h-3 w-0.5 ${color}`), h.Style({ left: right })]),
        h.span(
          [h.Class('absolute -top-0.5 translate-x-1.5 text-[10px] tabular-nums text-muted-foreground'), h.Style({ left: right })],
          [`${result.support.max.toFixed(result.support.max < 10 ? 2 : 0)}x max`],
        ),
      ]
    }
    case 'Discrete':
      return Array.map(result.support.points, point =>
        h.div([
          h.Key(point.label),
          h.Class(`absolute top-0 h-3 w-1 -translate-x-1/2 rounded-sm ${color}`),
          h.Style({ left: pct(Math.min(LEVERAGE_MAX, Math.max(LEVERAGE_MIN, point.leverage))) }),
          h.Title(`${point.leverage.toFixed(2)}x · ${point.label}`),
        ]),
      )
    case 'None':
      return [h.span([h.Class('absolute top-0 text-[10px] text-muted-foreground')], [result.support.reason])]
  }
}
