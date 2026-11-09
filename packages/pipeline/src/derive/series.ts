import { HOUR_MS } from '../sources/http'

/**
 * An hourly grid over [start, start + length·1h). Missing hours are NaN and
 * stay NaN: windows that touch a gap are excluded, never interpolated.
 */
export interface HourlyGrid {
  readonly start: number
  readonly length: number
}

export const gridFor = (endHourExclusive: number, days: number): HourlyGrid => ({
  start: endHourExclusive - days * 24 * HOUR_MS,
  length: days * 24,
})

export const toSeries = <R extends { hour: number }>(
  grid: HourlyGrid,
  rows: ReadonlyArray<R>,
  value: (row: R) => number,
): Float64Array => {
  const out = new Float64Array(grid.length).fill(Number.NaN)
  for (const row of rows) {
    const index = Math.round((row.hour - grid.start) / HOUR_MS)
    if (index >= 0 && index < grid.length) {
      out[index] = value(row)
    }
  }
  return out
}

/** Linear-interpolated quantile of an unsorted sample (does not mutate). */
export const quantile = (values: ArrayLike<number>, q: number): number => {
  if (values.length === 0) {
    return Number.NaN
  }
  const sorted = Float64Array.from(values).sort()
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
}

export const countFinite = (values: Float64Array): number => {
  let n = 0
  for (const v of values) if (!Number.isNaN(v)) n++
  return n
}
