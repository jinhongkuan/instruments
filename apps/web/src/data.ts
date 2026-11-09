import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

import { Manifest, TickerBundle } from '@instruments/domain'

/** Where bundles are served from: the R2 bucket's public URL in production, the dev server locally. */
export const BUNDLES_BASE_URL: string = import.meta.env.VITE_BUNDLES_URL ?? '/bundles'

/** Which data the charts are drawn from right now. */
export const DataSource = defineTaggedUnion({
  LoadingMarketData: {},
  Live: { manifest: Manifest, bundle: TickerBundle },
  Synthetic: { reason: Schema.String },
})
export type DataSource = typeof DataSource.Type
