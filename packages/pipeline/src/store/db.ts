import { type Db, schema } from '@instruments/db'
import { and, eq, isNull, lt, notInArray, sql } from 'drizzle-orm'
import { Data, Effect } from 'effect'

import type { BenchmarkBlock } from '@instruments/domain'

import type { ChainPoint } from '../derive/options'
import type { ChainRow } from '../sources/deribit'
import type { CandleRow, FundingRow, PerpSnapshot } from '../sources/hyperliquid'
import type { BenchmarkRow } from '../sources/nyfed'

// ---------------------------------------------------------------------------
// Every write is a few multi-row statements, never a statement per row: each
// statement from a Worker is a network round trip. Upserts skip rows whose
// values did not change, so re-fetching overlapping hours writes nothing.
// ---------------------------------------------------------------------------

export class StoreError extends Data.TaggedError('StoreError')<{ readonly operation: string; readonly message: string }> {}

/** Drizzle wraps the driver's error; the cause ("connection refused", the constraint name) is what matters. */
const describe = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? error.cause.message || (error.cause as { code?: string }).code : undefined
  return cause === undefined ? error.message.split('\n')[0]! : `${cause} (${error.message.split('\n')[0]})`
}

const run = <A>(operation: string, f: () => Promise<A>): Effect.Effect<A, StoreError> =>
  Effect.tryPromise({
    try: f,
    catch: error => new StoreError({ operation, message: describe(error) }),
  })

