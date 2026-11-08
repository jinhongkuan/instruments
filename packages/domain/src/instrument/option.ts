import { Schema } from 'effect'

import { AssetId, Leverage, PriceRatio, VenueId } from './common'

// ---------------------------------------------------------------------------
// Call option. Convex payoff, carry is premium (prepaid and decaying) or a
// streaming fee (Panoptic). Cannot be liquidated as a buyer; dies at expiry if
// out of the money. Leverage is NOT a parameter: it is emergent from strike and
// expiry choice, so `quote` must search the chain for the contract whose
// effective leverage (delta × spot / premium) is closest to the request.
// ---------------------------------------------------------------------------

export const OptionStyle = Schema.Literals([
  'European', // Deribit, Binance, CME: fixed expiry, premium paid once
  'Perpetual', // Panoptic: no expiry, premium streams against a liquidity range
])
export type OptionStyle = typeof OptionStyle.Type

/** One contract in a chain at observation time. */
export const OptionQuote = Schema.Struct({
  venueId: VenueId,
  assetId: AssetId,
  observedAt: Schema.String,
  style: OptionStyle,
  type: Schema.Literals(['Call', 'Put']),
  strike: Schema.Number,
  /** None for perpetual options. */
  expiry: Schema.Option(Schema.String),
  /** Premium per unit of underlying, in quote currency. For streaming options, the current accrual rate per year. */
  premium: Schema.Number,
  impliedVol: Schema.Option(Schema.Number),
  delta: Schema.Option(Schema.Number),
  gamma: Schema.Option(Schema.Number),
  theta: Schema.Option(Schema.Number),
  underlyingPrice: Schema.Number,
  bid: Schema.Option(Schema.Number),
  ask: Schema.Option(Schema.Number),
})
export type OptionQuote = typeof OptionQuote.Type

/** Panoptic-specific: a range position standing in for a strike. */
export const RangeTerms = Schema.Struct({
  lowerPrice: Schema.Number,
  upperPrice: Schema.Number,
  /** Spread over the Uniswap fee stream charged to buyers. */
  streamiaSpread: Schema.Number,
})
export type RangeTerms = typeof RangeTerms.Type

export const OptionState = Schema.Struct({
  venueId: VenueId,
  assetId: AssetId,
  observedAt: Schema.String,
  style: OptionStyle,
  chain: Schema.Array(OptionQuote),
  underlyingPrice: Schema.Number,
  /** Risk-free or stable yield used to discount; Deribit quotes in coin, so this matters. */
  discountRate: Schema.Option(Schema.Number),
})
export type OptionState = typeof OptionState.Type

export const OptionQuoteDetail = Schema.Struct({
  selected: OptionQuote,
  /** delta × spot / premium: the leverage the contract actually delivers. */
  effectiveLeverage: Leverage,
  /** Distance between requested and effective leverage, as a fraction. */
  leverageError: Schema.Number,
  /** Contracts per unit of capital. */
  contractsPerCapital: Schema.Number,
  /** For European: days to expiry; if shorter than horizon, a roll is assumed. */
  daysToExpiry: Schema.Option(Schema.Number),
  rollsRequired: Schema.Number,
  /** Terminal price ratio below which the position is worthless at expiry. */
  expiryWorthlessBelow: PriceRatio,
  range: Schema.Option(RangeTerms),
})
export type OptionQuoteDetail = typeof OptionQuoteDetail.Type

// Edge cases this module must handle:
// - no chain for the asset: NotListed (the most common and most informative outcome)
// - chain exists but no contract within tolerance of requested leverage: LeverageNotAttainable with the nearest
// - expiry shorter than horizon: roll with bid-ask paid each roll; disclose rollsRequired
// - expiry longer than horizon: position is marked, not settled; payoff uses model value, not intrinsic
// - Panoptic: premium is a rate not an amount; carryKind Streaming; expiry None; "strike" is a range
// - coin-settled quotes (Deribit): premium in BTC must be converted at observation price
// - puts are out of scope for the long-exposure lens but the schema keeps `type` so the data is not thrown away

// ---------------------------------------------------------------------------
// Formulas. Capital buys contracts; leverage is emergent. To compare with a
// perp held for the horizon, the option is rolled into a like contract at each
// expiry and a spread is paid per roll. Premium is Prepaid carry, amortized
// linearly over days to expiry.
// ---------------------------------------------------------------------------

import { Array, Option, Schema as S } from 'effect'

import {
  DAYS_PER_YEAR,
  type InstrumentModel,
  type LeveragedExposureQuote,
  type Unavailable,
} from './common'

const MS_PER_DAY = 86_400_000

/** Ω = Δ · S / P: how much exposure one unit of premium controls. */
export const effectiveLeverage = (delta: number, underlyingPrice: number, premium: number): number =>
  (delta * underlyingPrice) / premium

export const daysBetween = (fromIso: string, toIso: string): number =>
  (Date.parse(toIso) - Date.parse(fromIso)) / MS_PER_DAY

/** Rolls needed to stay exposed for the horizon with contracts of a given tenor. */
export const rollsRequired = (horizonDays: number, daysToExpiry: number): number =>
  daysToExpiry <= 0 ? 0 : Math.max(0, Math.ceil(horizonDays / daysToExpiry) - 1)

