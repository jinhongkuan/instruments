import { Effect, Schema } from 'effect'

import { type Fetch, SourceError, fetchJson } from './http'

// Deribit public API. No key for public methods. One get_book_summary call per
// currency returns the whole live chain with mark, mark IV, bid and ask.
// Greeks are not in it; delta is computed from mark IV (see derive/options).

const BASE = 'https://www.deribit.com/api/v2/public'

/** Currencies to sweep. USDC carries the linear (USD-quoted) chains for SOL, XRP, HYPE and others. */
export const DERIBIT_CURRENCIES = ['BTC', 'ETH', 'USDC'] as const

/**
 * Chains we keep, keyed by instrument prefix. BTC_USDC and ETH_USDC duplicate
 * the deeper inverse chains, so they are skipped.
 */
export const TRACKED_CHAINS: ReadonlyArray<string> = ['BTC', 'ETH', 'SOL_USDC', 'XRP_USDC', 'HYPE_USDC', 'AVAX_USDC', 'TRX_USDC']

/** The asset a chain prices: "SOL_USDC" → "SOL". */
export const chainAsset = (chain: string): string => chain.split('_')[0]!

const BookSummary = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({
      instrument_name: Schema.String,
      mark_price: Schema.NullOr(Schema.Number),
      mark_iv: Schema.NullOr(Schema.Number),
      bid_price: Schema.NullOr(Schema.Number),
      ask_price: Schema.NullOr(Schema.Number),
      underlying_price: Schema.NullOr(Schema.Number),
      base_currency: Schema.String,
      quote_currency: Schema.String,
      creation_timestamp: Schema.Number,
    }),
  ),
})

export interface ChainRow {
  readonly chain: string
  readonly instrumentName: string
  readonly observedAt: number
  readonly expiry: number
  readonly strike: number
  readonly type: 'call' | 'put'
  /** USD per unit of underlying; inverse (coin-quoted) prices are converted at the expiry's forward. */
  readonly markUsd: number
  readonly bidUsd: number | null
  readonly askUsd: number | null
  /** Fraction, not percent. */
  readonly markIv: number
  readonly underlyingPrice: number
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
}

/**
 * "BTC-25DEC26-104000-C" or "XRP_USDC-27NOV26-1d05-C" ("d" is the decimal
 * point). Deribit options expire at 08:00 UTC.
 */
export const parseInstrumentName = (
  name: string,
): { chain: string; expiry: number; strike: number; type: 'call' | 'put' } | null => {
  const match = /^([A-Z0-9_]+)-(\d{1,2})([A-Z]{3})(\d{2})-([0-9d.]+)-([CP])$/.exec(name)
  if (match === null) {
    return null
  }
  const [, chain, day, month, year, strike, type] = match
  const monthIndex = MONTHS[month!]
  if (monthIndex === undefined) {
    return null
  }
  return {
    chain: chain!,
    expiry: Date.UTC(2000 + Number(year), monthIndex, Number(day), 8),
    strike: Number(strike!.replace('d', '.')),
    type: type === 'C' ? 'call' : 'put',
  }
}

/** Pure: one book-summary payload to chain rows for the tracked chains. Unpriceable rows are dropped. */
export const parseBookSummary = (json: unknown): ReadonlyArray<ChainRow> => {
  const { result } = Schema.decodeUnknownSync(BookSummary)(json)
  const rows: Array<ChainRow> = []
  for (const entry of result) {
    const parsed = parseInstrumentName(entry.instrument_name)
    if (parsed === null || !TRACKED_CHAINS.includes(parsed.chain)) {
      continue
    }
    const { mark_price: mark, mark_iv: iv, underlying_price: forward } = entry
    if (mark === null || iv === null || forward === null || mark <= 0 || iv <= 0 || forward <= 0) {
      continue
    }
    // Inverse contracts are quoted in the coin they settle in.
    const toUsd = entry.quote_currency === entry.base_currency ? forward : 1
    rows.push({
      chain: parsed.chain,
      instrumentName: entry.instrument_name,
      observedAt: entry.creation_timestamp,
      expiry: parsed.expiry,
      strike: parsed.strike,
      type: parsed.type,
      markUsd: mark * toUsd,
      bidUsd: entry.bid_price === null || entry.bid_price <= 0 ? null : entry.bid_price * toUsd,
      askUsd: entry.ask_price === null || entry.ask_price <= 0 ? null : entry.ask_price * toUsd,
      markIv: iv / 100,
      underlyingPrice: forward,
    })
  }
  return rows
}

export class Deribit {
  constructor(private readonly fetchImpl: Fetch) {}

  bookSummary(currency: string): Effect.Effect<{ rows: ReadonlyArray<ChainRow>; raw: unknown }, SourceError> {
    const url = `${BASE}/get_book_summary_by_currency?currency=${encodeURIComponent(currency)}&kind=option`
    return fetchJson(this.fetchImpl, 'deribit', url, undefined, raw => ({ raw, rows: parseBookSummary(raw) }))
  }
}
