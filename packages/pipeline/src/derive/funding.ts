import { type FundingWindow, MIN_INDEPENDENT_WINDOWS } from '@instruments/domain'

import { quantile } from './series'

/**
 * Realized funding over every window of each horizon, as a fraction of
 * notional paid by a long. Prefix sums make each horizon O(N); at 90 days ×
 * ~200 coins the full rebuild is about a second, so nothing is incremental.
 */
export const fundingWindows = (rates: Float64Array, horizonsDays: ReadonlyArray<number>): ReadonlyArray<FundingWindow> => {
  const n = rates.length
  const sum = new Float64Array(n + 1)
  const gaps = new Int32Array(n + 1)
  for (let i = 0; i < n; i++) {
    const missing = Number.isNaN(rates[i]!)
    sum[i + 1] = sum[i]! + (missing ? 0 : rates[i]!)
    gaps[i + 1] = gaps[i]! + (missing ? 1 : 0)
  }
  return horizonsDays.map(days => {
    const hours = days * 24
    const values: Array<number> = []
    for (let i = 0; i + hours <= n; i++) {
      if (gaps[i + hours]! - gaps[i]! === 0) {
        values.push(sum[i + hours]! - sum[i]!)
      }
    }
    const windows = values.length
    return {
      horizonDays: days,
      windows,
      // Without gaps, windows = N − H + 1, so this is ⌊N / H⌋ non-overlapping windows.
      independent: windows === 0 ? 0 : Math.floor((windows + hours - 1) / hours),
      p10: windows === 0 ? 0 : quantile(values, 0.1),
      p50: windows === 0 ? 0 : quantile(values, 0.5),
      p90: windows === 0 ? 0 : quantile(values, 0.9),
    }
  })
}

/** Longest horizon with enough independent windows to quote a band; at least 1 day. */
export const maxCredibleHorizon = (windows: ReadonlyArray<FundingWindow>): number =>
  Math.max(1, ...windows.filter(w => w.independent >= MIN_INDEPENDENT_WINDOWS).map(w => w.horizonDays))
