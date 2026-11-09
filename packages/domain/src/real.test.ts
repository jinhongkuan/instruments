import { Option } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { OptionBlock, PerpBlock, TickerBundle } from './bundle'
import { atmPremiumFraction, callDelta, callPrice, probabilityExpiresOtm } from './instrument/blackScholes'
import { comparisonFromBundle, fundingAt, interpolate, ruinAt } from './real'
import type { Scenario } from './schema'

const perp: PerpBlock = {
  venue: 'Hyperliquid',
  venueSymbol: 'BTC',
  maxLeverage: 40,
  maintenanceMarginFraction: 0.0125,
  fundingRateHourly: 0.0000125,
  latestFundingSettled: true,
  markPrice: 75_000,
  dayNotionalVolumeUsd: 2_200_000_000,
  openInterestUsd: 3_100_000_000,
  historyHours: 2160,
  maxHorizonDays: 30,
  fundingWindows: [
    { horizonDays: 7, windows: 1992, independent: 12, p10: 0.0005, p50: 0.002, p90: 0.004 },
    { horizonDays: 30, windows: 1440, independent: 3, p10: 0.003, p50: 0.009, p90: 0.015 },
    { horizonDays: 60, windows: 720, independent: 1, p10: 0.01, p50: 0.02, p90: 0.03 },
  ],
  ruinCurves: [
    { leverage: 5, byHorizon: [{ days: 7, probability: 0.02, starts: 1992 }, { days: 30, probability: 0.1, starts: 1440 }] },
    { leverage: 10, byHorizon: [{ days: 7, probability: 0.1, starts: 1992 }, { days: 30, probability: 0.4, starts: 1440 }] },
  ],
  realizedVol: 0.5,
}

const OBSERVED = '2026-11-08T05:00:00.000Z'
const expiryIn = (days: number) => new Date(Date.parse(OBSERVED) + days * 86_400_000).toISOString()
const call = (strike: number, days: number) => {
  const forward = 75_000
  const iv = 0.45
  const years = days / 365
  return {
    instrumentName: `BTC-${days}D-${strike}-C`,
    expiry: expiryIn(days),
    strike,
    premiumUsd: callPrice(forward, strike, years, iv),
    bidUsd: callPrice(forward, strike, years, iv) * 0.98,
    askUsd: callPrice(forward, strike, years, iv) * 1.02,
    iv,
    delta: callDelta(forward, strike, years, iv),
    underlyingPrice: forward,
  }
}
const option: OptionBlock = {
  venue: 'Deribit',
  chain: 'BTC',
  observedAt: OBSERVED,
  calls: [50_000, 60_000, 70_000, 75_000, 80_000, 90_000].flatMap(k => [call(k, 9), call(k, 37), call(k, 100)]),
  atmByTenor: [{ tenorDays: 30, iv: 0.45, premiumFraction: 0.05, ivHistory: { samples: 500, p10: 0.38, p50: 0.45, p90: 0.55 } }],
}

const bundle: TickerBundle = {
  version: 1,
  ticker: 'BTC',
  generatedAt: OBSERVED,
  conventionsVersion: '2026-11-v1',
  perp,
  option,
  benchmark: { source: 'SOFR', apr: 0.0392, effectiveDate: '2026-11-05', publishedAt: '2026-11-06T13:00:00Z' },
  sources: [],
}

const scenario: Scenario = { ticker: 'BTC', capitalUsd: 10_000, horizonDays: 14, entryDate: OBSERVED, leverage: 5 }

describe('Black-76', () => {
  it('prices an ATM call near 0.4 σ√T of the forward', () => {
    expect(callPrice(100, 100, 1, 0.2) / 100).toBeCloseTo(0.4 * 0.2, 2)
    expect(atmPremiumFraction(1, 0.2)).toBeCloseTo(callPrice(100, 100, 1, 0.2) / 100, 6)
  })

  it('ATM delta is just above one half and OTM probability just above one half', () => {
    expect(callDelta(100, 100, 0.25, 0.5)).toBeGreaterThan(0.5)
    expect(probabilityExpiresOtm(100, 100, 0.25, 0.5)).toBeGreaterThan(0.5)
  })

  it('is intrinsic value at expiry', () => {
    expect(callPrice(120, 100, 0, 0.5)).toBe(20)
    expect(callPrice(80, 100, 0, 0.5)).toBe(0)
  })
})

