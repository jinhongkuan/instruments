import { Array, Option } from 'effect'
import type { Document, Html } from 'foldkit/html'
import { HtmlBuilder } from 'foldkit/html'

import { CHART_MODES, type ChartMode, chartModeDescription, chartModeLabel } from '../chartMode'
import { Message } from '../message'
import type { Model } from '../model'
import { HORIZON_AXIS, KNOWN_TICKERS, LEVERAGE_AXIS } from '../scenario'
import { axisSliderView } from './axis'
import { chartCardView } from './chart'

export const GITHUB_URL = 'https://github.com/jinhongkuan/instruments'

const BUTTON =
  'inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'
const INPUT =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${model.scenario.ticker} · instruments`,
  body: h.div(
    [h.Class('min-h-screen bg-background text-foreground')],
    [
      topBarView(model, h),
      h.main(
        [h.Class('mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8')],
        [
          heroView(h),
          slidersView(model, h),
          chartsSectionView(model, h),
          framingTableView(h),
          footerView(model, h),
        ],
      ),
    ],
  ),
})

const topBarView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('sticky top-0 z-10 border-b bg-background/80 backdrop-blur')],
    [
      h.div(
        [h.Class('mx-auto flex h-14 w-full max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8')],
        [
          h.a(
            [h.Href('/'), h.Class('flex shrink-0 items-center gap-2 font-semibold tracking-tight')],
            [h.span([h.Class('inline-block size-2 rounded-sm bg-primary')], []), 'instruments'],
          ),
          h.div(
            [h.Class('flex flex-1 items-center gap-2')],
            [
              h.label([h.For('ticker'), h.Class('text-xs text-muted-foreground')], ['Asset']),
              h.input([
                h.Id('ticker'),
                h.Type('text'),
                h.List('tickers'),
                h.Autocomplete('off'),
                h.Spellcheck(false),
                h.Value(model.tickerInput),
                h.Placeholder('BTC, ETH, SOL…'),
                h.AriaLabel('Asset ticker'),
                h.Class(`${INPUT} max-w-[14rem] font-mono uppercase`),
                h.OnInput(value => Message.UpdatedTickerInput({ value })),
              ]),
              h.datalist(
                [h.Id('tickers')],
                Array.map(KNOWN_TICKERS, ticker => h.option([h.Key(ticker), h.Value(ticker)], [])),
              ),
            ],
          ),
          h.a(
            [
              h.Href(GITHUB_URL),
              h.Target('_blank'),
              h.Rel('noopener'),
              h.Class(`${BUTTON} h-8 shrink-0 border bg-background px-3 text-foreground hover:bg-accent`),
            ],
            ['GitHub ↗'],
          ),
        ],
      ),
    ],
  )

const heroView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('max-w-3xl')],
    [
      h.h1([h.Class('text-3xl font-semibold tracking-tight sm:text-4xl')], ['Same bet, different instrument.']),
      h.p(
        [h.Class('mt-3 text-base text-muted-foreground')],
        [
          'Pick an asset, a leverage, and a holding period. See how the market prices that exposure as a perpetual future, as spot bought with borrowed money, and as a call option, and where one of them cannot price it at all.',
        ],
      ),
    ],
  )

const formatLeverage = (value: number): string => `${value < 10 ? value.toFixed(2) : value.toFixed(0)}x`
const formatDays = (value: number): string => (value >= 365 ? `${(value / 365).toFixed(value % 365 === 0 ? 0 : 1)}y` : `${Math.round(value)}d`)

const slidersView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('grid gap-6 rounded-xl border bg-card p-4 shadow-sm lg:grid-cols-2 lg:gap-10')],
    [
      axisSliderView(
        {
          id: 'leverage',
          title: 'Leverage',
          description: 'Exposure per unit of capital. Bars show where each instrument can price it; pins are listed contracts. Requests snap down, never up.',
          axis: LEVERAGE_AXIS,
          position: model.leveragePosition,
          value: model.scenario.leverage,
          formatValue: formatLeverage,
          ticks: [1, 2, 3, 5, 10, 20, 50],
          supportOf: result => result.support.leverage,
          instruments: model.comparison.instruments,
          toMessage: position => Message.UpdatedLeverageSlider({ position }),
        },
        h,
      ),
      axisSliderView(
        {
          id: 'horizon',
          title: 'Holding period',
          description: 'How long the exposure is held. Pins are listed expiries; past the last one an option is rolled into a like contract.',
          axis: HORIZON_AXIS,
          position: model.horizonPosition,
          value: model.scenario.horizonDays,
          formatValue: formatDays,
          ticks: [7, 14, 30, 90, 180, 365, 730],
          supportOf: result => result.support.horizonDays,
          instruments: model.comparison.instruments,
          toMessage: position => Message.UpdatedHorizonSlider({ position }),
        },
        h,
      ),
    ],
  )

const chartModeTabsView = (selected: ChartMode, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground')],
    Array.map(CHART_MODES, mode =>
      h.button(
        [
          h.Key(mode),
          h.Type('button'),
          h.Class(
            mode === selected
              ? 'inline-flex h-7 items-center rounded-md bg-background px-3 text-sm font-medium text-foreground shadow-sm'
              : 'inline-flex h-7 items-center rounded-md px-3 text-sm font-medium hover:text-foreground',
          ),
          h.OnClick(Message.SelectedChartMode({ mode })),
        ],
        [chartModeLabel(mode)],
      ),
    ),
  )

const chartsSectionView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id('compare'), h.Class('flex flex-col gap-4')],
    [
      h.div(
        [h.Class('flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between')],
        [
          h.div(
            [],
            [
              h.h2(
                [h.Class('text-lg font-semibold tracking-tight tabular-nums')],
                [`Long ${model.scenario.ticker} at ${formatLeverage(model.scenario.leverage)} for ${formatDays(model.scenario.horizonDays)}`],
              ),
              h.p([h.Class('text-sm text-muted-foreground')], [chartModeDescription(model.chartMode)]),
            ],
          ),
          chartModeTabsView(model.chartMode, h),
        ],
      ),
      h.div(
        [h.Class('grid gap-4 lg:grid-cols-3')],
        Array.map(model.comparison.instruments, result => chartCardView(result, model.chartMode, h)),
      ),
      Option.match(model.maybeChartError, {
        onNone: () => h.div([], []),
        onSome: reason => h.p([h.Class('text-sm text-destructive')], [`Chart error: ${reason}`]),
      }),
    ],
  )

type FramingRow = Readonly<{
  instrument: string
  payoff: string
  carry: string
  capital: string
  ruin: string
  dot: string
}>

const FRAMING_ROWS: ReadonlyArray<FramingRow> = [
  {
    instrument: 'Perpetual future',
    payoff: 'linear',
    carry: 'floating, set hourly by crowding',
    capital: 'margin only',
    ruin: "liquidation on the venue's mark price",
    dot: 'bg-chart-perp',
  },
  {
    instrument: 'Spot + borrow',
    payoff: 'linear',
    carry: 'fixed or benchmark-tracking interest',
    capital: 'full notional minus loan-to-value',
    ruin: "liquidation when collateral falls below the lender's threshold",
    dot: 'bg-chart-borrow',
  },
  {
    instrument: 'Call option',
    payoff: 'convex',
    carry: 'premium paid upfront, decays with time',
    capital: 'premium only',
    ruin: 'expires worthless, but can never be liquidated',
    dot: 'bg-chart-option',
  },
]

const framingTableView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Id('framing'), h.Class('flex flex-col gap-3')],
    [
      h.div(
        [],
        [
          h.h2([h.Class('text-lg font-semibold tracking-tight')], ['What each instrument trades away']),
          h.p(
            [h.Class('text-sm text-muted-foreground')],
            ['Read across a row for the deal one instrument offers. Read down a column for the same risk priced three ways.'],
          ),
        ],
      ),
      h.div(
        [h.Class('overflow-x-auto rounded-xl border')],
        [
          h.table(
            [h.Class('w-full text-sm')],
            [
              h.thead(
                [h.Class('bg-muted/50 text-left text-xs text-muted-foreground')],
                [
                  h.tr(
                    [],
                    Array.map(['Instrument', 'Payoff', 'Carry', 'Capital tied up', 'How you lose it all'], label =>
                      h.th([h.Key(label), h.Class('px-4 py-2 font-medium')], [label]),
                    ),
                  ),
                ],
              ),
              h.tbody(
                [],
                Array.map(FRAMING_ROWS, row =>
                  h.tr(
                    [h.Key(row.instrument), h.Class('border-t')],
                    [
                      h.td(
                        [h.Class('px-4 py-3 font-medium')],
                        [h.span([h.Class(`mr-2 inline-block size-2 rounded-full ${row.dot}`)], []), row.instrument],
                      ),
                      h.td([h.Class('px-4 py-3')], [row.payoff]),
                      h.td([h.Class('px-4 py-3')], [row.carry]),
                      h.td([h.Class('px-4 py-3')], [row.capital]),
                      h.td([h.Class('px-4 py-3 text-muted-foreground')], [row.ruin]),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  )

const footerView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.footer(
    [h.Class('flex flex-col gap-2 border-t pt-6 text-xs text-muted-foreground')],
    [
      model.comparison.synthetic
        ? h.p(
            [h.Class('inline-flex w-fit items-center gap-2 rounded-md border border-dashed px-2 py-1')],
            [
              h.span([h.Class('inline-block size-1.5 rounded-full bg-chart-option')], []),
              'Synthetic data. Every series on this page is generated from a seeded model so the layout can be judged before ingestion lands.',
            ],
          )
        : h.div([], []),
      h.p(
        [],
        ['MIT licensed. Source on ', h.a([h.Href(GITHUB_URL), h.Target('_blank'), h.Rel('noopener'), h.Class('underline')], ['GitHub']), '.'],
      ),
    ],
  )
