import { Result, Schema } from 'effect'

import {
  type BusinessCalendar,
  type CalendarExpired,
  LocalDate,
  businessDaysBetween,
  isBusinessDay,
  previousBusinessDay,
} from './calendar'

// ---------------------------------------------------------------------------
// When a source publishes, encoded as a schedule rather than an age. "Is this
// rate late?" is then a comparison of dates: the effective date we hold against
// the one the schedule says should be out by now. A Monday-morning SOFR that is
// three calendar days old is on time; an hour-based staleness check would page.
// ---------------------------------------------------------------------------

export const Publication = Schema.Union([
  /**
   * The value for business day D is published on the next business day at a
   * fixed local time (SOFR: about 08:00 New York, for the previous business day).
   */
  Schema.TaggedStruct('NextBusinessDay', {
    /** Minutes after local midnight. */
    publishAtMinutes: Schema.Number,
    /** IANA zone the publication time is stated in. */
    timeZone: Schema.String,
    /** How long after the publication time a missing value is still on time. */
    graceMinutes: Schema.Number,
  }),
  /** Published continuously (an on-chain rate); late once older than `maxAgeMinutes`. */
  Schema.TaggedStruct('Continuous', { maxAgeMinutes: Schema.Number }),
])
export type Publication = typeof Publication.Type
export type NextBusinessDay = Extract<Publication, { _tag: 'NextBusinessDay' }>

/** SOFR: published around 08:00 ET for the previous U.S. Government Securities business day. */
export const SOFR_PUBLICATION: NextBusinessDay = {
  _tag: 'NextBusinessDay',
  publishAtMinutes: 8 * 60,
  timeZone: 'America/New_York',
  graceMinutes: 120,
}

export const Freshness = Schema.Union([
  Schema.TaggedStruct('Current', {}),
  Schema.TaggedStruct('LateBusinessDays', { expectedEffectiveDate: LocalDate, businessDaysBehind: Schema.Number }),
  Schema.TaggedStruct('LateMinutes', { ageMinutes: Schema.Number }),
])
export type Freshness = typeof Freshness.Type

/** The local calendar date and minute of day of an instant in an IANA zone. Handles DST. */
export const zonedDateTime = (now: Date, timeZone: string): { date: LocalDate; minutes: number } => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '00'
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  }
}

/**
 * The newest effective date a NextBusinessDay source should have published by
 * `now`. The latest publication day is today if it is a business day and the
 * publication time has passed, otherwise the previous business day; the value
 * published that day is for the business day before it.
 */
export const expectedLatestEffectiveDate = (
  publication: NextBusinessDay,
  cal: BusinessCalendar,
  now: Date,
): Result.Result<LocalDate, CalendarExpired> => {
  const { date: today, minutes } = zonedDateTime(now, publication.timeZone)
  const todayIsBusiness = isBusinessDay(cal, today)
  if (Result.isFailure(todayIsBusiness)) return Result.fail(todayIsBusiness.failure)
  const publishedToday = todayIsBusiness.success && minutes >= publication.publishAtMinutes
  const publicationDay = publishedToday ? Result.succeed(today) : previousBusinessDay(cal, today)
  if (Result.isFailure(publicationDay)) return Result.fail(publicationDay.failure)
  return previousBusinessDay(cal, publicationDay.success)
}

/** Whether a held value is as new as its publication schedule says it should be at `now`. */
export const freshness = (
  publication: Publication,
  cal: BusinessCalendar,
  held: { effectiveDate: LocalDate; publishedAt: string },
  now: Date,
): Result.Result<Freshness, CalendarExpired> => {
  if (publication._tag === 'Continuous') {
    const ageMinutes = (now.getTime() - Date.parse(held.publishedAt)) / 60_000
    return Result.succeed(ageMinutes <= publication.maxAgeMinutes ? { _tag: 'Current' } : { _tag: 'LateMinutes', ageMinutes })
  }
  const graced = new Date(now.getTime() - publication.graceMinutes * 60_000)
  const expected = expectedLatestEffectiveDate(publication, cal, graced)
  if (Result.isFailure(expected)) return Result.fail(expected.failure)
  if (held.effectiveDate >= expected.success) return Result.succeed({ _tag: 'Current' })
  const behind = businessDaysBetween(cal, held.effectiveDate, expected.success)
  if (Result.isFailure(behind)) return Result.fail(behind.failure)
  return Result.succeed({
    _tag: 'LateBusinessDays',
    expectedEffectiveDate: expected.success,
    businessDaysBehind: behind.success,
  })
}
