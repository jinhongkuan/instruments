// Local runner: the same jobs the cron Worker runs, against DATABASE_URL, with
// bundles written to a directory the dev server serves.
//
//   pnpm --filter @instruments/pipeline cli ingest
//   pnpm --filter @instruments/pipeline cli backfill [--coins BTC,ETH] [--days 90]
//   pnpm --filter @instruments/pipeline cli settle   [--coins BTC] [--lookback-hours 48]
//   pnpm --filter @instruments/pipeline cli derive   [--out ../../apps/web/.bundles]
//   pnpm --filter @instruments/pipeline cli all      [--coins BTC,ETH,SOL]
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeDb } from '@instruments/db'
import { Effect } from 'effect'

import { type Deps, deriveAndPublish, ingestHourly, settle } from './jobs'
import type { ObjectStore } from './publish'
import { Hyperliquid } from './sources/hyperliquid'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_OUT = resolve(here, '../../../apps/web/.bundles')

const directoryStore = (root: string): ObjectStore => ({
  put: (key, body) =>
    Effect.tryPromise(async () => {
      const path = join(root, key)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, body)
    }),
})

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const main = async () => {
  const command = process.argv[2] ?? 'help'
  const url = process.env.DATABASE_URL ?? 'postgres://instruments:instruments@localhost:5433/instruments'
  const db = makeDb(url)
  const out = resolve(arg('out') ?? process.env.BUNDLES_DIR ?? DEFAULT_OUT)
  const coins = arg('coins')?.split(',').map(c => c.trim()).filter(c => c.length > 0)
  const deps: Deps = { db, fetch: globalThis.fetch, store: directoryStore(out), hyperliquid: new Hyperliquid(globalThis.fetch) }
  const backfill = settle(deps, { lookbackHours: Number(arg('days') ?? 90) * 24, ...(coins ? { coins } : {}) })
  const derive = deriveAndPublish(deps).pipe(
    Effect.map(({ bundles, manifest, deriveMs }) => ({ bundles: bundles.length, deriveMs, manifest: manifest?.prefix, out })),
  )
  const programs: Record<string, Effect.Effect<unknown, unknown>> = {
    ingest: ingestHourly(deps),
    settle: settle(deps, { lookbackHours: Number(arg('lookback-hours') ?? 48), ...(coins ? { coins } : {}) }),
    backfill,
    derive,
    all: Effect.gen(function* () {
      const ingest = yield* ingestHourly(deps)
      const filled = yield* backfill
      const derived = yield* derive
      return { ingest, filled, derived }
    }),
  }
  const program = programs[command]
  if (program === undefined) {
    console.log('usage: cli <ingest|settle|backfill|derive|all> [--coins BTC,ETH] [--days 90] [--out dir]')
    process.exit(command === 'help' ? 0 : 1)
  }
  const started = Date.now()
  try {
    const result = await Effect.runPromise(program)
    console.log(JSON.stringify(result, null, 2))
    console.log(`${command} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } finally {
    await (db.$client as { end: () => Promise<void> }).end()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
