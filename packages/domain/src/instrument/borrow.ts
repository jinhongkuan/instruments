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

// ---------------------------------------------------------------------------
// Formulas. Deposit 1 of capital in spot, borrow the quote asset against it at
// LTV ≤ maxLtv, buy more spot, optionally repeat. Deep-market assumption: every
// loop fills at the observed rate with no price impact.
// ---------------------------------------------------------------------------

import { Option, Schema as S } from 'effect'

import {
  type InstrumentModel,
  type LeveragedExposureQuote,
  type Unavailable,
  linearBreakeven,
  linearNetPayoff,
} from './common'

/**
 * Leverage after n loops at loan-to-value ltv: 1 + ltv + ltv² + … + ltvⁿ = (1 − ltvⁿ⁺¹) / (1 − ltv).
 * n = 0 is unlevered spot. As n → ∞ this tends to 1 / (1 − ltv).
 */
export const leverageAfterLoops = (ltv: number, loops: number): number =>
  ltv <= 0 ? 1 : (1 - Math.pow(ltv, loops + 1)) / (1 - ltv)

export const maxLeverage = (maxLtv: number, maxLoops: number): number => leverageAfterLoops(maxLtv, maxLoops)

/** Smallest loop count whose ceiling reaches the target; 0 when the target is 1x. */
export const loopsRequired = (target: number, maxLtv: number, maxLoops: number): Option.Option<number> => {
  for (let n = 0; n <= maxLoops; n++) {
    if (leverageAfterLoops(maxLtv, n) >= target - 1e-12) {
      return Option.some(n)
    }
  }
  return Option.none()
}

/**
 * Debt per capital is L − 1 and collateral per capital is L · r at price ratio r, so
 *   LTV(r) = (L − 1) / (L · r), and liquidation at LTV = liquidationLtv gives
 *   r* = (L − 1) / (L · liquidationLtv).
 */
export const liquidationPriceRatio = (leverage: number, liquidationLtv: number): Option.Option<number> =>
  leverage <= 1 ? Option.none() : Option.some((leverage - 1) / (leverage * liquidationLtv))

/** Annualized carry on capital: interest on the borrowed leg, net of supply yield on the held leg if netted. */
export const carryOnCapital = (
  leverage: number,
  borrowApr: number,
  supplyApr: Option.Option<number>,
  netSupplyYield: boolean,
): number =>
  borrowApr * (leverage - 1) -
  (netSupplyYield ? Option.getOrElse(supplyApr, () => 0) * leverage : 0)

/** Equity left per capital when liquidated at r*, after the penalty on seized collateral. */
export const equityAtLiquidation = (leverage: number, liquidationRatio: number, penalty: number): number =>
  Math.max(-1, leverage * liquidationRatio * (1 - penalty) - (leverage - 1) - 1)

/** Unsecured credit has no collateral cap; this is a sanity ceiling, not a market constraint. */
export const UNSECURED_LEVERAGE_CAP = 1000

