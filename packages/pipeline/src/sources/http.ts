import { Data, Effect, Schedule } from 'effect'

/** A source answered with an error, timed out, or returned something we could not decode. */
export class SourceError extends Data.TaggedError('SourceError')<{
  readonly source: string
  readonly message: string
  readonly status?: number
}> {}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

const RETRY = { times: 3, schedule: Schedule.exponential('500 millis') } as const

/**
 * GET or POST JSON, decode it, and retry transient failures (network errors,
 * 429 and 5xx) with exponential backoff. Decode failures are not retried:
 * a schema drift will not fix itself.
 */
export const fetchJson = <A>(
  fetchImpl: Fetch,
  source: string,
  url: string,
  init: RequestInit | undefined,
  decode: (json: unknown) => A,
): Effect.Effect<A, SourceError> => {
  const attempt = Effect.tryPromise({
    try: async signal => {
      const response = await fetchImpl(url, { ...init, signal })
      const text = await response.text()
      return { status: response.status, text }
    },
    catch: error => new SourceError({ source, message: error instanceof Error ? error.message : String(error) }),
  }).pipe(
    Effect.timeout('20 seconds'),
    Effect.catchTag('TimeoutError', () => Effect.fail(new SourceError({ source, message: 'timed out after 20s' }))),
    Effect.flatMap(({ status, text }) =>
      status === 429 || status >= 500
        ? Effect.fail(new SourceError({ source, message: `HTTP ${status}`, status }))
        : status >= 400
          ? Effect.fail(new SourceError({ source, message: `HTTP ${status}: ${text.slice(0, 200)}`, status: -status }))
          : Effect.succeed(text),
    ),
  )
  return attempt.pipe(
    // Retry transient failures only; a 4xx (status stored negative) is final.
    Effect.retry({ ...RETRY, while: (error: SourceError) => error.status === undefined || error.status > 0 }),
    Effect.flatMap(text =>
      Effect.try({
        try: () => decode(JSON.parse(text)),
        catch: error =>
          new SourceError({ source, message: `could not decode response: ${error instanceof Error ? error.message : String(error)}` }),
      }),
    ),
  )
}

/** Parse a numeric string from a venue payload, rejecting anything non-finite. */
export const num = (value: string | number): number => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`not a finite number: ${String(value)}`)
  }
  return parsed
}

export const HOUR_MS = 3_600_000
export const floorHour = (ms: number): number => Math.floor(ms / HOUR_MS) * HOUR_MS

/**
 * Client-side budget for a per-IP weight limit (Hyperliquid: 1,200 per
 * minute). Each call waits until its weight fits in the trailing minute, so a
 * sweep spreads itself out instead of collecting 429s.
 */
export class WeightBudget {
  private readonly spent: Array<{ at: number; weight: number }> = []
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(weight: number): Effect.Effect<void> {
    return Effect.suspend(() => {
      const cutoff = this.now() - 60_000
      while (this.spent.length > 0 && this.spent[0]!.at <= cutoff) this.spent.shift()
      const used = this.spent.reduce((sum, entry) => sum + entry.weight, 0)
      if (used + weight <= this.perMinute || this.spent.length === 0) {
        this.spent.push({ at: this.now(), weight })
        return Effect.void
      }
      const waitMs = this.spent[0]!.at + 60_000 - this.now() + 10
      return Effect.sleep(`${Math.max(10, waitMs)} millis`).pipe(Effect.andThen(this.take(weight)))
    })
  }
}
