import { type Db } from '@instruments/db'
import { ATM_TENOR_DAYS, type Manifest, RETENTION_DAYS } from '@instruments/domain'
import { Effect, Result } from 'effect'

import { type DeriveInput, buildBundles } from './derive/bundle'
import { atmByTenor } from './derive/options'
import { type ObjectStore, PublishError, landRaw, publishBundles } from './publish'
import { type ChainRow, DERIBIT_CURRENCIES, Deribit, chainAsset } from './sources/deribit'
import { type Fetch, HOUR_MS, SourceError, floorHour } from './sources/http'
import { Hyperliquid } from './sources/hyperliquid'
import { NyFed } from './sources/nyfed'
import {
  StoreError,
  applyRetention,
  ensureVenues,
  latestHours,
  loadForDerive,
  openListings,
  perpListings,
  reconcileListings,
  replaceChains,
  upsertAtm,
  upsertBenchmarks,
  upsertFunding,
  upsertPrices,
} from './store/db'

export interface Deps {
  readonly db: Db
  readonly fetch: Fetch
  /** Null skips raw landing and publishing (tests, dry runs). */
  readonly store: ObjectStore | null
  readonly now?: () => number
  /** Shared so every Hyperliquid call in a process draws on one per-IP budget. */
  readonly hyperliquid?: Hyperliquid
}

const clock = (deps: Deps) => deps.now ?? Date.now

/**
 * Every hour at :00. One Hyperliquid call for every coin (provisional funding,
 * listings, leverage caps), one Deribit call per currency (whole chains), the
 * SOFR fixings, then the 90-day retention delete. About 5 source calls.
 */
export const ingestHourly = (deps: Deps) =>
  Effect.gen(function* () {
    const now = clock(deps)()
    const venues = yield* ensureVenues(deps.db)
    const hl = deps.hyperliquid ?? new Hyperliquid(deps.fetch)

    const snapshot = yield* hl.snapshot()
    yield* landRaw(deps.store, now, 'hyperliquid', snapshot.raw)
    const perpIds = yield* reconcileListings(deps.db, venues.get('hyperliquid')!, perpListings(snapshot.perps, now))
    const provisionalHour = floorHour(now) + HOUR_MS
    const provisional = yield* upsertFunding(
      deps.db,
      snapshot.perps.flatMap(perp => {
        const id = perpIds.get(perp.coin)
        return id === undefined
          ? []
          : [{ venueInstrumentId: id, row: { coin: perp.coin, hour: provisionalHour, rate: perp.fundingRate, premium: perp.premium }, oraclePrice: perp.oraclePrice, settled: false }]
      }),
    )

    const deribit = new Deribit(deps.fetch)
    const sweeps = yield* Effect.forEach(DERIBIT_CURRENCIES, currency =>
      deribit.bookSummary(currency).pipe(
        Effect.tap(({ raw }) => landRaw(deps.store, now, `deribit-${currency}`, raw)),
        Effect.result,
      ),
    )
    const chainRows: Array<ChainRow> = sweeps.flatMap(result => (Result.isSuccess(result) ? result.success.rows : []))
    const failed = sweeps.filter(Result.isFailure)
    for (const failure of failed) yield* Effect.logWarning(`deribit sweep failed: ${failure.failure.message}`)
    const present = [...new Set(chainRows.map(row => row.chain))]
    // A failed currency must not close its chains' listings; keep whatever is open.
    const keep = failed.length > 0 ? (yield* openListings(deps.db, 'deribit')).map(l => l.symbol) : []
    const chainIds = yield* reconcileListings(
      deps.db,
      venues.get('deribit')!,
      [...new Set([...present, ...keep])].map(chain => ({ symbol: chain, asset: chainAsset(chain), metadata: {} })),
    )
    const byListing = new Map<number, Array<ChainRow>>()
    for (const row of chainRows) {
      const id = chainIds.get(row.chain)
      if (id === undefined) continue
      const list = byListing.get(id) ?? []
      list.push(row)
      byListing.set(id, list)
    }
    const contracts = yield* replaceChains(deps.db, byListing)
    yield* upsertAtm(
      deps.db,
      [...byListing.entries()].flatMap(([venueInstrumentId, rows]) => {
        const observedAt = Math.max(...rows.map(row => row.observedAt))
        return atmByTenor(rows, observedAt, ATM_TENOR_DAYS).map(point => ({ venueInstrumentId, hour: floorHour(now), ...point }))
      }),
    )

    const sofr = yield* new NyFed(deps.fetch).sofr(10).pipe(Effect.result)
    if (Result.isSuccess(sofr)) yield* upsertBenchmarks(deps.db, sofr.success)
    else yield* Effect.logWarning(`SOFR fetch failed: ${sofr.failure.message}`)

    yield* applyRetention(deps.db)
    return {
      perps: snapshot.perps.length,
      provisionalFundingWritten: provisional,
      chains: byListing.size,
      contracts,
      sofrFixings: Result.isSuccess(sofr) ? sofr.success.length : 0,
    }
  })

