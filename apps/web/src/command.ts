import { Effect, Option, Schema } from 'effect'
import { Command } from 'foldkit'

import { Comparison, MANIFEST_KEY, Manifest, TickerBundle, bundleKey } from '@instruments/domain'

import { getChart } from './chartHost'
import { BUNDLES_BASE_URL } from './data'
import { ChartMode } from './chartMode'
import { makeChartOption } from './echarts'
import { Message } from './message'

export const SyncChart = Command.define('SyncChart', {
  args: {
    hostId: Schema.String,
    mode: ChartMode,
    comparison: Comparison,
    separateCarry: Schema.Boolean,
    horizonDays: Schema.Number,
  },
  messages: [Message.SucceededSyncChart, Message.FailedSyncChart],
  execute: args =>
    Option.match(getChart(args.hostId), {
      onNone: () =>
        Effect.succeed(
          Message.FailedSyncChart({ reason: `No live chart for host ${args.hostId}.` }),
        ),
      onSome: chart =>
        Effect.try(() => chart.setOption(makeChartOption(args), true)).pipe(
          Effect.as(Message.SucceededSyncChart()),
          Effect.catch(error =>
            Effect.succeed(
              Message.FailedSyncChart({
                reason: error instanceof Error ? error.message : `${error}`,
              }),
            ),
          ),
        ),
    }),
})

const fetchJson = (url: string, cache: RequestCache) =>
  Effect.tryPromise(async () => {
    const response = await fetch(url, { cache })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`)
    }
    return (await response.json()) as unknown
  })

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : `${error}`

/** The manifest is short-cached and names this hour's bundle folder. */
export const FetchManifest = Command.define('FetchManifest', {
  messages: [Message.SucceededFetchManifest, Message.FailedFetchManifest],
  execute: fetchJson(`${BUNDLES_BASE_URL}/${MANIFEST_KEY}`, 'no-cache').pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
    Effect.map(manifest => Message.SucceededFetchManifest({ manifest })),
    Effect.catch(error => Effect.succeed(Message.FailedFetchManifest({ reason: describeError(error) }))),
  ),
})

/** Bundles are immutable per hour, so the browser cache can keep them. */
export const FetchBundle = Command.define('FetchBundle', {
  args: { prefix: Schema.String, ticker: Schema.String },
  messages: [Message.SucceededFetchBundle, Message.FailedFetchBundle],
  execute: ({ prefix, ticker }) =>
    fetchJson(`${BUNDLES_BASE_URL}/${bundleKey(prefix, ticker)}`, 'default').pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(TickerBundle)),
      Effect.map(bundle => Message.SucceededFetchBundle({ bundle })),
      Effect.catch(error => Effect.succeed(Message.FailedFetchBundle({ ticker, reason: describeError(error) }))),
    ),
})
