import {
  ATM_TENOR_DAYS,
  type AtmTenor,
  BUNDLE_VERSION,
  type BenchmarkBlock,
  DEFAULT_CONVENTIONS,
  HORIZON_BUCKET_DAYS,
  LEVERAGE_BUCKETS,
  type OptionBlock,
  type PerpBlock,
  RETENTION_DAYS,
  type SourceFreshness,
  type TickerBundle,
} from '@instruments/domain'

import { HOUR_MS, floorHour } from '../sources/http'
import { fundingWindows, maxCredibleHorizon } from './funding'
import { type ChainPoint, callsFromChain } from './options'
import { realizedVol, ruinCurves } from './ruin'
import { countFinite, gridFor, quantile, toSeries } from './series'

/** Everything derive reads, loaded in one consistent snapshot (see store/read). */
export interface DeriveInput {
  readonly now: number
  readonly perps: ReadonlyArray<{
    readonly venueInstrumentId: number
    readonly symbol: string
    readonly asset: string
    readonly maxLeverage: number
    readonly maintenanceMarginFraction: number
    readonly markPrice: number
    readonly dayNotionalVolumeUsd: number | null
    readonly openInterestUsd: number | null
  }>
  readonly funding: ReadonlyMap<number, ReadonlyArray<{ hour: number; rate: number; settled: boolean }>>
  readonly prices: ReadonlyMap<number, ReadonlyArray<{ hour: number; low: number; close: number }>>
  readonly chains: ReadonlyArray<{ readonly venueInstrumentId: number; readonly chain: string; readonly asset: string }>
  readonly chainRows: ReadonlyMap<number, { observedAt: number; rows: ReadonlyArray<ChainPoint> }>
  readonly atmHistory: ReadonlyMap<number, ReadonlyArray<{ tenorDays: number; hour: number; iv: number; premiumFraction: number }>>
  readonly benchmark: BenchmarkBlock | null
}

/**
 * Calls the dashboard can actually select: at least the convention's minimum
 * days to expiry, at most about 13 months out, and not so far out of the money
 * that the premium is noise. Cuts BTC's ~445 listed calls to the useful ones.
 */
const MIN_CALL_DELTA = 0.05
const MAX_CALL_DAYS = 400
const usableCall = (observedAt: number) => (call: { expiry: string; delta: number }): boolean => {
  const days = (Date.parse(call.expiry) - observedAt) / 86_400_000
  return call.delta >= MIN_CALL_DELTA && days >= DEFAULT_CONVENTIONS.option.minDaysToExpiry && days <= MAX_CALL_DAYS
}

/** Ruin curves stop at 30 days: beyond that, 90 days of history gives fewer than three independent windows. */
const RUIN_HORIZON_DAYS = HORIZON_BUCKET_DAYS.filter(days => days <= 30)

