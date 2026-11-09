import { Result, Schema } from 'effect'

// ---------------------------------------------------------------------------
// Business-day calendars. A calendar knows its holidays only for the range it
// covers; outside that range every answer is CalendarExpired, never a guess.
// That makes "add next year's holidays" a visible failure instead of a silent
// off-by-one on the first holiday nobody entered.
// ---------------------------------------------------------------------------

/** A calendar date with no time and no zone: YYYY-MM-DD. */
export const LocalDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))
export type LocalDate = typeof LocalDate.Type

export const BusinessCalendar = Schema.Struct({
  id: Schema.String,
  /** Weekdays with no business. Weekends are never business days and are not listed. */
  holidays: Schema.Array(LocalDate),
  /** First and last dates for which `holidays` is known to be complete. */
  coversFrom: LocalDate,
  coversThrough: LocalDate,
})
export type BusinessCalendar = typeof BusinessCalendar.Type

export const CalendarExpired = Schema.TaggedStruct('CalendarExpired', {
  calendarId: Schema.String,
  date: LocalDate,
  coversFrom: LocalDate,
  coversThrough: LocalDate,
})
export type CalendarExpired = typeof CalendarExpired.Type

const DAY_MS = 86_400_000
const toEpochDay = (d: LocalDate): number => Date.parse(`${d}T00:00:00Z`) / DAY_MS
const fromEpochDay = (n: number): LocalDate => new Date(n * DAY_MS).toISOString().slice(0, 10)

export const addDays = (d: LocalDate, n: number): LocalDate => fromEpochDay(toEpochDay(d) + n)

const expired = (cal: BusinessCalendar, date: LocalDate): Result.Result<never, CalendarExpired> =>
  Result.fail({
    _tag: 'CalendarExpired',
    calendarId: cal.id,
    date,
    coversFrom: cal.coversFrom,
    coversThrough: cal.coversThrough,
  })

const covers = (cal: BusinessCalendar, d: LocalDate): boolean => d >= cal.coversFrom && d <= cal.coversThrough

const isWeekend = (d: LocalDate): boolean => {
  const weekday = new Date(`${d}T00:00:00Z`).getUTCDay()
  return weekday === 0 || weekday === 6
}

export const isBusinessDay = (cal: BusinessCalendar, d: LocalDate): Result.Result<boolean, CalendarExpired> =>
  covers(cal, d) ? Result.succeed(!isWeekend(d) && !cal.holidays.includes(d)) : expired(cal, d)

/** Walks one calendar day at a time; a run of non-business days is at most a handful long. */
const stepToBusinessDay = (
  cal: BusinessCalendar,
  from: LocalDate,
  direction: 1 | -1,
): Result.Result<LocalDate, CalendarExpired> => {
  let d = addDays(from, direction)
  for (;;) {
    const answer = isBusinessDay(cal, d)
    if (Result.isFailure(answer)) return Result.fail(answer.failure)
    if (answer.success) return Result.succeed(d)
    d = addDays(d, direction)
  }
}

/** The last business day strictly before `d`. */
export const previousBusinessDay = (cal: BusinessCalendar, d: LocalDate) => stepToBusinessDay(cal, d, -1)

/** The first business day strictly after `d`. */
export const nextBusinessDay = (cal: BusinessCalendar, d: LocalDate) => stepToBusinessDay(cal, d, 1)

/** Business days in the half-open range (from, to]. Zero when `to` is not after `from`. */
export const businessDaysBetween = (
  cal: BusinessCalendar,
  from: LocalDate,
  to: LocalDate,
): Result.Result<number, CalendarExpired> => {
  let count = 0
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    const answer = isBusinessDay(cal, d)
    if (Result.isFailure(answer)) return Result.fail(answer.failure)
    if (answer.success) count++
  }
  return Result.succeed(count)
}

/**
 * Compares a calendar with the dates a source actually published, over
 * [from, to]. Pass a `to` no later than the latest date that should already be
 * published, or not-yet-published days show up as missing.
 */
export const calendarMismatches = (
  cal: BusinessCalendar,
  published: ReadonlyArray<LocalDate>,
  from: LocalDate,
  to: LocalDate,
): Result.Result<{ missingFromSeries: Array<LocalDate>; publishedOnNonBusinessDay: Array<LocalDate> }, CalendarExpired> => {
  const seen = new Set(published)
  const missingFromSeries: Array<LocalDate> = []
  const publishedOnNonBusinessDay: Array<LocalDate> = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const answer = isBusinessDay(cal, d)
    if (Result.isFailure(answer)) return Result.fail(answer.failure)
    if (answer.success && !seen.has(d)) missingFromSeries.push(d)
    if (!answer.success && seen.has(d)) publishedOnNonBusinessDay.push(d)
  }
  return Result.succeed({ missingFromSeries, publishedOnNonBusinessDay })
}

/**
 * U.S. Government Securities business days, the calendar SOFR is published on.
 * 2025 through 2026-11-05 is derived from the NY Fed SOFR series itself (every
 * weekday with no published rate). The rest of 2026 is SIFMA's recommended full
 * closes. Extend coversThrough each year from SIFMA's published recommendations.
 */
export const US_GOVERNMENT_SECURITIES: BusinessCalendar = {
  id: 'us-government-securities',
  coversFrom: '2025-01-01',
  coversThrough: '2026-12-31',
  holidays: [
    '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19',
    '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25',
    '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
    '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
  ],
}