/** Fraction of premium lost crossing the spread once. */
export const spreadFraction = (quote: OptionQuote, fallback: number): number =>
  Option.isSome(quote.bid) && Option.isSome(quote.ask) && quote.premium > 0
    ? Math.max(0, (quote.ask.value - quote.bid.value) / quote.premium)
    : fallback

/** PnL per capital at expiry for a call bought at premium P with strike K, spot S, terminal ratio r. */
export const callPayoff = (strike: number, premium: number, underlyingPrice: number, terminal: number): number =>
  Math.max(0, terminal * underlyingPrice - strike) / premium - 1

/** Terminal ratio at which the call breaks even after roll costs. */
export const callBreakeven = (strike: number, premium: number, underlyingPrice: number, rollCost: number): number =>
  (strike + premium * (1 + rollCost)) / underlyingPrice

type Candidate = Readonly<{ quote: OptionQuote; omega: number; error: number; daysToExpiry: number }>

const toCandidate =
  (observedAt: string, minDays: number, target: number) =>
  (quote: OptionQuote): Option.Option<Candidate> => {
    if (quote.type !== 'Call' || quote.premium <= 0 || Option.isNone(quote.delta) || Option.isNone(quote.expiry)) {
      return Option.none()
    }
    const daysToExpiry = daysBetween(observedAt, quote.expiry.value)
    if (daysToExpiry < minDays) {
      return Option.none()
    }
    const omega = effectiveLeverage(quote.delta.value, quote.underlyingPrice, quote.premium)
    return Option.some({ quote, omega, error: Math.abs(omega - target) / target, daysToExpiry })
  }

/** The listed call whose effective leverage is nearest the target. */
export const selectContract = (
  chain: ReadonlyArray<OptionQuote>,
  observedAt: string,
  target: number,
  minDaysToExpiry: number,
): Option.Option<Candidate> => {
  const candidates = chain
    .flatMap(quote => Array.fromOption(toCandidate(observedAt, minDaysToExpiry, target)(quote)))
    .sort((a, b) => a.error - b.error)
  return Option.fromNullishOr(candidates[0])
}

export const optionModel: InstrumentModel<OptionState, OptionQuoteDetail> = {
  kind: 'Option',

  quote: (state, leverage, horizonDays, conventions): LeveragedExposureQuote | Unavailable => {
    if (state.style === 'Perpetual') {
      return {
        _tag: 'UnsupportedInV1',
        kind: 'Option',
        reason: 'Perpetual (streaming-premium) options need a carry-per-day model; planned for v2',
      }
    }
    if (state.chain.length === 0) {
      return { _tag: 'NotListed', kind: 'Option', assetId: state.assetId }
    }
    const selected = selectContract(state.chain, state.observedAt, leverage, conventions.option.minDaysToExpiry)
    if (Option.isNone(selected)) {
      return { _tag: 'NoObservation', kind: 'Option', observedAt: state.observedAt }
    }
    const { quote, omega, error, daysToExpiry } = selected.value
    if (error > conventions.option.leverageTolerance) {
      return {
        _tag: 'LeverageNotAttainable',
        kind: 'Option',
        requested: leverage,
        maximum: omega,
        reason: `Nearest listed call delivers ${omega.toFixed(2)}x (${(error * 100).toFixed(0)}% off target)`,
      }
    }
    const rolls = rollsRequired(horizonDays, daysToExpiry)
    const rollCost = rolls * spreadFraction(quote, conventions.option.defaultRollSpreadFraction)
    const carryOnCapital = DAYS_PER_YEAR / daysToExpiry
    const detail: OptionQuoteDetail = {
      selected: quote,
      effectiveLeverage: omega,
      leverageError: error,
      contractsPerCapital: 1 / quote.premium,
      daysToExpiry: Option.some(daysToExpiry),
      rollsRequired: rolls,
      expiryWorthlessBelow: quote.strike / quote.underlyingPrice,
      range: Option.none(),
    }
    return {
      kind: 'Option',
      venueId: state.venueId,
      assetId: state.assetId,
      observedAt: state.observedAt,
      leverage,
      achievedLeverage: omega,
      carryKind: 'Prepaid',
      carryRate: carryOnCapital / omega,
      carryOnCapital,
      payoffShape: 'Convex',
      ruinMode: 'Expiry',
      ruinPriceRatio: Option.some(quote.strike / quote.underlyingPrice),
      breakevenPriceRatio: callBreakeven(quote.strike, quote.premium, quote.underlyingPrice, rollCost),
      capitalPerExposure: 1 / omega,
      detail,
      conventionsVersion: conventions.version,
    }
  },

  payoff: (_quote, detail, terminal, _horizonDays) => {
    const { selected, rollsRequired: rolls } = detail
    const rollCost = rolls * spreadFraction(selected, 0.02)
    return callPayoff(selected.strike, selected.premium, selected.underlyingPrice, terminal) - rollCost
  },

  carryStep: (quote, _state, stepHours) => quote.carryOnCapital * (stepHours / 8760),

  decodeDetail: quote => S.decodeUnknownSync(OptionQuoteDetail)(quote.detail),
}
