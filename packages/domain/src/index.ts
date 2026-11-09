// Dashboard DTOs (synthetic for now). These will be derived from LeveragedExposureQuote
// once the instrument models produce real quotes.
export * from './schema'
export { mockComparison } from './mock'
// Real data: the per-ticker bundle the derive job publishes, and the comparison built from it.
export * from './bundle'
export { comparisonFromBundle, fundingAt, interpolate, ruinAt } from './real'

// Domain entities: venues, markets, and the leverage lens shared by all instruments.
export * from './instrument'
