import { Effect, Schema } from 'effect'

import { type Fetch, HOUR_MS, SourceError, WeightBudget, fetchJson, floorHour, num } from './http'

// Hyperliquid info API (https://api.hyperliquid.xyz/info). Public, no key.
// Weight: 20 per call, plus 1 per 20 rows for fundingHistory and 1 per 60
// candles for candleSnapshot. Budget: 1,200 weight per minute per IP.

const URL = 'https://api.hyperliquid.xyz/info'
export const HL_WEIGHT_PER_MINUTE = 1200

const Universe = Schema.Struct({
  name: Schema.String,
  maxLeverage: Schema.Number,
  marginTableId: Schema.optional(Schema.Number),
  isDelisted: Schema.optional(Schema.Boolean),
})

const MarginTable = Schema.Tuple([
  Schema.Number,
  Schema.Struct({
    marginTiers: Schema.Array(Schema.Struct({ lowerBound: Schema.String, maxLeverage: Schema.Number })),
  }),
])

const AssetCtx = Schema.Struct({
  funding: Schema.String,
  dayNtlVlm: Schema.optional(Schema.String),
  openInterest: Schema.optional(Schema.String),
  markPx: Schema.NullOr(Schema.String),
  oraclePx: Schema.NullOr(Schema.String),
  premium: Schema.NullOr(Schema.String),
})

const MetaAndAssetCtxs = Schema.Tuple([
  Schema.Struct({ universe: Schema.Array(Universe), marginTables: Schema.optional(Schema.Array(MarginTable)) }),
  Schema.Array(AssetCtx),
])

const FundingHistory = Schema.Array(
  Schema.Struct({ coin: Schema.String, fundingRate: Schema.String, premium: Schema.NullOr(Schema.String), time: Schema.Number }),
)

const Candles = Schema.Array(
  Schema.Struct({ t: Schema.Number, o: Schema.String, h: Schema.String, l: Schema.String, c: Schema.String }),
)

/** One live perp from the all-coin snapshot. */
export interface PerpSnapshot {
  readonly coin: string
  readonly maxLeverage: number
  /** Hyperliquid maintenance margin is half the initial margin at max leverage. */
  readonly maintenanceMarginFraction: number
  /** Current hourly funding estimate (fraction of notional), paid at the next hour boundary. */
  readonly fundingRate: number
  readonly premium: number | null
  readonly markPrice: number
  readonly oraclePrice: number
  /** USD notional traded in the last 24 hours; the liquidity signal shown on the card. */
  readonly dayNotionalVolumeUsd: number | null
  readonly openInterestUsd: number | null
}

export interface FundingRow {
  readonly coin: string
  /** Settlement hour (ms): the funding paid at this boundary covers the hour before it. */
  readonly hour: number
  readonly rate: number
  readonly premium: number | null
}

export interface CandleRow {
  readonly coin: string
  /** Candle open (ms). */
  readonly hour: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
}

/** Pure: snapshot payload to live perps. Delisted coins are dropped. */
export const parseMetaAndAssetCtxs = (json: unknown): ReadonlyArray<PerpSnapshot> => {
  const [meta, ctxs] = Schema.decodeUnknownSync(MetaAndAssetCtxs)(json)
  const tables = new Map((meta.marginTables ?? []).map(([id, table]) => [id, table.marginTiers]))
  const out: Array<PerpSnapshot> = []
  meta.universe.forEach((asset, index) => {
    const ctx = ctxs[index]
    if (asset.isDelisted === true || ctx === undefined || ctx.markPx === null || ctx.oraclePx === null) {
      return
    }
    // The lowest tier governs small positions, the market-wide reference.
    const firstTier = asset.marginTableId === undefined ? undefined : tables.get(asset.marginTableId)?.[0]
    const maxLeverage = Math.min(asset.maxLeverage, firstTier?.maxLeverage ?? asset.maxLeverage)
    out.push({
      coin: asset.name,
      maxLeverage,
      maintenanceMarginFraction: 1 / (2 * maxLeverage),
      fundingRate: num(ctx.funding),
      premium: ctx.premium === null ? null : num(ctx.premium),
      markPrice: num(ctx.markPx),
      oraclePrice: num(ctx.oraclePx),
      dayNotionalVolumeUsd: ctx.dayNtlVlm === undefined ? null : num(ctx.dayNtlVlm),
      openInterestUsd: ctx.openInterest === undefined ? null : num(ctx.openInterest) * num(ctx.markPx),
    })
  })
  return out
}

