import { Array, Option, pipe } from 'effect'

import {
  type AxisSupport,
  type InstrumentSupport,
  type Resolved,
  resolveHorizon,
  resolveLeverage,
  resolvedValue,
} from './instrument/common'
import { DEFAULT_CONVENTIONS } from './instrument/conventions'
import type {
  CarryBand,
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

const PERP_MAX_LEVERAGE = 40
const PERP_MAINTENANCE_MARGIN = 0.0125
const BORROW_MAX_LTV = 0.8
const BORROW_LIQUIDATION_LTV = 0.825
const CALL_IMPLIED_VOL = 0.65
const CALL_DELTA = 0.5

const anyHorizon: AxisSupport = { _tag: 'Continuous', min: 1, max: 3650, pins: [] }
const perpSupport: InstrumentSupport = {
  leverage: { _tag: 'Continuous', min: 1, max: PERP_MAX_LEVERAGE, pins: [] },
  horizonDays: anyHorizon,
}
const borrowSupport: InstrumentSupport = {
  leverage: { _tag: 'Continuous', min: 1, max: 1 + BORROW_MAX_LTV, pins: [] },
  horizonDays: anyHorizon,
}

const OPTION_EXPIRIES = [7, 14, 30, 60, 90, 180, 365]

/** Synthetic chain: a handful of calls whose effective leverage spreads across strikes, plus listed expiries. */
const optionSupport = (random: () => number): InstrumentSupport => ({
  leverage: {
    _tag: 'Discrete',
    points: [0.9, 1.0, 1.1, 1.25, 1.5].map((moneyness, index) => {
      const omega = (2.6 + index * 2.1) * (0.9 + random() * 0.2)
      return { value: Math.round(omega * 100) / 100, label: `${Math.round(moneyness * 100)}% strike` }
    }),
  },
  horizonDays: {
    _tag: 'Continuous',
    min: 7,
    max: 3650,
    pins: OPTION_EXPIRIES.map(days => ({ value: days, label: `expiry in ${days}d` })),
  },
})

const TOLERANCE = DEFAULT_CONVENTIONS.option.leverageTolerance

/** Synthetic annualized funding volatility used to width the floating-carry band. */
const FUNDING_APR_SIGMA = 0.18
const BORROW_APR_SIGMA = 0.03
const Z_P90 = 1.2816
const COUNTERFACTUAL_FIXED_APR = 0.116 + 0.02

const flatBand = (kind: CarryBand['kind'], mid: number, basis: string): CarryBand => ({ kind, low: mid, mid, high: mid, basis })

const floatingBand = (
  kind: CarryBand['kind'],
  mid: number,
  aprSigma: number,
  leverageOnCapital: number,
  horizonDays: number,
  basis: string,
): CarryBand => {
  const halfWidth = Z_P90 * aprSigma * Math.sqrt(horizonDays / DAYS_PER_YEAR) * leverageOnCapital * 100
  return { kind, low: mid - halfWidth, mid, high: mid + halfWidth, basis }
}

const linearPayoff = (leverage: number, band: CarryBand): ReadonlyArray<PayoffPoint> =>
  Array.map(PAYOFF_GRID, ratio => {
    const beforeCarry = (ratio - 1) * leverage * 100
    return {
      terminalPriceRatio: ratio,
      beforeCarry,
      low: Math.max(-100, beforeCarry - band.high),
      mid: Math.max(-100, beforeCarry - band.mid),
      high: Math.max(-100, beforeCarry - band.low),
    }
  })

const unavailable = (
  kind: InstrumentResult['kind'],
  label: string,
  venue: string,
  support: InstrumentSupport,
  resolved: Resolved,
  horizonResolved: Resolved,
): InstrumentResult => ({
  kind,
  label,
  venue,
  support,
  resolved,
  horizonResolved,
  exposureMultiple: 0,
  carryBand: flatBand(kind === 'Option' ? 'Prepaid' : 'Floating', 0, 'n/a'),
  ruinPriceRatio: Option.none(),
  fixedCounterfactual: Option.none(),
  carryPctOfCapital: [],
  payoffAtHorizon: [],
  equityPctOfCapital: [],
  pathEvents: [],
  summary: { totalCarryPct: 0, terminalPnlPct: 0, maxDrawdownPct: 0, liquidated: false },
})

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
  const resolved = resolveLeverage(perpSupport.leverage, scenario.leverage, TOLERANCE)
  const horizonResolved = resolveHorizon(perpSupport.horizonDays, scenario.horizonDays, TOLERANCE)
  const maybeLeverage = resolvedValue(resolved)
  if (Option.isNone(maybeLeverage)) {
    return unavailable('Perp', 'Perpetual future', 'Hyperliquid', perpSupport, resolved, horizonResolved)
  }
  const PERP_LEVERAGE = maybeLeverage.value
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
    value => value <= PERP_LEVERAGE * PERP_MAINTENANCE_MARGIN * 100 * (1 + 0 * random()),
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
  const band = floatingBand(
    'Floating',
    totalCarryPct,
    FUNDING_APR_SIGMA,
    PERP_LEVERAGE,
    scenario.horizonDays,
    `p10–p90 of ${scenario.horizonDays}-day funding windows (synthetic)`,
  )
  const payoff = linearPayoff(PERP_LEVERAGE, band)
  const fixedCarryPct = COUNTERFACTUAL_FIXED_APR * (scenario.horizonDays / DAYS_PER_YEAR) * PERP_LEVERAGE * 100
  const fixedCounterfactual = Array.map(PAYOFF_GRID, ratio => ({
    day: ratio,
    value: Math.max(-100, (ratio - 1) * PERP_LEVERAGE * 100 - fixedCarryPct),
  }))
  const ruinRatio = PERP_LEVERAGE > 1 ? (1 - 1 / PERP_LEVERAGE) / (1 - PERP_MAINTENANCE_MARGIN) : 0
  return {
    kind: 'Perp',
    label: 'Perpetual future',
    venue: 'Hyperliquid',
    support: perpSupport,
    resolved,
    horizonResolved,
    exposureMultiple: PERP_LEVERAGE,
    carryBand: band,
    ruinPriceRatio: PERP_LEVERAGE > 1 ? Option.some(ruinRatio) : Option.none(),
    fixedCounterfactual: Option.some(fixedCounterfactual),
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
  const resolved = resolveLeverage(borrowSupport.leverage, scenario.leverage, TOLERANCE)
  const horizonResolved = resolveHorizon(borrowSupport.horizonDays, scenario.horizonDays, TOLERANCE)
  const maybeLeverage = resolvedValue(resolved)
  if (Option.isNone(maybeLeverage)) {
    return unavailable('SpotBorrow', 'Spot + borrow', 'Aave', borrowSupport, resolved, horizonResolved)
  }
  const BORROW_LEVERAGE = maybeLeverage.value
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
  const band = floatingBand(
    'Floating',
    totalCarryPct,
    BORROW_APR_SIGMA,
    BORROW_LEVERAGE - 1,
    scenario.horizonDays,
    `p10–p90 of ${scenario.horizonDays}-day variable borrow windows (synthetic)`,
  )
  const payoff = linearPayoff(BORROW_LEVERAGE, band)
  const ruinRatio = BORROW_LEVERAGE > 1 ? (BORROW_LEVERAGE - 1) / (BORROW_LEVERAGE * BORROW_LIQUIDATION_LTV) : 0
  return {
    kind: 'SpotBorrow',
    label: 'Spot + borrow',
    venue: 'Aave',
    support: borrowSupport,
    resolved,
    horizonResolved,
    exposureMultiple: BORROW_LEVERAGE,
    carryBand: band,
    ruinPriceRatio: BORROW_LEVERAGE > 1 ? Option.some(ruinRatio) : Option.none(),
    fixedCounterfactual: Option.none(),
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

const call = (scenario: Scenario, prices: ReadonlyArray<number>, random: () => number): InstrumentResult => {
  const support = optionSupport(random)
  const resolved = resolveLeverage(support.leverage, scenario.leverage, TOLERANCE)
  const horizonResolved = resolveHorizon(support.horizonDays, scenario.horizonDays, TOLERANCE)
  const maybeLeverage = resolvedValue(resolved)
  if (Option.isNone(maybeLeverage)) {
    return unavailable('Option', 'Call option', 'Deribit', support, resolved, horizonResolved)
  }
  const omega = maybeLeverage.value
  const years = scenario.horizonDays / DAYS_PER_YEAR
  const premiumPerUnit = CALL_DELTA / omega
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
  const tenorDays = OPTION_EXPIRIES.find(days => days >= scenario.horizonDays) ?? OPTION_EXPIRIES[OPTION_EXPIRIES.length - 1]!
  const rolls = Math.max(0, Math.ceil(scenario.horizonDays / tenorDays) - 1)
  const rollSpreadPct = rolls * DEFAULT_CONVENTIONS.option.defaultRollSpreadFraction * 100
  const rollUncertaintyPct = rolls * 12
  const band: CarryBand = {
    kind: 'Prepaid',
    low: 100 + rollSpreadPct - rollUncertaintyPct,
    mid: 100 + rollSpreadPct,
    high: 100 + rollSpreadPct + rollUncertaintyPct,
    basis: rolls === 0 ? 'premium paid at entry; no rolls needed' : `premium at entry plus ${rolls} roll(s) at unknown future premium (synthetic)`,
  }
  const payoff: ReadonlyArray<PayoffPoint> = Array.map(PAYOFF_GRID, ratio => {
    const intrinsic = Math.max(0, ratio - 1) * contracts * 100
    return {
      terminalPriceRatio: ratio,
      beforeCarry: intrinsic,
      low: intrinsic - band.high,
      mid: intrinsic - band.mid,
      high: intrinsic - band.low,
    }
  })
  return {
    kind: 'Option',
    label: 'Call option',
    venue: 'Deribit',
    support,
    resolved,
    horizonResolved,
    exposureMultiple: omega,
    carryBand: band,
    ruinPriceRatio: Option.none(),
    fixedCounterfactual: Option.none(),
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
    instruments: [perp(scenario, prices, random), spotBorrow(scenario, prices, random), call(scenario, prices, random)],
    synthetic: true,
  }
}
