import { Schema } from 'effect'

/**
 * The assumptions that make a cross-instrument counterfactual fair. Every
 * quote is stamped with the conventions that produced it, so a change here
 * never silently rewrites history. Defaults are chosen to favor simplicity and
 * to be disclosable in one sentence each on the dashboard.
 */
export const Conventions = Schema.Struct({
  version: Schema.String,
  perp: Schema.Struct({
    /** Liquidation is evaluated on the same price as funding notional (oracle). v2 may split mark and oracle. */
    liquidateOnOracle: Schema.Boolean,
    /** Equity left after liquidation, per unit of capital. 0 means the whole margin is lost. */
    equityRecoveredOnLiquidation: Schema.Number,
  }),
  benchmark: Schema.Struct({
    /**
     * Spot + borrow is a benchmark with unlimited credit at a dollar rate. The
     * rate observed at entry is treated as fixed for the horizon, so the line
     * is the "against a loan" baseline every other instrument is read against.
     */
    lockRateForHorizon: Schema.Boolean,
  }),
  option: Schema.Struct({
    /** Accept a contract whose effective leverage is within this fraction of the target. */
    leverageTolerance: Schema.Number,
    /** When a chain has no bid/ask, assume this fraction of premium is lost per roll. */
    defaultRollSpreadFraction: Schema.Number,
    /** Ignore contracts expiring sooner than this; they roll too often to be a fair comparison. */
    minDaysToExpiry: Schema.Number,
    /** Premium is treated as spent evenly over days to expiry (Prepaid carry). */
    amortization: Schema.Literals(['Linear']),
  }),
})
export type Conventions = typeof Conventions.Type

export const DEFAULT_CONVENTIONS: Conventions = {
  version: '2026-11-v1',
  perp: { liquidateOnOracle: true, equityRecoveredOnLiquidation: 0 },
  benchmark: { lockRateForHorizon: true },
  option: { leverageTolerance: 0.25, defaultRollSpreadFraction: 0.02, minDaysToExpiry: 7, amortization: 'Linear' },
}
