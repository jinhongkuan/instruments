import { Array, Option, pipe } from 'effect'

import type {
  Comparison,
  InstrumentResult,
  PathEvent,
  PayoffPoint,
  Scenario,
  SeriesPoint,
} from './schema'

// NOTE: Everything in this file is synthetic. It exists so the dashboard has a
// shape to render before ingestion and the carry engine land. Replace, do not extend.

const HOURS_PER_YEAR = 8760
const DAYS_PER_YEAR = 365

const PERP_LEVERAGE = 3
const PERP_MAINTENANCE_MARGIN = 0.05
const BORROW_LEVERAGE = 2
const BORROW_LIQUIDATION_LTV = 0.8
const CALL_IMPLIED_VOL = 0.65

const hashString = (value: string): number =>
  pipe(
    Array.fromIterable(value.toUpperCase()),
    Array.reduce(2166136261, (hash, char) =>
      Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0,
    ),
  )

const makeRandom = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const gaussian = (random: () => number): number => {
  const u = Math.max(random(), 1e-12)
  const v = random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const cumulative = (values: ReadonlyArray<number>): ReadonlyArray<number> =>
  pipe(
    values,
    Array.scan(0, (acc, value) => acc + value),
    Array.drop(1),
  )

const lastOr = (values: ReadonlyArray<number>, fallback: number): number =>
  Option.getOrElse(Array.last(values), () => fallback)

const toSeries = (values: ReadonlyArray<number>): ReadonlyArray<SeriesPoint> =>
  Array.map(values, (value, index) => ({ day: index + 1, value }))

const maxDrawdown = (equity: ReadonlyArray<number>): number =>
  pipe(
    equity,
    Array.reduce({ peak: 100, worst: 0 }, ({ peak, worst }, value) => {
      const nextPeak = Math.max(peak, value)
      return { peak: nextPeak, worst: Math.min(worst, value - nextPeak) }
    }),
    ({ worst }) => worst,
  )

const PAYOFF_GRID = Array.makeBy(41, index => 0.5 + index * 0.025)

const assetVolatility = (ticker: string): number => {
  const known: Record<string, number> = { BTC: 0.55, ETH: 0.7, SOL: 0.9, HYPE: 1.1 }
  return known[ticker.toUpperCase()] ?? 0.8
}

const pricePath = (scenario: Scenario, random: () => number): ReadonlyArray<number> => {
  const sigma = assetVolatility(scenario.ticker)
  const dailySigma = sigma / Math.sqrt(DAYS_PER_YEAR)
  return pipe(
    Array.makeBy(scenario.horizonDays, () => gaussian(random) * dailySigma),
    Array.scan(1, (price, shock) => price * Math.exp(shock - (dailySigma * dailySigma) / 2)),
    Array.drop(1),
  )
}

const hourlyFundingPath = (days: number, random: () => number): ReadonlyArray<number> => {
  const meanBpsPerHour = 1.25 / 100 / 100
  return pipe(
    Array.makeBy(days, () => gaussian(random)),
    Array.scan(meanBpsPerHour, (rate, shock) => {
      const reverted = rate + 0.15 * (meanBpsPerHour - rate) + shock * 0.00006
      return Math.max(-0.0004, Math.min(0.0004, reverted))
    }),
    Array.drop(1),
  )
}

const perp = (
  scenario: Scenario,
  prices: ReadonlyArray<number>,
  random: () => number,
): InstrumentResult => {
  const funding = hourlyFundingPath(scenario.horizonDays, random)
  const dailyCarryPct = Array.zipWith(
    funding,
    prices,
    (rate, price) => rate * 24 * PERP_LEVERAGE * price * 100,
  )
  const carry = cumulative(dailyCarryPct)
  const equity = Array.zipWith(
    prices,
    carry,
    (price, carryPct) => 100 + (price - 1) * PERP_LEVERAGE * 100 - carryPct,
  )
  const liquidationIndex = Array.findFirstIndex(
    equity,
    value => value <= PERP_LEVERAGE * PERP_MAINTENANCE_MARGIN * 100,
  )
  const pathEvents: ReadonlyArray<PathEvent> = pipe(
    liquidationIndex,
    Array.fromOption,
    Array.map(index => ({
      day: index + 1,
      kind: 'Liquidation' as const,
      detail: `Equity fell below maintenance margin at ${PERP_LEVERAGE}x`,
    })),
  )
  const totalCarryPct = lastOr(carry, 0)
  const payoff: ReadonlyArray<PayoffPoint> = Array.map(PAYOFF_GRID, ratio => ({
    terminalPriceRatio: ratio,
    pnlPctOfCapital: Math.max(-100, (ratio - 1) * PERP_LEVERAGE * 100 - totalCarryPct),
  }))
  return {
    kind: 'Perp',
    label: 'Perpetual future',
    venue: 'Hyperliquid',
    exposureMultiple: PERP_LEVERAGE,
    carryPctOfCapital: toSeries(carry),
    payoffAtHorizon: payoff,
    equityPctOfCapital: toSeries(equity),
    pathEvents,
    summary: {
      totalCarryPct,
      terminalPnlPct: lastOr(equity, 100) - 100,
      maxDrawdownPct: maxDrawdown(equity),
      liquidated: pathEvents.length > 0,
    },
  }
}

const spotBorrow = (
  scenario: Scenario,
  prices: ReadonlyArray<number>,
  random: () => number,
): InstrumentResult => {
  const baseApr = 0.06 + random() * 0.04
  const borrowedMultiple = BORROW_LEVERAGE - 1
  const dailyCarryPct = Array.makeBy(
    scenario.horizonDays,
    () => (baseApr / DAYS_PER_YEAR) * borrowedMultiple * 100,
  )
  const carry = cumulative(dailyCarryPct)
  const equity = Array.zipWith(
    prices,
    carry,
    (price, carryPct) => 100 + (price - 1) * BORROW_LEVERAGE * 100 - carryPct,
  )
  const ltvPath = Array.map(
    prices,
    price => borrowedMultiple / (BORROW_LEVERAGE * price),
  )
  const liquidationIndex = Array.findFirstIndex(ltvPath, ltv => ltv >= BORROW_LIQUIDATION_LTV)
  const pathEvents: ReadonlyArray<PathEvent> = pipe(
    liquidationIndex,
    Array.fromOption,
    Array.map(index => ({
      day: index + 1,
      kind: 'Liquidation' as const,
      detail: `Loan-to-value crossed ${BORROW_LIQUIDATION_LTV * 100}%`,
    })),
  )
  const totalCarryPct = lastOr(carry, 0)
  const payoff: ReadonlyArray<PayoffPoint> = Array.map(PAYOFF_GRID, ratio => ({
    terminalPriceRatio: ratio,
    pnlPctOfCapital: Math.max(-100, (ratio - 1) * BORROW_LEVERAGE * 100 - totalCarryPct),
  }))
  return {
    kind: 'SpotBorrow',
    label: 'Spot + borrow',
    venue: 'HyperLend',
    exposureMultiple: BORROW_LEVERAGE,
    carryPctOfCapital: toSeries(carry),
    payoffAtHorizon: payoff,
    equityPctOfCapital: toSeries(equity),
    pathEvents,
    summary: {
      totalCarryPct,
      terminalPnlPct: lastOr(equity, 100) - 100,
      maxDrawdownPct: maxDrawdown(equity),
      liquidated: pathEvents.length > 0,
    },
  }
}

const call = (scenario: Scenario, prices: ReadonlyArray<number>): InstrumentResult => {
  const years = scenario.horizonDays / DAYS_PER_YEAR
  const premiumPerUnit = 0.4 * CALL_IMPLIED_VOL * Math.sqrt(years)
  const contracts = 1 / premiumPerUnit
  const timeValueAt = (dayIndex: number, price: number): number => {
    const remaining = Math.max(0, years - (dayIndex + 1) / DAYS_PER_YEAR)
    const intrinsic = Math.max(0, price - 1)
    const extrinsic = 0.4 * CALL_IMPLIED_VOL * Math.sqrt(remaining) * Math.exp(-Math.abs(price - 1) * 2)
    return intrinsic + extrinsic
  }
  const equity = Array.map(prices, (price, index) => timeValueAt(index, price) * contracts * 100)
  const carry = Array.map(prices, (price, index) => {
    const intrinsicValue = Math.max(0, price - 1) * contracts * 100
    return Math.max(0, 100 - (equity[index] ?? 0) + (intrinsicValue > 0 ? intrinsicValue - Math.max(0, (prices[index] ?? 1) - 1) * contracts * 100 : 0))
  })
  const terminalPrice = lastOr(prices, 1)
  const pathEvents: ReadonlyArray<PathEvent> =
    terminalPrice <= 1
      ? [{ day: scenario.horizonDays, kind: 'Expiry', detail: 'Expired out of the money; premium lost' }]
      : []
  const payoff: ReadonlyArray<PayoffPoint> = Array.map(PAYOFF_GRID, ratio => ({
    terminalPriceRatio: ratio,
    pnlPctOfCapital: Math.max(0, ratio - 1) * contracts * 100 - 100,
  }))
  return {
    kind: 'Call',
    label: 'At-the-money call',
    venue: 'Derive',
    exposureMultiple: contracts,
    carryPctOfCapital: toSeries(carry),
    payoffAtHorizon: payoff,
    equityPctOfCapital: toSeries(equity),
    pathEvents,
    summary: {
      totalCarryPct: lastOr(carry, 0),
      terminalPnlPct: lastOr(equity, 0) - 100,
      maxDrawdownPct: maxDrawdown(equity),
      liquidated: false,
    },
  }
}

export const mockComparison = (scenario: Scenario): Comparison => {
  const random = makeRandom(hashString(`${scenario.ticker}:${scenario.entryDate}`))
  const prices = pricePath(scenario, random)
  return {
    scenario,
    priceRatio: toSeries(prices),
    instruments: [perp(scenario, prices, random), spotBorrow(scenario, prices, random), call(scenario, prices)],
    synthetic: true,
  }
}
