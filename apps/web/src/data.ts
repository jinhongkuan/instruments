import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Manifest, TickerBundle } from '@instruments/domain'

/** Where bundles are served from: the R2 bucket's public URL in production, the dev server locally. */
export const BUNDLES_BASE_URL: string = import.meta.env.VITE_BUNDLES_URL ?? '/bundles'

/**
 * Where the charts' numbers come from right now. There is no synthetic
 * fallback: without a live bundle the dashboard says why and draws nothing.
 */
export const DataSource = defineTaggedUnion({
  LoadingMarketData: {},
  Live: { manifest: Manifest, bundle: TickerBundle },
  /** `retryable` is false when the ticker simply has no market, true for fetch failures. */
  Unavailable: { reason: Schema.String, retryable: Schema.Boolean },
})
export type DataSource = typeof DataSource.Type
