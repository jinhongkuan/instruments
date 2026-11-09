import { Data, Effect, Schema } from 'effect'

import { BUNDLE_VERSION, MANIFEST_KEY, type Manifest, TickerBundle, bundleKey } from '@instruments/domain'

import { floorHour } from './sources/http'

/** Where bundles go: R2 in production (an Effect binding), a directory locally. */
export interface ObjectStore {
  readonly put: (
    key: string,
    body: string,
    options: { contentType: string; cacheControl: string },
  ) => Effect.Effect<void, unknown>
}

export class PublishError extends Data.TaggedError('PublishError')<{ readonly key: string; readonly message: string }> {}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const SHORT = 'public, max-age=60'

/** "v/2026-11-08T05": one folder per derive hour, so a new hour never overwrites a cached file. */
export const hourPrefix = (now: number): string => `v/${new Date(floorHour(now)).toISOString().slice(0, 13)}`

const put = (store: ObjectStore, key: string, body: string, cacheControl: string) =>
  store
    .put(key, body, { contentType: 'application/json', cacheControl })
    .pipe(Effect.mapError(error => new PublishError({ key, message: error instanceof Error ? error.message : String(error) })))

const encodeBundle = Schema.encodeSync(TickerBundle)

/** Six significant digits is far below any displayed precision and roughly halves the JSON. */
const compact = (_key: string, value: unknown): unknown =>
  typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(6)) : value

/**
 * Write every bundle under this hour's prefix, then the manifest last, so the
 * manifest only ever points at a complete set. If any bundle fails, the
 * manifest is not written and viewers keep the previous hour.
 */
export const publishBundles = (
  store: ObjectStore,
  bundles: ReadonlyArray<TickerBundle>,
  now: number,
): Effect.Effect<Manifest, PublishError> =>
  Effect.gen(function* () {
    const prefix = hourPrefix(now)
    yield* Effect.forEach(
      bundles,
      bundle => put(store, bundleKey(prefix, bundle.ticker), JSON.stringify(encodeBundle(bundle), compact), IMMUTABLE),
      { concurrency: 16, discard: true },
    )
    const manifest: Manifest = {
      version: BUNDLE_VERSION,
      generatedAt: new Date(now).toISOString(),
      prefix,
      tickers: bundles.map(bundle => bundle.ticker),
    }
    yield* put(store, MANIFEST_KEY, JSON.stringify(manifest), SHORT)
    return manifest
  })

/** Raw responses, kept 90 days (bucket lifecycle rule) so a decoder change can be replayed. */
export const landRaw = (store: ObjectStore | null, now: number, source: string, raw: unknown): Effect.Effect<void> =>
  store === null
    ? Effect.void
    : put(store, `raw/${new Date(floorHour(now)).toISOString().slice(0, 13)}/${source}.json`, JSON.stringify(raw), 'private, max-age=0').pipe(
        Effect.catch(error => Effect.logWarning(`raw landing failed for ${source}: ${error.message}`)),
      )
