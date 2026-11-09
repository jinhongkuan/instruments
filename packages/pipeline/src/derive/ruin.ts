import type { RuinCurve } from '@instruments/domain'

/**
 * Empirical chance of liquidation for a long perp, by leverage and holding
 * period, from every start hour in the history.
 *
 * Per unit of entry notional, a long at leverage L posts 1/L. After k hours
 * its equity is 1/L + (r − 1) − F, where r is price over entry and F is the
 * funding paid so far. The venue liquidates when equity ≤ mm · r, i.e. when
 *   r(1 − mm) − F ≤ 1 − 1/L.
 * Write g = r_low(1 − mm) − F, testing the hour's low so intra-hour touches
 * count. The running minimum of g is non-increasing and 1 − 1/L rises with L,
 * so one forward walk per start gives the first-passage hour for every
 * leverage at once. Every horizon then reads off the same first-passage times.
 *
 * A start whose window runs into missing data before liquidation is censored
 * for longer horizons: it counts as neither ruined nor survived.
 */
export const ruinCurves = (
  series: { close: Float64Array; low: Float64Array; rate: Float64Array },
  maintenanceMarginFraction: number,
  leverages: ReadonlyArray<number>,
  horizonsDays: ReadonlyArray<number>,
): ReadonlyArray<RuinCurve> => {
  const { close, low, rate } = series
  const n = close.length
  const sortedLev = [...leverages].sort((a, b) => a - b)
  const thresholds = sortedLev.map(l => 1 - 1 / l)
  const horizonHours = horizonsDays.map(d => d * 24)
  const maxHours = Math.max(...horizonHours)
  const b = sortedLev.length
  const ruined = horizonHours.map(() => new Float64Array(b))
  const survived = horizonHours.map(() => new Float64Array(b))

  // nextGap[i]: first index ≥ i whose price or funding is missing (n if none).
  const nextGap = new Int32Array(n + 1)
  nextGap[n] = n
  for (let i = n - 1; i >= 0; i--) {
    const missing = Number.isNaN(close[i]!) || Number.isNaN(low[i]!) || Number.isNaN(rate[i]!)
    nextGap[i] = missing ? i : nextGap[i + 1]!
  }
  const firstPassage = new Float64Array(b)
  const shrink = 1 - maintenanceMarginFraction

  for (let t = 0; t < n - 1; t++) {
    const base = close[t]!
    if (Number.isNaN(base) || base <= 0) {
      continue
    }
    const validUntil = Math.min(nextGap[t + 1]! - 1, n - 1, t + maxHours)
    firstPassage.fill(Number.POSITIVE_INFINITY)
    let unassigned = b
    let funding = 0
    let runningMin = Number.POSITIVE_INFINITY
    for (let k = t + 1; k <= validUntil && unassigned > 0; k++) {
      funding += rate[k]! * (close[k]! / base)
      const g = (low[k]! / base) * shrink - funding
      if (g < runningMin) {
        runningMin = g
        for (let j = b - 1; j >= 0; j--) {
          if (firstPassage[j] === Number.POSITIVE_INFINITY && runningMin <= thresholds[j]!) {
            firstPassage[j] = k - t
            unassigned--
          }
        }
      }
    }
    const lookahead = validUntil - t
    for (let h = 0; h < horizonHours.length; h++) {
      const hours = horizonHours[h]!
      for (let j = 0; j < b; j++) {
        if (firstPassage[j]! <= hours) {
          ruined[h]![j]!++
        } else if (lookahead >= hours) {
          survived[h]![j]!++
        }
      }
    }
  }

  return sortedLev.map((leverage, j) => ({
    leverage,
    byHorizon: horizonsDays.map((days, h) => {
      const starts = ruined[h]![j]! + survived[h]![j]!
      return { days, probability: starts === 0 ? 0 : ruined[h]![j]! / starts, starts }
    }),
  }))
}

/** Annualized volatility of hourly log returns between consecutive observed closes. */
export const realizedVol = (close: Float64Array): number | null => {
  const returns: Array<number> = []
  for (let i = 1; i < close.length; i++) {
    const a = close[i - 1]!
    const c = close[i]!
    if (!Number.isNaN(a) && !Number.isNaN(c) && a > 0 && c > 0) {
      returns.push(Math.log(c / a))
    }
  }
  if (returns.length < 24) {
    return null
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance * 8760)
}
