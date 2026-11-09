import { Result } from 'effect'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  US_GOVERNMENT_SECURITIES as CAL,
  businessDaysBetween,
  calendarMismatches,
  isBusinessDay,
  nextBusinessDay,
} from './calendar'
import { SOFR_PUBLICATION, expectedLatestEffectiveDate, freshness, zonedDateTime } from './publication'

const NO_GRACE = { ...SOFR_PUBLICATION, graceMinutes: 0 } as const
const expected = (iso: string) => expectedLatestEffectiveDate(NO_GRACE, CAL, new Date(iso))
const ok = <A>(r: Result.Result<A, unknown>): A => {
  if (Result.isFailure(r)) throw new Error(`expected success, got ${JSON.stringify(r.failure)}`)
  return r.success
}

describe('SOFR expected latest effective date', () => {
  // November 2026 is EST (UTC−5); July is EDT (UTC−4).
  it.each([
    ['Sun 8 Nov, any time: Friday is published Monday', '2026-11-08T17:00:00Z', '2026-11-05'],
    ['Mon 9 Nov 07:00 ET: before publication', '2026-11-09T12:00:00Z', '2026-11-05'],
    ['Mon 9 Nov 08:00 ET: Friday is out', '2026-11-09T13:00:00Z', '2026-11-06'],
    ['Thu 12 Nov 09:00 ET: Wed 11 Nov is Veterans Day', '2026-11-12T14:00:00Z', '2026-11-10'],
    ['Fri 27 Nov 09:00 ET: Thanksgiving Thursday', '2026-11-27T14:00:00Z', '2026-11-25'],
    ['Tue 14 Jul 07:59 EDT', '2026-07-14T11:59:00Z', '2026-07-10'],
    ['Tue 14 Jul 08:00 EDT', '2026-07-14T12:00:00Z', '2026-07-13'],
    ['Mon 6 Jul 09:00 EDT: Fri 3 Jul observed holiday', '2026-07-06T13:00:00Z', '2026-07-02'],
  ])('%s', (_, now, effective) => {
    expect(ok(expected(now))).toBe(effective)
  })

  it('reads local time across the DST change', () => {
    expect(zonedDateTime(new Date('2026-11-01T05:30:00Z'), 'America/New_York')).toEqual({ date: '2026-11-01', minutes: 90 })
    expect(zonedDateTime(new Date('2026-11-01T06:30:00Z'), 'America/New_York')).toEqual({ date: '2026-11-01', minutes: 90 })
  })

  it('refuses to guess past the calendar', () => {
    const r = expected('2027-01-05T15:00:00Z')
    expect(Result.isFailure(r) && r.failure._tag).toBe('CalendarExpired')
    const after = nextBusinessDay(CAL, '2026-12-31')
    expect(Result.isFailure(after)).toBe(true)
  })

  it('is a business day before today, and never moves backwards in time', () => {
    const from = Date.parse('2025-01-10T00:00:00Z')
    const to = Date.parse('2026-12-28T00:00:00Z')
    fc.assert(
      fc.property(fc.integer({ min: from, max: to }), fc.integer({ min: 0, max: 5 * 86_400_000 }), (t, dt) => {
        const a = ok(expectedLatestEffectiveDate(NO_GRACE, CAL, new Date(t)))
        const b = ok(expectedLatestEffectiveDate(NO_GRACE, CAL, new Date(Math.min(t + dt, to))))
        const today = zonedDateTime(new Date(t), 'America/New_York').date
        return ok(isBusinessDay(CAL, a)) && a < today && a <= b
      }),
    )
  })
})

describe('freshness', () => {
  const held = (effectiveDate: string) => ({ effectiveDate, publishedAt: '2026-11-06T13:00:00Z' })
  const at = (effectiveDate: string, now: string) => ok(freshness(SOFR_PUBLICATION, CAL, held(effectiveDate), new Date(now)))

  it('Monday morning with Thursday’s rate is on time', () => {
    expect(at('2026-11-05', '2026-11-09T12:00:00Z')).toEqual({ _tag: 'Current' })
  })

  it('stays current through the grace window after publication', () => {
    expect(at('2026-11-05', '2026-11-09T14:59:00Z')).toEqual({ _tag: 'Current' })
    expect(at('2026-11-05', '2026-11-09T15:01:00Z')).toEqual({
      _tag: 'LateBusinessDays',
      expectedEffectiveDate: '2026-11-06',
      businessDaysBehind: 1,
    })
  })

  it('counts business days, not calendar days, across a holiday', () => {
    expect(at('2026-11-06', '2026-11-12T16:00:00Z')).toEqual({
      _tag: 'LateBusinessDays',
      expectedEffectiveDate: '2026-11-10',
      businessDaysBehind: 2,
    })
  })

  it('a continuous source is late by age', () => {
    const r = ok(freshness({ _tag: 'Continuous', maxAgeMinutes: 60 }, CAL, held('2026-11-06'), new Date('2026-11-06T15:00:00Z')))
    expect(r).toEqual({ _tag: 'LateMinutes', ageMinutes: 120 })
  })
})

describe('calendar', () => {
  it('Friday’s rate applies through the weekend', () => {
    expect(ok(nextBusinessDay(CAL, '2026-11-06'))).toBe('2026-11-09')
    expect(ok(nextBusinessDay(CAL, '2026-11-10'))).toBe('2026-11-12')
  })

  it('counts the half-open range', () => {
    expect(ok(businessDaysBetween(CAL, '2026-11-06', '2026-11-06'))).toBe(0)
    expect(ok(businessDaysBetween(CAL, '2026-11-06', '2026-11-13'))).toBe(4)
  })

  it('reports where a published series disagrees with the calendar', () => {
    const published = ['2026-11-09', '2026-11-11', '2026-11-12']
    expect(ok(calendarMismatches(CAL, published, '2026-11-09', '2026-11-12'))).toEqual({
      missingFromSeries: ['2026-11-10'],
      publishedOnNonBusinessDay: ['2026-11-11'],
    })
  })
})
