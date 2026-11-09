import { Effect, Schema } from 'effect'

import { type Fetch, SourceError, fetchJson } from './http'

// New York Fed Markets API: SOFR, no key. The rate for business day D is
// published around 08:00 ET on the next business day and may be revised the
// same day; see domain/instrument/publication.ts for the schedule.

const SofrResponse = Schema.Struct({
  refRates: Schema.Array(
    Schema.Struct({
      effectiveDate: Schema.String,
      type: Schema.String,
      percentRate: Schema.Number,
      revisionIndicator: Schema.optional(Schema.String),
    }),
  ),
})

export interface BenchmarkRow {
  readonly source: 'SOFR'
  readonly effectiveDate: string
  /** Annualized, simple fraction. */
  readonly apr: number
  readonly revised: boolean
}

export const parseSofr = (json: unknown): ReadonlyArray<BenchmarkRow> =>
  Schema.decodeUnknownSync(SofrResponse)(json)
    .refRates.filter(rate => rate.type === 'SOFR')
    .map(rate => ({
      source: 'SOFR' as const,
      effectiveDate: rate.effectiveDate,
      apr: rate.percentRate / 100,
      revised: (rate.revisionIndicator ?? '').trim().length > 0,
    }))

export class NyFed {
  constructor(private readonly fetchImpl: Fetch) {}

  /** The last `n` published SOFR fixings, newest first. */
  sofr(n: number): Effect.Effect<ReadonlyArray<BenchmarkRow>, SourceError> {
    return fetchJson(
      this.fetchImpl,
      'nyfed',
      `https://markets.newyorkfed.org/api/rates/secured/sofr/last/${n}.json`,
      undefined,
      parseSofr,
    )
  }
}