export const parseFundingHistory = (json: unknown): ReadonlyArray<FundingRow> =>
  Schema.decodeUnknownSync(FundingHistory)(json).map(row => ({
    coin: row.coin,
    hour: floorHour(row.time),
    rate: num(row.fundingRate),
    premium: row.premium === null ? null : num(row.premium),
  }))

export const parseCandles = (coin: string, json: unknown): ReadonlyArray<CandleRow> =>
  Schema.decodeUnknownSync(Candles)(json).map(row => ({
    coin,
    hour: row.t,
    open: num(row.o),
    high: num(row.h),
    low: num(row.l),
    close: num(row.c),
  }))

const post = (fetchImpl: Fetch, body: unknown) => ({
  fetchImpl,
  init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } as RequestInit,
})

export class Hyperliquid {
  constructor(
    private readonly fetchImpl: Fetch,
    readonly budget: WeightBudget = new WeightBudget(HL_WEIGHT_PER_MINUTE),
  ) {}

  /** One call for every coin: current funding estimate, mark, oracle, leverage caps. Weight 20. */
  snapshot(): Effect.Effect<{ perps: ReadonlyArray<PerpSnapshot>; raw: unknown }, SourceError> {
    const { init } = post(this.fetchImpl, { type: 'metaAndAssetCtxs' })
    return this.budget.take(20).pipe(
      Effect.andThen(fetchJson(this.fetchImpl, 'hyperliquid', URL, init, raw => ({ raw, perps: parseMetaAndAssetCtxs(raw) }))),
    )
  }

  /** Settled hourly funding for one coin over [start, end), paging 500 rows at a time. */
  fundingHistory(coin: string, startMs: number, endMs: number): Effect.Effect<ReadonlyArray<FundingRow>, SourceError> {
    const page = (from: number): Effect.Effect<ReadonlyArray<FundingRow>, SourceError> => {
      const { init } = post(this.fetchImpl, { type: 'fundingHistory', coin, startTime: from, endTime: endMs })
      return this.budget.take(45).pipe(
        Effect.andThen(fetchJson(this.fetchImpl, 'hyperliquid', URL, init, parseFundingHistory)),
        Effect.flatMap(rows => {
          const last = rows[rows.length - 1]
          if (rows.length < 500 || last === undefined || last.hour + HOUR_MS >= endMs) {
            return Effect.succeed(rows)
          }
          return page(last.hour + HOUR_MS).pipe(Effect.map(rest => [...rows, ...rest]))
        }),
      )
    }
    return page(startMs)
  }

  /** Hourly candles for one coin. The API keeps the latest 5,000, about 208 days: enough for 90-day retention. */
  candles(coin: string, startMs: number, endMs: number): Effect.Effect<ReadonlyArray<CandleRow>, SourceError> {
    const { init } = post(this.fetchImpl, { type: 'candleSnapshot', req: { coin, interval: '1h', startTime: startMs, endTime: endMs } })
    const weight = 20 + Math.ceil((endMs - startMs) / HOUR_MS / 60)
    return this.budget.take(weight).pipe(
      Effect.andThen(fetchJson(this.fetchImpl, 'hyperliquid', URL, init, json => parseCandles(coin, json))),
      // The last candle is still open; keep only closed hours.
      Effect.map(rows => rows.filter(row => row.hour + HOUR_MS <= endMs)),
    )
  }
}
