import { describe, expect, it } from 'vitest'

import { TickerBundle } from '@instruments/domain'
import { Schema } from 'effect'

import { buildBundles } from '../src/derive/bundle'
import { fundingWindows, maxCredibleHorizon } from '../src/derive/funding'
import { atmByTenor, callsFromChain } from '../src/derive/options'
import { realizedVol, ruinCurves } from '../src/derive/ruin'
import { HOUR_MS } from '../src/sources/http'

const filled = (n: number, value: number) => new Float64Array(n).fill(value)

describe('funding windows', () => {
  it('sums a constant rate over each horizon', () => {
    const windows = fundingWindows(filled(240, 0.0001), [1, 5])
    expect(windows[0]!.p50).toBeCloseTo(0.0024, 12)
    expect(windows[1]!.p50).toBeCloseTo(0.012, 12)
    expect(windows[0]!.windows).toBe(240 - 24 + 1)
    expect(windows[0]!.independent).toBe(10)
  })

  it('excludes windows that touch a gap', () => {
    const rates = filled(48, 0.0001)
    rates[30] = Number.NaN
    const [day] = fundingWindows(rates, [1])
    // Only starts 0..6 end before the gap at hour 30; nothing after it fits a full day.
    expect(day!.windows).toBe(7)
  })

  it('only offers horizons with three independent windows', () => {
    expect(maxCredibleHorizon(fundingWindows(filled(90 * 24, 0.0001), [7, 30, 45, 60]))).toBe(30)
  })
})

describe('ruin curves', () => {
  it('is zero when the price never moves and funding is zero', () => {
    const n = 200
    const curves = ruinCurves({ close: filled(n, 100), low: filled(n, 100), rate: filled(n, 0) }, 0.0125, [2, 10], [1, 3])
    for (const curve of curves) for (const point of curve.byHorizon) expect(point.probability).toBe(0)
  })

  it('liquidates high leverage on a 15% wick but not low leverage', () => {
    const n = 300
    const close = filled(n, 100)
    const low = filled(n, 100)
    low[150] = 85
    const curves = ruinCurves({ close, low, rate: filled(n, 0) }, 0.0125, [2, 10], [1, 7])
    const at = (lev: number, days: number) => curves.find(c => c.leverage === lev)!.byHorizon.find(p => p.days === days)!
    expect(at(2, 7).probability).toBe(0)
    expect(at(10, 1).probability).toBeGreaterThan(0)
    // Starts in the 24 hours before the wick are ruined within one day.
    expect(at(10, 1).probability * at(10, 1).starts).toBeCloseTo(24, 9)
  })

  it('funding alone drains a high-leverage position', () => {
    const n = 24 * 30
    const curves = ruinCurves({ close: filled(n, 100), low: filled(n, 100), rate: filled(n, 0.001) }, 0.0125, [20], [1, 3])
    // 1 − 1/20 − mm ≈ 0.0375 of notional buffer; 0.1%/h funding exhausts it in under two days.
    expect(curves[0]!.byHorizon.find(p => p.days === 3)!.probability).toBe(1)
    expect(curves[0]!.byHorizon.find(p => p.days === 1)!.probability).toBe(0)
  })

  it('censors starts whose window runs into missing data', () => {
    const n = 100
    const close = filled(n, 100)
    close[60] = Number.NaN
    const [curve] = ruinCurves({ close, low: filled(n, 100), rate: filled(n, 0) }, 0.0125, [5], [1])
    // Starts 0..35 see 24 clean hours before the gap; 61..75 see 24 clean hours after it.
    expect(curve!.byHorizon[0]!.starts).toBe(36 + 15)
  })

  it('realized vol is about right for a known sample', () => {
    const close = new Float64Array(2000)
    let price = 100
    let seed = 7
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < close.length; i++) {
      const z = Math.sqrt(-2 * Math.log(rand())) * Math.cos(2 * Math.PI * rand())
      price *= Math.exp(z * (0.5 / Math.sqrt(8760)))
      close[i] = price
    }
    expect(realizedVol(close)!).toBeGreaterThan(0.45)
    expect(realizedVol(close)!).toBeLessThan(0.55)
  })
})