const perpBlock = (input: DeriveInput, perp: DeriveInput['perps'][number]): { block: PerpBlock; asOf: number | null } => {
  // The newest funding row is the provisional estimate for the hour in progress, so the grid runs one hour ahead.
  // Provisional rows are keyed by the next settlement hour, which can be up to two hours past floor(now).
  const grid = gridFor(floorHour(input.now) + 2 * HOUR_MS, RETENTION_DAYS)
  const fundingRows = input.funding.get(perp.venueInstrumentId) ?? []
  const priceRows = input.prices.get(perp.venueInstrumentId) ?? []
  const rate = toSeries(grid, fundingRows, row => row.rate)
  // Candles are keyed by open hour; funding by the settlement hour that closes it. Shift candles onto that hour.
  const shifted = priceRows.map(row => ({ ...row, hour: row.hour + HOUR_MS }))
  const close = toSeries(grid, shifted, row => row.close)
  const low = toSeries(grid, shifted, row => row.low)
  const windows = fundingWindows(rate, HORIZON_BUCKET_DAYS)
  const leverages = LEVERAGE_BUCKETS.filter(l => l <= perp.maxLeverage && 1 / l > perp.maintenanceMarginFraction)
  const latest = fundingRows.reduce<{ hour: number; rate: number; settled: boolean } | null>(
    (best, row) => (best === null || row.hour > best.hour ? row : best),
    null,
  )
  return {
    asOf: latest?.hour ?? null,
    block: {
      venue: 'Hyperliquid',
      venueSymbol: perp.symbol,
      maxLeverage: perp.maxLeverage,
      maintenanceMarginFraction: perp.maintenanceMarginFraction,
      fundingRateHourly: latest?.rate ?? 0,
      latestFundingSettled: latest?.settled ?? true,
      markPrice: perp.markPrice,
      dayNotionalVolumeUsd: perp.dayNotionalVolumeUsd,
      openInterestUsd: perp.openInterestUsd,
      historyHours: countFinite(rate),
      maxHorizonDays: maxCredibleHorizon(windows),
      fundingWindows: windows,
      ruinCurves: ruinCurves({ close, low, rate }, perp.maintenanceMarginFraction, leverages, RUIN_HORIZON_DAYS),
      realizedVol: realizedVol(close),
    },
  }
}

const optionBlock = (input: DeriveInput, chain: DeriveInput['chains'][number]): OptionBlock | null => {
  const snapshot = input.chainRows.get(chain.venueInstrumentId)
  if (snapshot === undefined || snapshot.rows.length === 0) {
    return null
  }
  const history = input.atmHistory.get(chain.venueInstrumentId) ?? []
  const atm: Array<AtmTenor> = ATM_TENOR_DAYS.flatMap(tenorDays => {
    const points = history.filter(row => row.tenorDays === tenorDays)
    const latest = points.reduce<(typeof points)[number] | null>((best, row) => (best === null || row.hour > best.hour ? row : best), null)
    if (latest === null) return []
    const ivs = points.map(row => row.iv)
    return [{
      tenorDays,
      iv: latest.iv,
      premiumFraction: latest.premiumFraction,
      ivHistory: { samples: ivs.length, p10: quantile(ivs, 0.1), p50: quantile(ivs, 0.5), p90: quantile(ivs, 0.9) },
    }]
  })
  return {
    venue: 'Deribit',
    chain: chain.chain,
    observedAt: new Date(snapshot.observedAt).toISOString(),
    calls: callsFromChain(snapshot.rows, snapshot.observedAt).filter(usableCall(snapshot.observedAt)),
    atmByTenor: atm,
  }
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** One bundle per ticker: every listed perp, plus option-only assets. Pure. */
export const buildBundles = (input: DeriveInput): ReadonlyArray<TickerBundle> => {
  const chainsByAsset = new Map(input.chains.map(chain => [chain.asset.toUpperCase(), chain]))
  const perpsByAsset = new Map(input.perps.map(perp => [perp.asset.toUpperCase(), perp]))
  const tickers = [...new Set([...perpsByAsset.keys(), ...chainsByAsset.keys()])].sort()
  return tickers.map(ticker => {
    const perp = perpsByAsset.get(ticker)
    const chain = chainsByAsset.get(ticker)
    const perpResult = perp === undefined ? null : perpBlock(input, perp)
    const option = chain === undefined ? null : optionBlock(input, chain)
    const sources: Array<SourceFreshness> = []
    if (perpResult?.asOf != null) sources.push({ source: 'hyperliquid', asOf: iso(perpResult.asOf) })
    if (option !== null) sources.push({ source: 'deribit', asOf: option.observedAt })
    if (input.benchmark !== null) sources.push({ source: 'nyfed', asOf: input.benchmark.publishedAt })
    return {
      version: BUNDLE_VERSION,
      ticker,
      generatedAt: iso(input.now),
      conventionsVersion: DEFAULT_CONVENTIONS.version,
      perp: perpResult?.block ?? null,
      option,
      benchmark: input.benchmark,
      sources,
    }
  })
}