describe('interpolation helpers', () => {
  it('clamps outside the range', () => {
    expect(interpolate([1, 2], [10, 20], 0)).toBe(10)
    expect(interpolate([1, 2], [10, 20], 5)).toBe(20)
    expect(interpolate([1, 2], [10, 20], 1.5)).toBe(15)
  })

  it('funding quantiles ignore horizons without enough independent windows', () => {
    const at = fundingAt(perp.fundingWindows, 60)
    expect(at._tag).toBe('Some')
    if (at._tag === 'Some') expect(at.value.p50).toBe(0.009)
  })

  it('ruin is zero at 1x and grows with leverage', () => {
    expect(ruinAt(perp.ruinCurves, 1, 30)).toBe(0)
    expect(ruinAt(perp.ruinCurves, 7.5, 30)).toBeCloseTo(0.25, 6)
    fc.assert(
      fc.property(fc.double({ min: 1, max: 40, noNaN: true }), fc.double({ min: 1, max: 40, noNaN: true }), (a, b) => {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        return ruinAt(perp.ruinCurves, lo, 14) <= ruinAt(perp.ruinCurves, hi, 14) + 1e-12
      }),
    )
  })
})

describe('comparison from a real bundle', () => {
  const comparison = comparisonFromBundle(bundle, scenario)
  const [perpResult, borrow, optionResult] = comparison.instruments

  it('is not synthetic and has one result per instrument', () => {
    expect(comparison.synthetic).toBe(false)
    expect(comparison.instruments.map(r => r.kind)).toEqual(['Perp', 'SpotBorrow', 'Option'])
  })

  it('perp carry band is the funding quantiles times leverage, as percent of capital', () => {
    const q = fundingAt(perp.fundingWindows, 14)
    if (q._tag !== 'Some') throw new Error('expected funding')
    expect(perpResult!.carryBand.mid).toBeCloseTo(q.value.p50 * 5 * 100, 9)
    expect(perpResult!.carryBand.low).toBeLessThanOrEqual(perpResult!.carryBand.high)
  })

  it('perp payoff is wiped out below the liquidation ratio', () => {
    const liq = (1 - 1 / 5) / (1 - 0.0125)
    for (const point of perpResult!.payoffAtHorizon) {
      if (point.terminalPriceRatio <= liq) expect(point.mid).toBe(-100)
    }
  })

  it('benchmark carry is the rate on the borrowed leg', () => {
    expect(borrow!.carryBand.mid).toBeCloseTo(0.0392 * 4 * (14 / 365) * 100, 9)
    expect(borrow!.ruinProbabilityByHorizon.every(p => p.value === 0)).toBe(true)
  })

  it('option holds a contract that outlives the horizon, so it cannot be wiped out before then', () => {
    expect(optionResult!.exposureMultiple).toBeGreaterThan(0)
    expect(optionResult!.venue).toMatch(/2026-12-15|2027-02-16/)
    expect(optionResult!.ruinProbabilityByHorizon.filter(p => p.day <= 14).every(p => p.value === 0)).toBe(true)
    expect(optionResult!.carryBand.mid).toBeGreaterThan(0)
  })

  it('payoff bands are ordered for every instrument and price', () => {
    for (const result of comparison.instruments) {
      for (const point of result.payoffAtHorizon) {
        expect(point.low).toBeLessThanOrEqual(point.mid + 1e-9)
        expect(point.mid).toBeLessThanOrEqual(point.high + 1e-9)
      }
    }
  })

  it('says where each number comes from, and flags thin trading', () => {
    expect(perpResult!.source.text).toMatch(/Hyperliquid BTC perpetual/)
    expect(perpResult!.source.lowLiquidity._tag).toBe('None')
    expect(borrow!.source.text).toMatch(/SOFR from the New York Fed/)
    const thinPerp = comparisonFromBundle({ ...bundle, perp: { ...perp, dayNotionalVolumeUsd: 250_000 } }, scenario).instruments[0]!
    expect(Option.getOrUndefined(thinPerp.source.lowLiquidity)).toBe('only $250k traded in the last 24h')
  })

  it('flags an option whose selected contract has a wide or one-sided quote', () => {
    const oneSided = { ...option, calls: option.calls.map(c => ({ ...c, bidUsd: null })) }
    const result = comparisonFromBundle({ ...bundle, option: oneSided }, scenario).instruments[2]!
    expect(result.source.lowLiquidity._tag).toBe('Some')
  })

  it('a ticker with no perp or options says so instead of inventing data', () => {
    const bare = comparisonFromBundle({ ...bundle, perp: null, option: null }, scenario)
    expect(bare.instruments[0]!.resolved._tag).toBe('Unattainable')
    expect(bare.instruments[0]!.exposureMultiple).toBe(0)
    expect(bare.instruments[2]!.resolved._tag).toBe('Unattainable')
  })
})
