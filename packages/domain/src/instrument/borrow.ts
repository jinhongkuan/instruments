import { Schema } from 'effect'

import { AssetId, PriceRatio, VenueId } from './common'

// ---------------------------------------------------------------------------
// Spot + borrow. Linear payoff, carry is interest on the borrowed leg,
// liquidation when loan-to-value crosses the lender's threshold. Leverage is
// reached by borrowing the quote asset against the spot position, possibly in
// loops; it is capped by the collateral factor.
// ---------------------------------------------------------------------------

/** Interest on the borrowed asset (usually a stablecoin) at observation time. */
export const BorrowRateObservation = Schema.Struct({
  venueId: VenueId,
  /** The asset being borrowed, not the asset being held. */
  debtAssetId: AssetId,
  observedAt: Schema.String,
  /** Annualized, as the lender quotes it. */
  borrowApr: Schema.Number,
  supplyApr: Schema.Option(Schema.Number),
  utilization: Schema.Option(Schema.Number),
  /** Fixed-term markets (Morpho fixed, Pendle) set this; variable markets leave it None. */
  fixedTermDays: Schema.Option(Schema.Number),
})
export type BorrowRateObservation = typeof BorrowRateObservation.Type

/** Collateral parameters for holding `assetId` against the debt asset. */
export const CollateralTerms = Schema.Struct({
  venueId: VenueId,
  assetId: AssetId,
  debtAssetId: AssetId,
  /** Maximum loan-to-value at which new borrowing is allowed. */
  maxLtv: Schema.Number,
  /** LTV at which the position can be liquidated. Always >= maxLtv. */
  liquidationLtv: Schema.Number,
  /** Fraction of collateral seized as penalty on liquidation. */
  liquidationPenalty: Schema.Number,
  /** Whether the venue allows looping (re-depositing borrowed funds as collateral). */
  loopingAllowed: Schema.Boolean,
})
export type CollateralTerms = typeof CollateralTerms.Type

export const BorrowState = Schema.Struct({
  venueId: VenueId,
  assetId: AssetId,
  observedAt: Schema.String,
  rate: BorrowRateObservation,
  collateral: CollateralTerms,
  /** Spot price of the held asset in the debt asset. */
  spotPrice: Schema.Number,
})
export type BorrowState = typeof BorrowState.Type

export const BorrowQuoteDetail = Schema.Struct({
  /** Borrowed notional per unit of capital to reach the achieved leverage. */
  debtPerCapital: Schema.Number,
  /** Loops needed; 0 means a single borrow against the initial deposit. */
  loops: Schema.Number,
  liquidationPriceRatio: PriceRatio,
  liquidationPenalty: Schema.Number,
  /** Supply yield on the held asset, if any, netted against borrow cost. */
  supplyAprOnCollateral: Schema.Option(Schema.Number),
})
export type BorrowQuoteDetail = typeof BorrowQuoteDetail.Type

// Edge cases this module must handle:
// - leverage above 1 / (1 - maxLtv): LeverageNotAttainable even with infinite loops
// - looping disallowed: achievedLeverage caps at 1 + maxLtv
// - two assets, not one: the held asset and the debt asset have separate oracles and both can move
// - utilization spikes: borrowApr is floating but never sign-flips, unlike funding
// - asset listed as debt but not as collateral: NotListed for SpotBorrow even though the venue "has" the asset
// - fixed-term markets: carryKind is Fixed and the term may be shorter than the horizon (roll needed)
