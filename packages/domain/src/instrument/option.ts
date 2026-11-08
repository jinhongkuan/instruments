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