/** Keep statements well under Postgres' 65,535 bind-parameter limit. */
const chunks = <T>(rows: ReadonlyArray<T>, size = 2000): ReadonlyArray<ReadonlyArray<T>> => {
  const out: Array<ReadonlyArray<T>> = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

const RETENTION_INTERVAL = sql`now() - interval '90 days'`

// Reference data ------------------------------------------------------------

export const VENUES = [
  { slug: 'hyperliquid', name: 'Hyperliquid', kind: 'perp' as const },
  { slug: 'deribit', name: 'Deribit', kind: 'option' as const },
  { slug: 'nyfed', name: 'New York Fed', kind: 'benchmark' as const },
]

export const ensureVenues = (db: Db): Effect.Effect<ReadonlyMap<string, number>, StoreError> =>
  run('ensureVenues', async () => {
    await db.insert(schema.venues).values(VENUES).onConflictDoNothing({ target: schema.venues.slug })
    const rows = await db.select({ id: schema.venues.id, slug: schema.venues.slug }).from(schema.venues)
    return new Map(rows.map(row => [row.slug, row.id]))
  })

/**
 * Make the open listings for a venue match what it lists now: open new
 * symbols, close vanished ones (validTo = now), refresh metadata. Returns
 * open listing ids by venue symbol. A ticker reused after delisting gets a
 * new row; history stays with the old one.
 */
export const reconcileListings = (
  db: Db,
  venueId: number,
  listings: ReadonlyArray<{ symbol: string; asset: string; metadata: Record<string, unknown> }>,
): Effect.Effect<ReadonlyMap<string, number>, StoreError> =>
  run('reconcileListings', () =>
    db.transaction(async tx => {
      if (listings.length > 0) {
        const assets = [...new Set(listings.map(l => l.asset))]
        await tx
          .insert(schema.assets)
          .values(assets.map(symbol => ({ symbol, name: symbol })))
          .onConflictDoNothing({ target: schema.assets.symbol })
        const assetRows = await tx.select({ id: schema.assets.id, symbol: schema.assets.symbol }).from(schema.assets)
        const assetIds = new Map(assetRows.map(row => [row.symbol, row.id]))
        await tx.execute(sql`
          insert into venue_instruments (venue_id, asset_id, venue_symbol, valid_from, metadata)
          select ${venueId}, a.asset_id, a.symbol, now(), a.metadata
          from jsonb_to_recordset(${JSON.stringify(
            listings.map(l => ({ asset_id: assetIds.get(l.asset), symbol: l.symbol, metadata: l.metadata })),
          )}::jsonb) as a(asset_id int, symbol text, metadata jsonb)
          on conflict (venue_id, venue_symbol) where valid_to is null
          do update set metadata = excluded.metadata
          where venue_instruments.metadata is distinct from excluded.metadata`)
      }
      await tx
        .update(schema.venueInstruments)
        .set({ validTo: sql`now()` })
        .where(
          and(
            eq(schema.venueInstruments.venueId, venueId),
            isNull(schema.venueInstruments.validTo),
            listings.length > 0 ? notInArray(schema.venueInstruments.venueSymbol, listings.map(l => l.symbol)) : sql`true`,
          ),
        )
      const open = await tx
        .select({ id: schema.venueInstruments.id, symbol: schema.venueInstruments.venueSymbol })
        .from(schema.venueInstruments)
        .where(and(eq(schema.venueInstruments.venueId, venueId), isNull(schema.venueInstruments.validTo)))
      return new Map(open.map(row => [row.symbol, row.id]))
    }),
  )

export const perpListings = (perps: ReadonlyArray<PerpSnapshot>, at: number) =>
  perps.map(perp => ({
    symbol: perp.coin,
    asset: perp.coin.toUpperCase(),
    metadata: {
      maxLeverage: perp.maxLeverage,
      maintenanceMarginFraction: perp.maintenanceMarginFraction,
      markPrice: perp.markPrice,
      oraclePrice: perp.oraclePrice,
      dayNotionalVolumeUsd: perp.dayNotionalVolumeUsd,
      openInterestUsd: perp.openInterestUsd,
      snapshotAt: new Date(at).toISOString(),
    },
  }))

// Time series writes -----------------------------------------------------------

/**
 * Hourly snapshot rows are provisional and never overwrite a settled hour.
 * Settled rows from the history endpoint overwrite provisional ones.
 */
export const upsertFunding = (
  db: Db,
  rows: ReadonlyArray<{ venueInstrumentId: number; row: FundingRow; oraclePrice: number | null; settled: boolean }>,
): Effect.Effect<number, StoreError> =>
  run('upsertFunding', async () => {
    let written = 0
    for (const chunk of chunks(rows)) {
      const result = await db
        .insert(schema.fundingRates)
        .values(
          chunk.map(({ venueInstrumentId, row, oraclePrice, settled }) => ({
            venueInstrumentId,
            hour: new Date(row.hour),
            rate: row.rate,
            premium: row.premium,
            oraclePrice,
            settled,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.fundingRates.venueInstrumentId, schema.fundingRates.hour],
          set: {
            rate: sql`excluded.rate`,
            premium: sql`excluded.premium`,
            oraclePrice: sql`coalesce(excluded.oracle_price, ${schema.fundingRates.oraclePrice})`,
            settled: sql`excluded.settled`,
          },
          setWhere: sql`(excluded.settled or not ${schema.fundingRates.settled})
            and (${schema.fundingRates.rate}, ${schema.fundingRates.premium}, ${schema.fundingRates.settled})
                is distinct from (excluded.rate, excluded.premium, excluded.settled)`,
        })
        .returning({ hour: schema.fundingRates.hour })
      written += result.length
    }
    return written
  })

export const upsertPrices = (
  db: Db,
  rows: ReadonlyArray<{ venueInstrumentId: number; row: CandleRow }>,
): Effect.Effect<number, StoreError> =>
  run('upsertPrices', async () => {
    let written = 0
    for (const chunk of chunks(rows)) {
      const result = await db
        .insert(schema.pricesHourly)
        .values(
          chunk.map(({ venueInstrumentId, row }) => ({
            venueInstrumentId,
            hour: new Date(row.hour),
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
          })),
        )
        .onConflictDoUpdate({
          target: [schema.pricesHourly.venueInstrumentId, schema.pricesHourly.hour],
          set: { open: sql`excluded.open`, high: sql`excluded.high`, low: sql`excluded.low`, close: sql`excluded.close` },
          setWhere: sql`(${schema.pricesHourly.open}, ${schema.pricesHourly.high}, ${schema.pricesHourly.low}, ${schema.pricesHourly.close})
            is distinct from (excluded.open, excluded.high, excluded.low, excluded.close)`,
        })
        .returning({ hour: schema.pricesHourly.hour })
      written += result.length
    }
    return written
  })

/**
 * Replace each chain's snapshot in one transaction: concurrent readers see the
 * old chain or the new one, never a mix, and are never blocked. Calls only.
 */
export const replaceChains = (
  db: Db,
  byListing: ReadonlyMap<number, ReadonlyArray<ChainRow>>,
): Effect.Effect<number, StoreError> =>
  run('replaceChains', () =>
    db.transaction(async tx => {
      const ids = [...byListing.keys()]
      if (ids.length === 0) return 0
      await tx.execute(sql`delete from latest_chain where venue_instrument_id in ${sql.raw(`(${ids.join(',')})`)}`)
      const rows = [...byListing.entries()].flatMap(([venueInstrumentId, chain]) =>
        chain
          .filter(row => row.type === 'call')
          .map(row => ({
            venueInstrumentId,
            instrumentName: row.instrumentName,
            observedAt: new Date(row.observedAt),
            expiry: new Date(row.expiry),
            strike: row.strike,
            type: row.type,
            markUsd: row.markUsd,
            bidUsd: row.bidUsd,
            askUsd: row.askUsd,
            markIv: row.markIv,
            underlyingPrice: row.underlyingPrice,
          })),
      )
      for (const chunk of chunks(rows, 1500)) {
        await tx.insert(schema.latestChain).values([...chunk])
      }
      return rows.length
    }),
  )

export const upsertAtm = (
  db: Db,
  rows: ReadonlyArray<{ venueInstrumentId: number; tenorDays: number; hour: number; iv: number; premiumFraction: number }>,
): Effect.Effect<void, StoreError> =>
  run('upsertAtm', async () => {
    if (rows.length === 0) return
    await db
      .insert(schema.atmByTenor)
      .values(rows.map(row => ({ ...row, hour: new Date(row.hour) })))
      .onConflictDoUpdate({
        target: [schema.atmByTenor.venueInstrumentId, schema.atmByTenor.tenorDays, schema.atmByTenor.hour],
        set: { iv: sql`excluded.iv`, premiumFraction: sql`excluded.premium_fraction` },
        setWhere: sql`(${schema.atmByTenor.iv}, ${schema.atmByTenor.premiumFraction}) is distinct from (excluded.iv, excluded.premium_fraction)`,
      })
  })

/** A revision overwrites the fixing it corrects and stamps revised_at; first-seen time is kept. */
export const upsertBenchmarks = (db: Db, rows: ReadonlyArray<BenchmarkRow>): Effect.Effect<void, StoreError> =>
  run('upsertBenchmarks', async () => {
    if (rows.length === 0) return
    await db
      .insert(schema.benchmarkRates)
      .values(rows.map(row => ({ source: row.source, effectiveDate: row.effectiveDate, apr: row.apr, publishedAt: new Date() })))
      .onConflictDoUpdate({
        target: [schema.benchmarkRates.source, schema.benchmarkRates.effectiveDate],
        set: { apr: sql`excluded.apr`, revisedAt: sql`now()` },
        setWhere: sql`${schema.benchmarkRates.apr} is distinct from excluded.apr`,
      })
  })

/** Rolling 90-day retention. A few hundred rows an hour: a plain DELETE, vacuum keeps up. */
export const applyRetention = (db: Db): Effect.Effect<void, StoreError> =>
  run('applyRetention', async () => {
    await db.delete(schema.fundingRates).where(lt(schema.fundingRates.hour, RETENTION_INTERVAL))
    await db.delete(schema.pricesHourly).where(lt(schema.pricesHourly.hour, RETENTION_INTERVAL))
    await db.delete(schema.atmByTenor).where(lt(schema.atmByTenor.hour, RETENTION_INTERVAL))
    await db.delete(schema.benchmarkRates).where(sql`${schema.benchmarkRates.effectiveDate} < (now() - interval '120 days')::date`)
  })

// Reads -------------------------------------------------------------------------

export interface OpenListing {
  readonly id: number
  readonly venue: string
  readonly symbol: string
  readonly asset: string
  readonly metadata: Record<string, unknown>
}

export const openListings = (db: Db, venue: string): Effect.Effect<ReadonlyArray<OpenListing>, StoreError> =>
  run('openListings', async () => {
    const rows = await db
      .select({
        id: schema.venueInstruments.id,
        venue: schema.venues.slug,
        symbol: schema.venueInstruments.venueSymbol,
        asset: schema.assets.symbol,
        metadata: schema.venueInstruments.metadata,
      })
      .from(schema.venueInstruments)
      .innerJoin(schema.venues, eq(schema.venues.id, schema.venueInstruments.venueId))
      .innerJoin(schema.assets, eq(schema.assets.id, schema.venueInstruments.assetId))
      .where(and(eq(schema.venues.slug, venue), isNull(schema.venueInstruments.validTo)))
    return rows
  })

/** Newest stored hour per listing, for gap repair: fetch only what is missing. */
export const latestHours = (db: Db, table: 'funding' | 'prices'): Effect.Effect<ReadonlyMap<number, number>, StoreError> =>
  run('latestHours', async () => {
    const t = table === 'funding' ? schema.fundingRates : schema.pricesHourly
    const where = table === 'funding' ? sql`where settled` : sql``
    const rows = await db.execute<{ id: number; hour: Date | string }>(
      sql`select venue_instrument_id as id, max(hour) as hour from ${t} ${where} group by venue_instrument_id`,
    )
    return new Map([...rows].map(row => [Number(row.id), new Date(row.hour).getTime()]))
  })

export interface DeriveSnapshot {
  readonly funding: ReadonlyMap<number, ReadonlyArray<{ hour: number; rate: number; settled: boolean }>>
  readonly prices: ReadonlyMap<number, ReadonlyArray<{ hour: number; low: number; close: number }>>
  readonly chainRows: ReadonlyMap<number, { observedAt: number; rows: ReadonlyArray<ChainPoint> }>
  readonly atmHistory: ReadonlyMap<number, ReadonlyArray<{ tenorDays: number; hour: number; iv: number; premiumFraction: number }>>
  readonly benchmark: BenchmarkBlock | null
  readonly perps: ReadonlyArray<OpenListing>
  readonly chains: ReadonlyArray<OpenListing>
}

const groupBy = <R, V>(rows: ReadonlyArray<R>, key: (row: R) => number, value: (row: R) => V): Map<number, Array<V>> => {
  const out = new Map<number, Array<V>>()
  for (const row of rows) {
    const k = key(row)
    const list = out.get(k)
    if (list === undefined) out.set(k, [value(row)])
    else list.push(value(row))
  }
  return out
}

/**
 * Everything derive needs, read inside one REPEATABLE READ, READ ONLY
 * transaction so every table reflects the same commit even if ingest runs
 * concurrently. Plain sequential scans; grouping by instrument happens here,
 * in memory, not with ORDER BY against the table's physical (hourly) order.
 */
export const loadForDerive = (db: Db): Effect.Effect<DeriveSnapshot, StoreError> =>
  run('loadForDerive', () =>
    db.transaction(
      async tx => {
        const listings = await tx
          .select({
            id: schema.venueInstruments.id,
            venue: schema.venues.slug,
            symbol: schema.venueInstruments.venueSymbol,
            asset: schema.assets.symbol,
            metadata: schema.venueInstruments.metadata,
          })
          .from(schema.venueInstruments)
          .innerJoin(schema.venues, eq(schema.venues.id, schema.venueInstruments.venueId))
          .innerJoin(schema.assets, eq(schema.assets.id, schema.venueInstruments.assetId))
          .where(isNull(schema.venueInstruments.validTo))
        const funding = await tx
          .select({ id: schema.fundingRates.venueInstrumentId, hour: schema.fundingRates.hour, rate: schema.fundingRates.rate, settled: schema.fundingRates.settled })
          .from(schema.fundingRates)
        const prices = await tx
          .select({ id: schema.pricesHourly.venueInstrumentId, hour: schema.pricesHourly.hour, low: schema.pricesHourly.low, close: schema.pricesHourly.close })
          .from(schema.pricesHourly)
        const chain = await tx.select().from(schema.latestChain)
        const atm = await tx.select().from(schema.atmByTenor)
        const [benchmark] = await tx
          .select()
          .from(schema.benchmarkRates)
          .where(eq(schema.benchmarkRates.source, 'SOFR'))
          .orderBy(sql`${schema.benchmarkRates.effectiveDate} desc`)
          .limit(1)
        const chainGroups = groupBy(chain, row => row.venueInstrumentId, row => row)
        return {
          perps: listings.filter(l => l.venue === 'hyperliquid'),
          chains: listings.filter(l => l.venue === 'deribit'),
          funding: groupBy(funding, row => row.id, row => ({ hour: row.hour.getTime(), rate: row.rate, settled: row.settled })),
          prices: groupBy(prices, row => row.id, row => ({ hour: row.hour.getTime(), low: row.low, close: row.close })),
          chainRows: new Map(
            [...chainGroups.entries()].map(([id, rows]) => [
              id,
              {
                observedAt: Math.max(...rows.map(row => row.observedAt.getTime())),
                rows: rows.map(row => ({
                  instrumentName: row.instrumentName,
                  expiry: row.expiry.getTime(),
                  strike: row.strike,
                  type: row.type,
                  markUsd: row.markUsd,
                  bidUsd: row.bidUsd,
                  askUsd: row.askUsd,
                  markIv: row.markIv,
                  underlyingPrice: row.underlyingPrice,
                })),
              },
            ]),
          ),
          atmHistory: groupBy(atm, row => row.venueInstrumentId, row => ({
            tenorDays: row.tenorDays,
            hour: row.hour.getTime(),
            iv: row.iv,
            premiumFraction: row.premiumFraction,
          })),
          benchmark:
            benchmark === undefined
              ? null
              : {
                  source: benchmark.source,
                  apr: benchmark.apr,
                  effectiveDate: benchmark.effectiveDate,
                  publishedAt: benchmark.publishedAt.toISOString(),
                },
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    ),
  )
