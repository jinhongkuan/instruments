import { Array, Option } from 'effect'

import {
  type BenchmarkBlock,
  type FundingWindow,
  MIN_INDEPENDENT_WINDOWS,
  type OptionBlock,
  type PerpBlock,
  type RuinCurve,
  type TickerBundle,
} from './bundle'
import { atmPremiumFraction, callPrice, probabilityExpiresOtm } from './instrument/blackScholes'
import {
  DAYS_PER_YEAR,
  type InstrumentSupport,
  type Resolved,
  isUnavailable,
  resolveHorizon,
  resolveLeverage,
  resolvedValue,
} from './instrument/common'
import { DEFAULT_CONVENTIONS } from './instrument/conventions'
import { type OptionQuote, type OptionState, contractLabel, daysBetween, optionModel } from './instrument/option'
import { liquidationPriceRatio } from './instrument/perp'
import type { CarryBand, Comparison, DataSourceNote, InstrumentResult, PayoffPoint, Scenario, SeriesPoint } from './schema'

// ---------------------------------------------------------------------------
// The comparison built from a real bundle. Pure: the browser runs this on
// every slider move. Where history is thin it says so in the band's basis
// instead of inventing a number.
// ---------------------------------------------------------------------------

const C = DEFAULT_CONVENTIONS
const TOLERANCE = C.option.leverageTolerance
const PAYOFF_GRID: ReadonlyArray<number> = Array.makeBy(41, index => 0.5 + index * 0.025)
const DEFAULT_RUIN_DAYS: ReadonlyArray<number> = [1, 2, 3, 5, 7, 10, 14, 21, 30]
const FALLBACK_MAX_HORIZON = 30

/** Below this much USD traded in 24 hours, a perp is flagged as thin even on a deep venue. */
export const LOW_LIQUIDITY_DAILY_VOLUME_USD = 1_000_000
/** A bid–ask spread wider than this fraction of the mark flags the selected option as thin. */
export const WIDE_SPREAD_FRACTION = 0.1

const compactUsd = (usd: number): string =>
  usd >= 1e9 ? `$${(usd / 1e9).toFixed(1)}B` : usd >= 1e6 ? `$${(usd / 1e6).toFixed(1)}M` : usd >= 1e3 ? `$${(usd / 1e3).toFixed(0)}k` : `$${usd.toFixed(0)}`

