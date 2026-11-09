// End to end against a real Postgres with every source served from captured
// fixtures. Runs only when TEST_DATABASE_URL points at a disposable, migrated
// database: it truncates every table it touches.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { makeDb } from '@instruments/db'
import { MANIFEST_KEY, Manifest, TickerBundle, comparisonFromBundle } from '@instruments/domain'
import { sql } from 'drizzle-orm'
import { Effect, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { deriveAndPublish, ingestHourly, settle } from '../src/jobs'
import type { ObjectStore } from '../src/publish'
import { HOUR_MS } from '../src/sources/http'
import { Hyperliquid } from '../src/sources/hyperliquid'
import { WeightBudget } from '../src/sources/http'

const url = process.env.TEST_DATABASE_URL
const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

const NOW = Date.UTC(2026, 10, 9, 5, 2)

/** Serves fixtures; funding and candles are synthesized for the requested window so history is long enough. */
const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
  const json = (body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  if (input.includes('hyperliquid')) {
    const body = JSON.parse(String(init?.body))
    if (body.type === 'metaAndAssetCtxs') return json(fixture('hl_meta.json'))
    if (body.type === 'fundingHistory') {
      const from = Math.ceil(body.startTime / HOUR_MS) * HOUR_MS
      const rows = []
      for (let h = from; h <= body.endTime && rows.length < 500; h += HOUR_MS) {
        rows.push({ coin: body.coin, fundingRate: '0.0000125', premium: '0.0', time: h + 12 })
      }
      return json(rows)
    }
    if (body.type === 'candleSnapshot') {
      const rows = []
      for (let h = Math.ceil(body.req.startTime / HOUR_MS) * HOUR_MS; h < body.req.endTime; h += HOUR_MS) {
        const wave = 100 * (1 + 0.05 * Math.sin(h / HOUR_MS / 30))
        rows.push({ t: h, T: h + HOUR_MS - 1, o: String(wave), c: String(wave), h: String(wave * 1.01), l: String(wave * 0.98) })
      }
      return json(rows)
    }
  }
  if (input.includes('deribit')) {
    if (input.includes('currency=BTC')) return json(fixture('deribit_btc.json'))
    if (input.includes('currency=USDC')) return json(fixture('deribit_usdc.json'))
    return json({ result: [] })
  }
  if (input.includes('newyorkfed')) return json(fixture('nyfed_sofr.json'))
  return new Response('not found', { status: 404 })
}

describe.skipIf(url === undefined)('pipeline against Postgres', () => {
  const db = makeDb(url ?? '')
  const files = new Map<string, string>()
  const store: ObjectStore = { put: (key, body) => Effect.sync(() => void files.set(key, body)) }
  // No real rate limit against fixtures.
  const hyperliquid = new Hyperliquid(fakeFetch, new WeightBudget(1e12))
  const deps = { db, fetch: fakeFetch, store, now: () => NOW, hyperliquid }

  beforeAll(async () => {
    await db.execute(sql`truncate funding_rates, prices_hourly, latest_chain, atm_by_tenor, benchmark_rates, venue_instruments, assets, venues restart identity cascade`)
  })
  afterAll(async () => {
    await (db.$client as { end: () => Promise<void> }).end()
  })

  it('ingests the hourly snapshot, chains and SOFR', async () => {
    const result = await Effect.runPromise(ingestHourly(deps))
    expect(result.perps).toBe(3)
    expect(result.provisionalFundingWritten).toBe(3)
    expect(result.chains).toBe(2)
    expect(result.sofrFixings).toBe(3)
    const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from latest_chain where type = 'call'`)
    expect(row!.n).toBe(result.contracts)
  })

  it('re-running the hour writes nothing new (unchanged rows are skipped)', async () => {
    const again = await Effect.runPromise(ingestHourly(deps))
    expect(again.provisionalFundingWritten).toBe(0)
  })

  it('backfills settled funding and candles, then a repeat run is a no-op', async () => {
    const first = await Effect.runPromise(settle(deps, { lookbackHours: 90 * 24 }))
    expect(first.failures).toBe(0)
    expect(first.fundingRowsWritten).toBeGreaterThan(2000)
    const second = await Effect.runPromise(settle(deps, { lookbackHours: 48 }))
    expect(second.fundingRowsWritten).toBe(0)
    expect(second.candleRowsWritten).toBe(0)
  })

  it('a provisional hour never overwrites a settled one', async () => {
    const [row] = await db.execute<{ n: number }>(sql`select count(*)::int as n from funding_rates where not settled`)
    expect(row!.n).toBeLessThanOrEqual(3)
  })

  it('derives and publishes valid bundles with the manifest last', async () => {
    const { bundles, manifest } = await Effect.runPromise(deriveAndPublish(deps))
    expect(manifest).not.toBeNull()
    const decoded = Schema.decodeUnknownSync(Manifest)(JSON.parse(files.get(MANIFEST_KEY)!))
    expect(decoded.tickers).toEqual(bundles.map(b => b.ticker))
    expect([...files.keys()].at(-1)).toBe(MANIFEST_KEY)
    const btc = Schema.decodeUnknownSync(TickerBundle)(JSON.parse(files.get(`${decoded.prefix}/t/BTC.json`)!))
    expect(btc.perp!.historyHours).toBeGreaterThan(2000)
    expect(btc.perp!.maxHorizonDays).toBe(30)
    // Only selectable calls are published: at least 7 days out, at most ~13 months, delta of 5% or more.
    expect(btc.option).not.toBeNull()
    for (const call of btc.option!.calls) {
      const days = (Date.parse(call.expiry) - Date.parse(btc.option!.observedAt)) / 86_400_000
      expect(days).toBeGreaterThanOrEqual(7)
      expect(call.delta).toBeGreaterThanOrEqual(0.05)
    }
    expect(btc.benchmark!.source).toBe('SOFR')
    const comparison = comparisonFromBundle(btc, { ticker: 'BTC', capitalUsd: 10_000, horizonDays: 14, entryDate: '2026-11-09', leverage: 3 })
    expect(comparison.instruments[0]!.exposureMultiple).toBe(3)
    expect(comparison.instruments[0]!.ruinProbabilityByHorizon.length).toBeGreaterThan(0)
    // SOL exists only as an option chain on Deribit.
    const sol = Schema.decodeUnknownSync(TickerBundle)(JSON.parse(files.get(`${decoded.prefix}/t/SOL.json`)!))
    expect(sol.perp).toBeNull()
    expect(sol.option).not.toBeNull()
  })
})
