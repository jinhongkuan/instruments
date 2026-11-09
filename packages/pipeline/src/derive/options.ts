import { type ChainCall, atmPremiumFraction, callDelta } from '@instruments/domain'

const YEAR_MS = 365 * 86_400_000

/** One contract as stored in latest_chain (times in ms). */
export interface ChainPoint {
  readonly instrumentName: string
  readonly expiry: number
  readonly strike: number
  readonly type: 'call' | 'put'
  readonly markUsd: number
  readonly bidUsd: number | null
  readonly askUsd: number | null
  readonly markIv: number
  readonly underlyingPrice: number
}

/** Calls with delta from mark IV (Black-76 on the expiry's forward). Expired contracts are dropped. */
export const callsFromChain = (rows: ReadonlyArray<ChainPoint>, observedAt: number): ReadonlyArray<ChainCall> =>
  rows
    .filter(row => row.type === 'call' && row.expiry > observedAt && row.markUsd > 0 && row.markIv > 0)
    .map(row => ({
      instrumentName: row.instrumentName,
      expiry: new Date(row.expiry).toISOString(),
      strike: row.strike,
      premiumUsd: row.markUsd,
      bidUsd: row.bidUsd,
      askUsd: row.askUsd,
      iv: row.markIv,
      delta: callDelta(row.underlyingPrice, row.strike, (row.expiry - observedAt) / YEAR_MS, row.markIv),
      underlyingPrice: row.underlyingPrice,
    }))
    .sort((a, b) => (a.expiry === b.expiry ? a.strike - b.strike : a.expiry < b.expiry ? -1 : 1))

/** ATM implied vol per expiry: call IV interpolated linearly in strike at strike = forward. */
export const atmIvByExpiry = (rows: ReadonlyArray<ChainPoint>, observedAt: number): ReadonlyArray<{ years: number; iv: number }> => {
  const byExpiry = new Map<number, Array<ChainPoint>>()
  for (const row of rows) {
    if (row.type !== 'call' || row.expiry <= observedAt + 86_400_000 || row.markIv <= 0) continue
    const list = byExpiry.get(row.expiry) ?? []
    list.push(row)
    byExpiry.set(row.expiry, list)
  }
  const out: Array<{ years: number; iv: number }> = []
  for (const [expiry, list] of byExpiry) {
    const sorted = [...list].sort((a, b) => a.strike - b.strike)
    const forward = sorted[0]!.underlyingPrice
    const above = sorted.findIndex(row => row.strike >= forward)
    let iv: number
    if (above <= 0) {
      iv = (above === 0 ? sorted[0]! : sorted[sorted.length - 1]!).markIv
    } else {
      const lo = sorted[above - 1]!
      const hi = sorted[above]!
      const t = (forward - lo.strike) / (hi.strike - lo.strike)
      iv = lo.markIv + t * (hi.markIv - lo.markIv)
    }
    out.push({ years: (expiry - observedAt) / YEAR_MS, iv })
  }
  return out.sort((a, b) => a.years - b.years)
}

/**
 * ATM vol and premium at fixed tenors, interpolated linearly in total
 * variance (σ²T) between the bracketing expiries and held flat beyond the
 * first and last listed expiry.
 */
export const atmByTenor = (
  rows: ReadonlyArray<ChainPoint>,
  observedAt: number,
  tenorsDays: ReadonlyArray<number>,
): ReadonlyArray<{ tenorDays: number; iv: number; premiumFraction: number }> => {
  const curve = atmIvByExpiry(rows, observedAt)
  if (curve.length === 0) return []
  return tenorsDays.map(tenorDays => {
    const years = tenorDays / 365
    let iv: number
    if (years <= curve[0]!.years) {
      iv = curve[0]!.iv
    } else if (years >= curve[curve.length - 1]!.years) {
      iv = curve[curve.length - 1]!.iv
    } else {
      const upper = curve.findIndex(point => point.years >= years)
      const a = curve[upper - 1]!
      const b = curve[upper]!
      const wa = a.iv * a.iv * a.years
      const wb = b.iv * b.iv * b.years
      const w = wa + ((years - a.years) / (b.years - a.years)) * (wb - wa)
      iv = Math.sqrt(Math.max(0, w) / years)
    }
    return { tenorDays, iv, premiumFraction: atmPremiumFraction(years, iv) }
  })
}