/**
 * Settled funding and closed hourly candles per coin, from the hour after
 * the newest stored row (or `lookbackHours` back, whichever is earlier), never
 * further than the retention window. Daily in production; with a 90-day
 * lookback it is the backfill, and after an outage it is the gap repair.
 */
export const settle = (deps: Deps, options: { lookbackHours?: number; coins?: ReadonlyArray<string> } = {}) =>
  Effect.gen(function* () {
    const now = clock(deps)()
    const hl = deps.hyperliquid ?? new Hyperliquid(deps.fetch)
    const lookback = (options.lookbackHours ?? 48) * HOUR_MS
    const floor = floorHour(now) - RETENTION_DAYS * 24 * HOUR_MS
    const listings = (yield* openListings(deps.db, 'hyperliquid')).filter(
      l => options.coins === undefined || options.coins.includes(l.symbol) || options.coins.includes(l.asset),
    )
    const lastFunding = yield* latestHours(deps.db, 'funding')
    const lastPrice = yield* latestHours(deps.db, 'prices')
    const startFor = (last: number | undefined) => Math.max(floor, Math.min(now - lookback, last === undefined ? floor : last + HOUR_MS))
    let funding = 0
    let candles = 0
    let failures = 0
    yield* Effect.forEach(
      listings,
      listing =>
        Effect.gen(function* () {
          const rates = yield* hl.fundingHistory(listing.symbol, startFor(lastFunding.get(listing.id)), now)
          funding += yield* upsertFunding(
            deps.db,
            rates.map(row => ({ venueInstrumentId: listing.id, row, oraclePrice: null, settled: true })),
          )
          const bars = yield* hl.candles(listing.symbol, startFor(lastPrice.get(listing.id)), floorHour(now))
          candles += yield* upsertPrices(deps.db, bars.map(row => ({ venueInstrumentId: listing.id, row })))
        }).pipe(
          Effect.catch(error =>
            Effect.sync(() => {
              failures++
            }).pipe(Effect.andThen(Effect.logWarning(`settle ${listing.symbol} failed: ${error.message}`))),
          ),
        ),
      { discard: true },
    )
    return { coins: listings.length, fundingRowsWritten: funding, candleRowsWritten: candles, failures }
  })

/** Every hour at :05. Read one snapshot, build every bundle, publish them, manifest last. */
export const deriveAndPublish = (deps: Deps) =>
  Effect.gen(function* () {
    const now = clock(deps)()
    const snapshot = yield* loadForDerive(deps.db)
    const input: DeriveInput = {
      now,
      perps: snapshot.perps.flatMap(listing => {
        const meta = listing.metadata as {
          maxLeverage?: number
          maintenanceMarginFraction?: number
          markPrice?: number
          dayNotionalVolumeUsd?: number | null
          openInterestUsd?: number | null
        }
        return meta.maxLeverage === undefined || meta.maintenanceMarginFraction === undefined
          ? []
          : [{
              venueInstrumentId: listing.id,
              symbol: listing.symbol,
              asset: listing.asset,
              maxLeverage: meta.maxLeverage,
              maintenanceMarginFraction: meta.maintenanceMarginFraction,
              markPrice: meta.markPrice ?? 0,
              dayNotionalVolumeUsd: meta.dayNotionalVolumeUsd ?? null,
              openInterestUsd: meta.openInterestUsd ?? null,
            }]
      }),
      funding: snapshot.funding,
      prices: snapshot.prices,
      chains: snapshot.chains.map(listing => ({ venueInstrumentId: listing.id, chain: listing.symbol, asset: listing.asset })),
      chainRows: snapshot.chainRows,
      atmHistory: snapshot.atmHistory,
      benchmark: snapshot.benchmark,
    }
    const started = Date.now()
    const bundles = buildBundles(input)
    const deriveMs = Date.now() - started
    const manifest: Manifest | null = deps.store === null ? null : yield* publishBundles(deps.store, bundles, now)
    return { bundles, manifest, deriveMs }
  })

export type JobError = SourceError | StoreError | PublishError
