import { Array, Option } from 'effect'
import type { Document, Html } from 'foldkit/html'
import { HtmlBuilder } from 'foldkit/html'

import { CHART_MODES, type ChartMode, chartModeDescription, chartModeLabel } from '../chartMode'
import { Message } from '../message'
import type { Model } from '../model'
import { chartCardView } from './chart'
import { formatUsd } from './format'
import { leverageSliderView } from './leverage'

export const GITHUB_URL = 'https://github.com/jinhongkuan/instruments'

const BUTTON = 'inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'
const INPUT = 'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: `${model.scenario.ticker} · instruments`,
  body: h.div(
    [h.Class('min-h-screen bg-background text-foreground')],
    [
      topBarView(h),
      h.main(
        [h.Class('mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8')],
        [
          heroView(model, h),
          framingTableView(h),
          leverageSliderView(model, h),
          chartsSectionView(model, h),
          footerView(model, h),
        ],
      ),
    ],
  ),
})

const topBarView = (h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('sticky top-0 z-10 border-b bg-background/80 backdrop-blur')],
    [
      h.div(
        [h.Class('mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8')],
        [
          h.a(
            [h.Href('/'), h.Class('flex items-center gap-2 font-semibold tracking-tight')],
            [
              h.span([h.Class('inline-block size-2 rounded-sm bg-primary')], []),
              'instruments',
            ],
          ),
          h.nav(
            [h.Class('flex items-center gap-4 text-sm text-muted-foreground')],
            [
              h.a([h.Href('#framing'), h.Class('hover:text-foreground')], ['Framing']),
              h.a([h.Href('#compare'), h.Class('hover:text-foreground')], ['Compare']),
              h.a(
                [
                  h.Href(GITHUB_URL),
                  h.Target('_blank'),
                  h.Class(`${BUTTON} h-8 border bg-background px-3 text-foreground hover:bg-accent`),
                ],
                ['GitHub ↗'],
              ),
            ],
          ),
        ],
      ),
    ],
  )

const heroView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-6')],
    [
      h.div(
        [h.Class('max-w-3xl')],
        [
          h.h1(
            [h.Class('text-3xl font-semibold tracking-tight sm:text-4xl')],
            ['Same bet, different instrument.'],
          ),
          h.p(
            [h.Class('mt-3 text-base text-muted-foreground')],
            [
              'Pick a ticker, capital, and horizon. See what long exposure would have cost and risked as a perpetual future, as spot bought with borrowed money, and as a call option.',
            ],
          ),
        ],
      ),
      scenarioFormView(model, h),
    ],
  )

const scenarioFormView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('grid gap-3 rounded-xl border bg-card p-4 shadow-sm sm:grid-cols-[1.2fr_1fr_1fr_auto] sm:items-end')],
    [
      fieldView('Ticker', 'ticker', h.input([
        h.Id('ticker'),
        h.Type('text'),
        h.Value(model.tickerInput),
        h.Placeholder('BTC, ETH, SOL, HYPE…'),
        h.Class(`${INPUT} uppercase`),
        h.OnInput(value => Message.UpdatedTickerInput({ value })),
      ]), h),
      fieldView('Capital (USD)', 'capital', h.input([
        h.Id('capital'),
        h.Type('number'),
        h.Min('100'),
        h.Step('100'),
        h.Value(model.capitalInput),
        h.Class(INPUT),
        h.OnInput(value => Message.UpdatedCapitalInput({ value })),
      ]), h),
      fieldView('Horizon (days)', 'horizon', h.input([
        h.Id('horizon'),
        h.Type('number'),
        h.Min('7'),
        h.Step('1'),
        h.Value(model.horizonInput),
        h.Class(INPUT),
        h.OnInput(value => Message.UpdatedHorizonInput({ value })),
      ]), h),
      h.button(
        [
          h.Type('button'),
          h.Class(`${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90`),
          h.OnClick(Message.SubmittedScenario()),
        ],
        ['Compare'],
      ),
    ],
  )

const fieldView = (label: string, id: string, input: Html, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('grid gap-1.5')],
    [h.label([h.For(id), h.Class('text-xs font-medium text-muted-foreground')], [label]), input],
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
                        [
                          h.span([h.Class(`mr-2 inline-block size-2 rounded-full ${row.dot}`)], []),
                          row.instrument,
                        ],
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
                [h.Class('text-lg font-semibold tracking-tight')],
                [
                  `Long ${model.scenario.ticker} at ${model.scenario.leverage.toFixed(2)}x · ${formatUsd(model.scenario.capitalUsd)} · ${model.scenario.horizonDays} days from ${model.scenario.entryDate}`,
                ],
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
        onSome: reason =>
          h.p([h.Class('text-sm text-destructive')], [`Chart error: ${reason}`]),
      }),
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
      h.p([], ['MIT licensed. Source on ', h.a([h.Href(GITHUB_URL), h.Target('_blank'), h.Class('underline')], ['GitHub']), '.']),
    ],
  )
