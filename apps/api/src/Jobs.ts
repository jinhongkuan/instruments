// Jobs Worker: the whole data pipeline on Cron Triggers. Nothing a viewer
// does reaches it; viewers read the bundles it publishes to R2.
//
//   :00 hourly   ingest: one Hyperliquid call for every coin, one Deribit call per currency, SOFR, retention
//   :05 hourly   derive: read one snapshot, build every bundle, publish, manifest last
//   00:20 daily  settle: settled funding and closed candles per coin (also repairs gaps after an outage)
import * as Cloudflare from '@alchemy.run/cloudflare'
import { makeDb } from '@instruments/db'
import { type Deps, type ObjectStore, deriveAndPublish, ingestHourly, settle } from '@instruments/pipeline'
import { RuntimeContext } from 'alchemy/RuntimeContext'
import { Effect, Layer, Redacted } from 'effect'
import * as HttpServerResponse from 'effect/http/HttpServerResponse'

import { Bundles, Database } from './infra/resources'

export default Cloudflare.Worker(
  'Jobs',
  {
    main: import.meta.url,
    // postgres.js needs Node's net and crypto shims.
    compatibility: { flags: ['nodejs_compat'] },
    // Derive recomputes everything hourly: about a second of CPU today, with headroom for 10x the coins.
    limits: { cpuMs: 300_000 },
  },
  Effect.gen(function* () {
    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(Database)
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bundles)

    /** One connection per run, closed when the run ends, failures logged rather than retried by the platform. */
    const run = <A, E>(name: string, job: (deps: Deps) => Effect.Effect<A, E>, summarize: (result: A) => unknown) =>
      Effect.gen(function* () {
        const runtime = yield* RuntimeContext
        const db = makeDb(Redacted.value(yield* hyperdrive.connectionString))
        const store: ObjectStore = {
          put: (key, body, options) =>
            bucket
              .put(key, body, { httpMetadata: { contentType: options.contentType, cacheControl: options.cacheControl } })
              .pipe(Effect.asVoid, Effect.provideService(RuntimeContext, runtime)),
        }
        const result = yield* job({ db, fetch: (input, init) => fetch(input, init), store }).pipe(
          Effect.ensuring(Effect.promise(() => (db.$client as { end: () => Promise<void> }).end())),
        )
        yield* Effect.log(`${name} finished`, summarize(result))
      }).pipe(Effect.catchCause(cause => Effect.logError(`${name} failed`, cause)))

    yield* Cloudflare.Workers.cron('0 * * * *', () => run('ingest', ingestHourly, result => result))
    yield* Cloudflare.Workers.cron('5 * * * *', () =>
      run('derive', deriveAndPublish, result => ({ bundles: result.bundles.length, deriveMs: result.deriveMs, prefix: result.manifest?.prefix })),
    )
    yield* Cloudflare.Workers.cron('20 0 * * *', () => run('settle', deps => settle(deps, { lookbackHours: 48 }), result => result))

    return {
      fetch: Effect.succeed(
        HttpServerResponse.text('instruments jobs: ingest at :00, derive at :05, settle daily at 00:20 UTC. Bundles are in R2.'),
      ),
    }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.Hyperdrive.ConnectBinding, Cloudflare.R2.ReadWriteBucketBinding, Cloudflare.Workers.CronEventSourceLive),
    ),
  ),
)
