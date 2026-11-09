import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseBookSummary, parseInstrumentName } from '../src/sources/deribit'
import { parseCandles, parseFundingHistory, parseMetaAndAssetCtxs } from '../src/sources/hyperliquid'
import { parseSofr } from '../src/sources/nyfed'

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'))

describe('Hyperliquid (real captured payloads)', () => {
  it('keeps live perps, drops delisted ones, and derives maintenance margin from max leverage', () => {
    const perps = parseMetaAndAssetCtxs(fixture('hl_meta.json'))
    expect(perps.map(p => p.coin)).toEqual(['BTC', 'ETH', 'kPEPE'])
    const btc = perps.find(p => p.coin === 'BTC')!
    expect(btc.maxLeverage).toBe(40)
    expect(btc.maintenanceMarginFraction).toBeCloseTo(1 / 80, 12)
    expect(btc.markPrice).toBeGreaterThan(1000)
    expect(Number.isFinite(btc.fundingRate)).toBe(true)
    expect(btc.dayNotionalVolumeUsd!).toBeGreaterThan(1e6)
    expect(btc.openInterestUsd!).toBeGreaterThan(1e6)
  })

  it('keys settled funding by its settlement hour', () => {
    const rows = parseFundingHistory(fixture('hl_funding.json'))
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.hour % 3_600_000).toBe(0)
  })

  it('parses candles as numbers keyed by open hour', () => {
    const rows = parseCandles('BTC', fixture('hl_candles.json'))
    expect(rows[0]!.low).toBeLessThanOrEqual(rows[0]!.high)
    expect(rows[0]!.hour % 3_600_000).toBe(0)
  })
})

describe('Deribit (real captured payloads)', () => {
  it('parses inverse and linear instrument names, including decimal strikes', () => {
    expect(parseInstrumentName('BTC-25DEC26-104000-C')).toEqual({
      chain: 'BTC',
      expiry: Date.UTC(2026, 11, 25, 8),
      strike: 104000,
      type: 'call',
    })
    expect(parseInstrumentName('XRP_USDC-27NOV26-1d05-C')?.strike).toBe(1.05)
    expect(parseInstrumentName('BTC-PERPETUAL')).toBeNull()
  })

  it('converts coin-quoted BTC premiums to USD at the forward', () => {
    const raw = fixture('deribit_btc.json') as { result: Array<{ instrument_name: string; mark_price: number; underlying_price: number }> }
    const rows = parseBookSummary(raw)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const source = raw.result.find(entry => entry.instrument_name === row.instrumentName)!
      expect(row.chain).toBe('BTC')
      expect(row.markUsd).toBeCloseTo(source.mark_price * source.underlying_price, 9)
      expect(row.markIv).toBeLessThan(5) // fraction, not percent
    }
  })

  it('keeps USD-quoted linear chains as is and skips duplicated BTC_USDC', () => {
    const rows = parseBookSummary(fixture('deribit_usdc.json'))
    expect(new Set(rows.map(r => r.chain))).toEqual(new Set(['SOL_USDC']))
    for (const row of rows) expect(row.markUsd).toBeLessThan(row.underlyingPrice)
  })
})

describe('NY Fed', () => {
  it('reads SOFR as an annual fraction keyed by effective date', () => {
    const rows = parseSofr(fixture('nyfed_sofr.json'))
    expect(rows.length).toBe(3)
    expect(rows[0]!.apr).toBeGreaterThan(0)
    expect(rows[0]!.apr).toBeLessThan(0.2)
    expect(rows[0]!.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