const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`

/**
 * A Broad venue always carries the low-liquidity flag; a Deep venue carries it
 * only when its own trading signal (volume, spread) is thin.
 */
const sourceNote = (text: string, liquidityClass: DataSourceNote['liquidityClass'], venue: string, thin: Option.Option<string>): DataSourceNote => ({
  text,
  liquidityClass,
  lowLiquidity:
    liquidityClass === 'Broad'
      ? Option.some(`only a broad venue (${venue}) lists this, so prices may not hold at size`)
      : thin,
})

const perpSource = (block: PerpBlock): DataSourceNote => {
  const volume = block.dayNotionalVolumeUsd
  return sourceNote(
    `Hyperliquid ${block.venueSymbol} perpetual: hourly funding and prices, last ${Math.round(block.historyHours / 24)} days` +
      (volume === null ? '' : `, ${compactUsd(volume)} traded in 24h`),
    'Deep',
    'Hyperliquid',
    volume !== null && volume < LOW_LIQUIDITY_DAILY_VOLUME_USD ? Option.some(`only ${compactUsd(volume)} traded in the last 24h`) : Option.none(),
  )
}

const optionSource = (block: OptionBlock, selected: OptionQuote): DataSourceNote => {
  const spread =
    Option.isSome(selected.bid) && Option.isSome(selected.ask) && selected.premium > 0
      ? Option.some((selected.ask.value - selected.bid.value) / selected.premium)
      : Option.none<number>()
  const thin = Option.match(spread, {
    onNone: () => Option.some('no two-sided quote on the selected contract'),
    onSome: fraction =>
      fraction > WIDE_SPREAD_FRACTION ? Option.some(`${(fraction * 100).toFixed(0)}% bid–ask spread on the selected contract`) : Option.none<string>(),
  })
  return sourceNote(`Deribit ${block.chain} options: ${block.calls.length} listed calls, chain at ${hhmm(block.observedAt)}`, 'Deep', 'Deribit', thin)
}

/** Piecewise-linear interpolation over sorted xs, clamped at both ends. */
export const interpolate = (xs: ReadonlyArray<number>, ys: ReadonlyArray<number>, x: number): number => {
  if (xs.length === 0) {
    return Number.NaN
  }
  if (x <= xs[0]!) {
    return ys[0]!
  }
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]!) {
      const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]!)
      return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!)
    }
  }
  return ys[ys.length - 1]!
}

/** Funding quantiles at a horizon, from the credible windows only. */
export const fundingAt = (
  windows: ReadonlyArray<FundingWindow>,
  horizonDays: number,
): Option.Option<{ p10: number; p50: number; p90: number; window: FundingWindow }> => {
  const credible = windows
    .filter(w => w.independent >= MIN_INDEPENDENT_WINDOWS)
    .sort((a, b) => a.horizonDays - b.horizonDays)
  if (credible.length === 0) {
    return Option.none()
  }
  const xs = credible.map(w => w.horizonDays)
  const nearest = [...credible].sort(
    (a, b) => Math.abs(a.horizonDays - horizonDays) - Math.abs(b.horizonDays - horizonDays),
  )[0]!
  return Option.some({
    p10: interpolate(xs, credible.map(w => w.p10), horizonDays),
    p50: interpolate(xs, credible.map(w => w.p50), horizonDays),
    p90: interpolate(xs, credible.map(w => w.p90), horizonDays),
    window: nearest,
  })
}

/**
 * Ruin probability at a leverage and horizon. Linear between leverage
 * buckets (the touch frequency is monotone in leverage), zero at 1x, and
 * linear in days between horizon buckets.
 */
export const ruinAt = (curves: ReadonlyArray<RuinCurve>, leverage: number, days: number): number => {
  if (leverage <= 1 || curves.length === 0) {
    return 0
  }
  const sorted = [...curves].sort((a, b) => a.leverage - b.leverage)
  const atDays = (curve: RuinCurve): number => {
    const points = [...curve.byHorizon].filter(p => p.starts > 0).sort((a, b) => a.days - b.days)
    return points.length === 0 ? 0 : interpolate(points.map(p => p.days), points.map(p => p.probability), days)
  }
  const xs = [1, ...sorted.map(c => c.leverage)]
  const ys = [0, ...sorted.map(atDays)]
  return Math.min(1, Math.max(0, interpolate(xs, ys, leverage)))
}

const linearPayoff = (leverage: number, band: CarryBand, ruinRatio: Option.Option<number>): ReadonlyArray<PayoffPoint> =>
  Array.map(PAYOFF_GRID, ratio => {
    const beforeCarry = (ratio - 1) * leverage * 100
    const ruined = Option.exists(ruinRatio, r => ratio <= r)
    return {
      terminalPriceRatio: ratio,
      beforeCarry,
      low: ruined ? -100 : Math.max(-100, beforeCarry - band.high),
      mid: ruined ? -100 : Math.max(-100, beforeCarry - band.mid),
      high: ruined ? -100 : Math.max(-100, beforeCarry - band.low),
    }
  })

const unavailable = (
  kind: InstrumentResult['kind'],
  label: string,
  venue: string,
  support: InstrumentSupport,
  resolved: Resolved,
  horizonResolved: Resolved,
  basis: string,
): InstrumentResult => ({
  kind,
  label,
  venue,
  source: sourceNote(basis === 'n/a' ? `${venue}: nothing to price for this request` : `${venue}: ${basis}`, 'Deep', venue, Option.none()),
  support,
  resolved,
  horizonResolved,
  exposureMultiple: 0,
  carryBand: { kind: kind === 'Option' ? 'Prepaid' : kind === 'Perp' ? 'Floating' : 'Fixed', low: 0, mid: 0, high: 0, basis },
  ruinPriceRatio: Option.none(),
  carryPctOfCapital: [],
  payoffAtHorizon: [],
  ruinProbabilityByHorizon: [],
  equityPctOfCapital: [],
  pathEvents: [],
  summary: { totalCarryPct: 0, terminalPnlPct: 0, maxDrawdownPct: 0, liquidated: false, ruinAtHorizonPct: 0 },
})

const none = (reason: string): InstrumentSupport => ({
  leverage: { _tag: 'None', reason },
  horizonDays: { _tag: 'None', reason },
})

const notListedResolved = (requested: number, reason: string): Resolved => ({
  _tag: 'Unattainable',
  requested,
  fallback: Option.none(),
  nearest: Option.none(),
  reason,
})

const horizonOf = (resolved: Resolved, requested: number, max: number): number =>
  Option.getOrElse(resolvedValue(resolved), () => Math.min(requested, max))

const pct = (fraction: number): string => `${(fraction * 100).toFixed(2)}%`

// Perp ----------------------------------------------------------------------

const perpResult = (block: PerpBlock | null, scenario: Scenario, ruinDays: ReadonlyArray<number>): InstrumentResult => {
  const label = 'Perpetual future'
  if (block === null) {
    const reason = `${scenario.ticker} has no perpetual listed on Hyperliquid`
    return unavailable('Perp', label, 'Hyperliquid', none(reason), notListedResolved(scenario.leverage, reason), notListedResolved(scenario.horizonDays, reason), `no perpetual listed on ${scenario.ticker}`)
  }
  const marginCap = (1 / block.maintenanceMarginFraction) * (1 - 1e-9)
  const support: InstrumentSupport = {
    leverage: { _tag: 'Continuous', min: 1, max: Math.min(block.maxLeverage, marginCap), pins: [] },
    horizonDays: { _tag: 'Continuous', min: 1, max: block.maxHorizonDays, pins: [] },
  }
  const resolved = resolveLeverage(support.leverage, scenario.leverage, TOLERANCE)
  const horizonResolved = resolveHorizon(support.horizonDays, scenario.horizonDays, TOLERANCE)
  const maybeLeverage = resolvedValue(resolved)
  const funding = fundingAt(block.fundingWindows, horizonOf(horizonResolved, scenario.horizonDays, block.maxHorizonDays))
  if (Option.isNone(maybeLeverage) || Option.isNone(funding)) {
    return unavailable('Perp', label, 'Hyperliquid', support, resolved, horizonResolved,
      Option.isNone(funding) ? 'not enough funding history yet' : 'n/a')
  }
  const leverage = maybeLeverage.value
  const horizon = horizonOf(horizonResolved, scenario.horizonDays, block.maxHorizonDays)
  const q = funding.value
  const band: CarryBand = {
    kind: 'Floating',
    low: q.p10 * leverage * 100,
    mid: q.p50 * leverage * 100,
    high: q.p90 * leverage * 100,
    basis: `p10–p90 of realized ${horizon}-day funding over the last ${Math.round(block.historyHours / 24)} days (${q.window.independent} independent windows)`,
  }
  const ruin = liquidationPriceRatio(leverage, block.maintenanceMarginFraction)
  const ruinAtHorizon = ruinAt(block.ruinCurves, leverage, horizon)
  return {
    kind: 'Perp',
    label,
    venue: 'Hyperliquid',
    source: perpSource(block),
    support,
    resolved,
    horizonResolved,
    exposureMultiple: leverage,
    carryBand: band,
    ruinPriceRatio: ruin,
    carryPctOfCapital: [],
    payoffAtHorizon: linearPayoff(leverage, band, ruin),
    ruinProbabilityByHorizon: ruinDays.map(day => ({ day, value: ruinAt(block.ruinCurves, leverage, day) })),
    equityPctOfCapital: [],
    pathEvents: [],
    summary: {
      totalCarryPct: band.mid,
      terminalPnlPct: Math.max(-100, -band.mid),
      maxDrawdownPct: 0,
      liquidated: false,
      ruinAtHorizonPct: ruinAtHorizon * 100,
    },
  }
}

// Spot + borrow benchmark ----------------------------------------------------

const borrowResult = (
  block: BenchmarkBlock | null,
  scenario: Scenario,
  maxHorizon: number,
  ruinDays: ReadonlyArray<number>,
): InstrumentResult => {
  const label = 'Spot + borrow (benchmark)'
  const support: InstrumentSupport = {
    leverage: { _tag: 'Continuous', min: 1, max: 1000, pins: [] },
    horizonDays: { _tag: 'Continuous', min: 1, max: maxHorizon, pins: [] },
  }
  const resolved = resolveLeverage(support.leverage, scenario.leverage, TOLERANCE)
  const horizonResolved = resolveHorizon(support.horizonDays, scenario.horizonDays, TOLERANCE)
  const maybeLeverage = resolvedValue(resolved)
  if (block === null || Option.isNone(maybeLeverage)) {
    return unavailable('SpotBorrow', label, 'Dollar rate', support, resolved, horizonResolved,
      block === null ? 'no benchmark rate ingested yet' : 'n/a')
  }
  const leverage = maybeLeverage.value
  const horizon = horizonOf(horizonResolved, scenario.horizonDays, maxHorizon)
  const carry = block.apr * (leverage - 1) * (horizon / DAYS_PER_YEAR) * 100
  const band: CarryBand = {
    kind: 'Fixed',
    low: carry,
    mid: carry,
    high: carry,
    basis: `${block.source} ${pct(block.apr)} for ${block.effectiveDate}, locked at entry, unlimited credit (benchmark)`,
  }
  return {
    kind: 'SpotBorrow',
    label,
    venue: 'Dollar rate, unlimited credit',
    source: sourceNote(`${block.source} from the New York Fed: rate for ${block.effectiveDate}`, 'Deep', 'New York Fed', Option.none()),
    support,
    resolved,
    horizonResolved,
    exposureMultiple: leverage,
    carryBand: band,
    ruinPriceRatio: Option.none(),
    carryPctOfCapital: [],
    payoffAtHorizon: linearPayoff(leverage, band, Option.none()),
    ruinProbabilityByHorizon: ruinDays.map(day => ({ day, value: 0 })),
    equityPctOfCapital: [],
    pathEvents: [],
    summary: { totalCarryPct: carry, terminalPnlPct: -carry, maxDrawdownPct: 0, liquidated: false, ruinAtHorizonPct: 0 },
  }
}

// Call option ---------------------------------------------------------------

const toQuote = (block: OptionBlock, ticker: string) => (call: OptionBlock['calls'][number]): OptionQuote => ({
  venueId: 'deribit',
  assetId: ticker,
  observedAt: block.observedAt,
  style: 'European',
  type: 'Call',
  strike: call.strike,
  expiry: Option.some(call.expiry),
  premium: call.premiumUsd,
  impliedVol: Option.some(call.iv),
  delta: Option.some(call.delta),
  gamma: Option.none(),
  theta: Option.none(),
  underlyingPrice: call.underlyingPrice,
  bid: Option.fromNullishOr(call.bidUsd),
  ask: Option.fromNullishOr(call.askUsd),
})

/** IV scaling for the vega band: this tenor's p10 and p90 ATM vol relative to its median. */
const ivRange = (block: OptionBlock, daysToExpiry: number): { low: number; high: number; samples: number } => {
  const nearest = [...block.atmByTenor].sort(
    (a, b) => Math.abs(a.tenorDays - daysToExpiry) - Math.abs(b.tenorDays - daysToExpiry),
  )[0]
  if (nearest === undefined || nearest.ivHistory.samples < 24 || nearest.ivHistory.p50 <= 0) {
    return { low: 1, high: 1, samples: nearest?.ivHistory.samples ?? 0 }
  }
  return {
    low: nearest.ivHistory.p10 / nearest.ivHistory.p50,
    high: nearest.ivHistory.p90 / nearest.ivHistory.p50,
    samples: nearest.ivHistory.samples,
  }
}

const optionResult = (block: OptionBlock | null, scenario: Scenario, ruinDays: ReadonlyArray<number>): InstrumentResult => {
  const label = 'Call option'
  if (block === null || block.calls.length === 0) {
    const reason = `No listed options on ${scenario.ticker}`
    return unavailable('Option', label, 'Deribit', none(reason), notListedResolved(scenario.leverage, reason), notListedResolved(scenario.horizonDays, reason), `no options listed on ${scenario.ticker}`)
  }
  const all = block.calls.map(toQuote(block, scenario.ticker))
  // Hold one contract through the horizon when the chain allows it: no rolls, no unknown future premium.
  const holdable = all.filter(q => Option.exists(q.expiry, e => daysBetween(block.observedAt, e) >= scenario.horizonDays))
  const state: OptionState = {
    venueId: 'deribit',
    assetId: scenario.ticker,
    observedAt: block.observedAt,
    style: 'European',
    chain: holdable.length > 0 ? holdable : all,
    underlyingPrice: all[0]!.underlyingPrice,
    discountRate: Option.none(),
  }
  const modelSupport = optionModel.support(state, C)
  const expiryPins = [...new Set(all.map(q => Math.round(daysBetween(block.observedAt, Option.getOrElse(q.expiry, () => block.observedAt)))))]
    .filter(days => days >= 1 && days <= 60)
    .sort((a, b) => a - b)
    .map(days => ({ value: days, label: `expiry in ${days}d` }))
  const support: InstrumentSupport = {
    leverage: modelSupport.leverage,
    horizonDays: { _tag: 'Continuous', min: 1, max: 365, pins: expiryPins },
  }
  const resolved = resolveLeverage(support.leverage, scenario.leverage, TOLERANCE)
  const horizonResolved = resolveHorizon(support.horizonDays, scenario.horizonDays, TOLERANCE)
  const maybeOmega = resolvedValue(resolved)
  if (Option.isNone(maybeOmega)) {
    return unavailable('Option', label, 'Deribit', support, resolved, horizonResolved, 'n/a')
  }
  const quote = optionModel.quote(state, maybeOmega.value, scenario.horizonDays, C)
  if (isUnavailable(quote)) {
    return unavailable('Option', label, 'Deribit', support, resolved, horizonResolved, quote._tag)
  }
  const detail = optionModel.decodeDetail(quote)
  const selected = detail.selected
  const daysToExpiry = Option.getOrElse(detail.daysToExpiry, () => scenario.horizonDays)
  const iv = Option.getOrElse(selected.impliedVol, () => 0.6)
  const forward = selected.underlyingPrice
  const premium = selected.premium
  const horizon = scenario.horizonDays
  const yearsNow = daysToExpiry / DAYS_PER_YEAR
  const yearsLeft = Math.max(0, daysToExpiry - horizon) / DAYS_PER_YEAR
  const scale = ivRange(block, daysToExpiry)
  const pnl = (ratio: number, vol: number): number => (callPrice(forward * ratio, selected.strike, yearsLeft, vol) / premium - 1) * 100
  // The pure price leg: the contract repriced at the new spot with no time passed.
  const priceLeg = (ratio: number): number => (callPrice(forward * ratio, selected.strike, yearsNow, iv) / premium - 1) * 100
  const decay = (vol: number): number => priceLeg(1) - pnl(1, vol)
  const carryLow = Math.min(decay(iv * scale.low), decay(iv * scale.high))
  const carryHigh = Math.max(decay(iv * scale.low), decay(iv * scale.high))
  const band: CarryBand = {
    kind: 'Prepaid',
    low: carryLow,
    mid: decay(iv),
    high: carryHigh,
    basis:
      scale.samples >= 24
        ? `time decay over ${horizon}d, implied vol between its 90-day p10 and p90 at exit`
        : `time decay over ${horizon}d at today's implied vol (vol history still accruing)`,
  }
  const payoffAtHorizon: ReadonlyArray<PayoffPoint> = PAYOFF_GRID.map(ratio => {
    const variants = [pnl(ratio, iv * scale.low), pnl(ratio, iv * scale.high)]
    return {
      terminalPriceRatio: ratio,
      beforeCarry: priceLeg(ratio),
      low: Math.min(...variants),
      mid: pnl(ratio, iv),
      high: Math.max(...variants),
    }
  })
  const otm = probabilityExpiresOtm(forward, selected.strike, yearsNow, iv)
  const ruinAtDay = (day: number): number => (day >= daysToExpiry ? otm : 0)
  return {
    kind: 'Option',
    label,
    venue: `Deribit · ${contractLabel(selected)}`,
    source: optionSource(block, selected),
    support,
    resolved,
    horizonResolved,
    exposureMultiple: detail.effectiveLeverage,
    carryBand: band,
    ruinPriceRatio: Option.none(),
    carryPctOfCapital: [],
    payoffAtHorizon,
    ruinProbabilityByHorizon: ruinDays.map(day => ({ day, value: ruinAtDay(day) })),
    equityPctOfCapital: [],
    pathEvents: [],
    summary: {
      totalCarryPct: band.mid,
      terminalPnlPct: pnl(1, iv),
      maxDrawdownPct: 0,
      liquidated: false,
      ruinAtHorizonPct: ruinAtDay(horizon) * 100,
    },
  }
}

// ---------------------------------------------------------------------------

export const comparisonFromBundle = (bundle: TickerBundle, scenario: Scenario): Comparison => {
  // A perp with almost no history must not cap the other instruments' horizons.
  const maxHorizon =
    bundle.perp !== null && bundle.perp.historyHours >= 72 ? bundle.perp.maxHorizonDays : FALLBACK_MAX_HORIZON
  const ruinDays = DEFAULT_RUIN_DAYS.filter(day => day <= Math.max(1, maxHorizon))
  return {
    scenario,
    priceRatio: [] as ReadonlyArray<SeriesPoint>,
    instruments: [
      perpResult(bundle.perp, scenario, ruinDays),
      borrowResult(bundle.benchmark, scenario, maxHorizon, ruinDays),
      optionResult(bundle.option, scenario, ruinDays),
    ],
    synthetic: false,
  }
}

/** ATM premium for a tenor, for callers that want the headline cost of convexity. */
export const atmPremiumAt = (iv: number, tenorDays: number): number => atmPremiumFraction(tenorDays / DAYS_PER_YEAR, iv)