export const borrowModel: InstrumentModel<BorrowState, BorrowQuoteDetail> = {
  kind: 'SpotBorrow',

  quote: (state, leverage, horizonDays, conventions): LeveragedExposureQuote | Unavailable => {
    const { collateral, rate } = state
    if (conventions.borrow.creditModel === 'Unsecured') {
      const carry = carryOnCapital(leverage, rate.borrowApr, rate.supplyApr, conventions.borrow.netSupplyYield)
      const detail: BorrowQuoteDetail = {
        debtPerCapital: leverage - 1,
        loops: 0,
        liquidationPriceRatio: 0,
        liquidationPenalty: 0,
        supplyAprOnCollateral: rate.supplyApr,
      }
      return {
        kind: 'SpotBorrow',
        venueId: state.venueId,
        assetId: state.assetId,
        observedAt: state.observedAt,
        leverage,
        achievedLeverage: leverage,
        carryKind: Option.isSome(rate.fixedTermDays) ? 'Fixed' : 'Floating',
        carryRate: leverage > 0 ? carry / leverage : 0,
        carryOnCapital: carry,
        payoffShape: 'Linear',
        ruinMode: 'None',
        ruinPriceRatio: Option.none(),
        breakevenPriceRatio: linearBreakeven(leverage, carry, horizonDays),
        capitalPerExposure: 1 / leverage,
        detail,
        conventionsVersion: conventions.version,
      }
    }
    const effectiveMaxLoops = collateral.loopingAllowed ? conventions.borrow.maxLoops : 1
    const ceiling = maxLeverage(collateral.maxLtv, effectiveMaxLoops)
    const loops = loopsRequired(leverage, collateral.maxLtv, effectiveMaxLoops)
    if (Option.isNone(loops)) {
      return {
        _tag: 'LeverageNotAttainable',
        kind: 'SpotBorrow',
        requested: leverage,
        maximum: ceiling,
        reason: `maxLtv ${collateral.maxLtv} with ${effectiveMaxLoops} loop(s) caps leverage at ${ceiling.toFixed(2)}x`,
      }
    }
    const carry = carryOnCapital(leverage, rate.borrowApr, rate.supplyApr, conventions.borrow.netSupplyYield)
    const ruin = liquidationPriceRatio(leverage, collateral.liquidationLtv)
    const detail: BorrowQuoteDetail = {
      debtPerCapital: leverage - 1,
      loops: loops.value,
      liquidationPriceRatio: Option.getOrElse(ruin, () => 0),
      liquidationPenalty: collateral.liquidationPenalty,
      supplyAprOnCollateral: rate.supplyApr,
    }
    return {
      kind: 'SpotBorrow',
      venueId: state.venueId,
      assetId: state.assetId,
      observedAt: state.observedAt,
      leverage,
      achievedLeverage: leverage,
      carryKind: Option.isSome(rate.fixedTermDays) ? 'Fixed' : 'Floating',
      carryRate: leverage > 0 ? carry / leverage : 0,
      carryOnCapital: carry,
      payoffShape: 'Linear',
      ruinMode: Option.isSome(ruin) ? 'Liquidation' : 'None',
      ruinPriceRatio: ruin,
      breakevenPriceRatio: linearBreakeven(leverage, carry, horizonDays),
      capitalPerExposure: 1 / leverage,
      detail,
      conventionsVersion: conventions.version,
    }
  },

  payoff: (quote, detail, terminal, horizonDays) =>
    Option.isSome(quote.ruinPriceRatio) && terminal <= quote.ruinPriceRatio.value
      ? equityAtLiquidation(quote.achievedLeverage, quote.ruinPriceRatio.value, detail.liquidationPenalty)
      : Math.max(-1, linearNetPayoff(quote.achievedLeverage, quote.carryOnCapital, terminal, horizonDays)),

  carryStep: (quote, _state, stepHours) => quote.carryOnCapital * (stepHours / 8760),

  decodeDetail: quote => S.decodeUnknownSync(BorrowQuoteDetail)(quote.detail),

  support: (state, conventions) => {
    const loops = state.collateral.loopingAllowed ? conventions.borrow.maxLoops : 1
    const leverageCap =
      conventions.borrow.creditModel === 'Unsecured' ? UNSECURED_LEVERAGE_CAP : maxLeverage(state.collateral.maxLtv, loops)
    return {
      leverage: { _tag: 'Continuous', min: 1, max: leverageCap, pins: [] },
      // Variable-rate markets run indefinitely; a fixed-term market is one maturity (roll beyond it is v2).
      horizonDays: Option.match(state.rate.fixedTermDays, {
        onNone: () => ({ _tag: 'Continuous' as const, min: 1, max: 3650, pins: [] }),
        onSome: term => ({ _tag: 'Discrete' as const, points: [{ value: term, label: `${term}d fixed term` }] }),
      }),
    }
  },
}