describe('options', () => {
  const now = Date.UTC(2026, 10, 8, 5)
  const day = 86_400_000
  const row = (expiryDays: number, strike: number, iv: number) => ({
    instrumentName: `X-${expiryDays}-${strike}-C`,
    expiry: now + expiryDays * day,
    strike,
    type: 'call' as const,
    markUsd: 1000,
    bidUsd: null,
    askUsd: null,
    markIv: iv,
    underlyingPrice: 100_000,
  })

  it('computes delta from mark IV and drops expired contracts', () => {
    const calls = callsFromChain([row(30, 100_000, 0.5), row(-1, 100_000, 0.5)], now)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.delta).toBeGreaterThan(0.5)
    expect(calls[0]!.delta).toBeLessThan(0.6)
  })

  it('interpolates ATM vol in total variance between expiries', () => {
    const rows = [row(10, 90_000, 0.4), row(10, 110_000, 0.6), row(40, 90_000, 0.6), row(40, 110_000, 0.8)]
    const [t10, t25, t60] = atmByTenor(rows, now, [10, 25, 60])
    expect(t10!.iv).toBeCloseTo(0.5, 6)
    expect(t60!.iv).toBeCloseTo(0.7, 6)
    const w = 0.25 * (10 / 365) + ((25 - 10) / 30) * (0.49 * (40 / 365) - 0.25 * (10 / 365))
    expect(t25!.iv).toBeCloseTo(Math.sqrt(w / (25 / 365)), 6)
  })
})

describe('bundle assembly', () => {
  it('produces a valid bundle per ticker, including option-only assets', () => {
    const now = Date.UTC(2026, 10, 8, 5, 5)
    const hours = 24 * 10
    const start = Math.floor(now / HOUR_MS) * HOUR_MS - hours * HOUR_MS
    const funding = Array.from({ length: hours }, (_, i) => ({ hour: start + (i + 1) * HOUR_MS, rate: 0.0000125, settled: true }))
    const prices = Array.from({ length: hours }, (_, i) => ({ hour: start + i * HOUR_MS, low: 99, close: 100 }))
    const bundles = buildBundles({
      now,
      perps: [{ venueInstrumentId: 1, symbol: 'BTC', asset: 'BTC', maxLeverage: 40, maintenanceMarginFraction: 1 / 80, markPrice: 100, dayNotionalVolumeUsd: 5e8, openInterestUsd: 1e9 }],
      funding: new Map([[1, funding]]),
      prices: new Map([[1, prices]]),
      chains: [{ venueInstrumentId: 2, chain: 'SOL_USDC', asset: 'SOL' }],
      chainRows: new Map([[2, { observedAt: now, rows: [{ instrumentName: 'SOL_USDC-X-C', expiry: now + 30 * 86_400_000, strike: 150, type: 'call', markUsd: 10, bidUsd: 9, askUsd: 11, markIv: 0.8, underlyingPrice: 150 }] }]]),
      atmHistory: new Map(),
      benchmark: { source: 'SOFR', apr: 0.0392, effectiveDate: '2026-11-05', publishedAt: '2026-11-06T13:00:00.000Z' },
    })
    expect(bundles.map(b => b.ticker)).toEqual(['BTC', 'SOL'])
    for (const bundle of bundles) expect(() => Schema.decodeUnknownSync(TickerBundle)(bundle)).not.toThrow()
    const btc = bundles[0]!.perp!
    expect(btc.historyHours).toBe(hours)
    expect(btc.maxHorizonDays).toBe(3)
    expect(bundles[1]!.perp).toBeNull()
    expect(bundles[1]!.option!.calls).toHaveLength(1)
  })
})
