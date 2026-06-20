import { describe, expect, it } from 'vitest'
import type { Recurrence } from '@cat-factory/kernel'
import { computeNextRun, isWithinWindow, localParts } from './schedule.logic.js'

const HOUR = 60 * 60 * 1000

function recurrence(partial: Partial<Recurrence> = {}): Recurrence {
  return {
    intervalHours: 24,
    weekdays: [],
    windowStartHour: null,
    windowEndHour: null,
    timezone: 'UTC',
    ...partial,
  }
}

// A fixed reference instant: 2026-06-15 is a Monday. 09:00:00 UTC.
const MON_0900 = Date.UTC(2026, 5, 15, 9, 0, 0)

describe('localParts', () => {
  it('reads weekday + hour in the given timezone', () => {
    expect(localParts(MON_0900, 'UTC')).toEqual({ weekday: 1, hour: 9 })
    // Helsinki is UTC+3 in June (DST): 09:00 UTC → 12:00 local.
    expect(localParts(MON_0900, 'Europe/Helsinki')).toEqual({ weekday: 1, hour: 12 })
  })

  it('normalises midnight to hour 0', () => {
    expect(localParts(Date.UTC(2026, 5, 15, 0, 0, 0), 'UTC').hour).toBe(0)
  })
})

describe('isWithinWindow', () => {
  it('accepts any instant with no constraints', () => {
    expect(isWithinWindow(MON_0900, recurrence())).toBe(true)
  })

  it('honours the weekday allow-list', () => {
    // Only Tue–Thu (2,3,4): a Monday is excluded.
    expect(isWithinWindow(MON_0900, recurrence({ weekdays: [2, 3, 4] }))).toBe(false)
    expect(isWithinWindow(MON_0900, recurrence({ weekdays: [1] }))).toBe(true)
  })

  it('honours a business-hours window [9,17)', () => {
    const r = recurrence({ windowStartHour: 9, windowEndHour: 17 })
    expect(isWithinWindow(Date.UTC(2026, 5, 15, 8, 0, 0), r)).toBe(false)
    expect(isWithinWindow(Date.UTC(2026, 5, 15, 9, 0, 0), r)).toBe(true)
    expect(isWithinWindow(Date.UTC(2026, 5, 15, 16, 0, 0), r)).toBe(true)
    expect(isWithinWindow(Date.UTC(2026, 5, 15, 17, 0, 0), r)).toBe(false)
  })

  it('handles a window that wraps past midnight [22,6)', () => {
    const r = recurrence({ windowStartHour: 22, windowEndHour: 6 })
    expect(isWithinWindow(Date.UTC(2026, 5, 15, 23, 0, 0), r)).toBe(true)
    expect(isWithinWindow(Date.UTC(2026, 5, 15, 3, 0, 0), r)).toBe(true)
    expect(isWithinWindow(Date.UTC(2026, 5, 15, 12, 0, 0), r)).toBe(false)
  })
})

describe('computeNextRun', () => {
  it('advances by the interval when the window is open', () => {
    const next = computeNextRun(MON_0900, recurrence({ intervalHours: 6 }))
    expect(next).toBe(MON_0900 + 6 * HOUR)
  })

  it('rolls forward to the next business-hour start when the interval lands outside it', () => {
    // Fire at 02:00 with a Mon–Fri 09:00–17:00 window → lands at 09:00 the same day.
    const at0200 = Date.UTC(2026, 5, 15, 2, 0, 0)
    const r = recurrence({
      intervalHours: 6, // 02:00 + 6h = 08:00, still before the 09:00 window
      weekdays: [1, 2, 3, 4, 5],
      windowStartHour: 9,
      windowEndHour: 17,
    })
    const next = computeNextRun(at0200, r)
    expect(localParts(next, 'UTC')).toEqual({ weekday: 1, hour: 9 })
  })

  it('skips an excluded weekday to the next allowed day', () => {
    // Friday 12:00 + 24h = Saturday 12:00; with a Mon–Fri window it rolls to Monday.
    const fri1200 = Date.UTC(2026, 5, 19, 12, 0, 0) // 2026-06-19 is a Friday
    const r = recurrence({ intervalHours: 24, weekdays: [1, 2, 3, 4, 5] })
    const next = computeNextRun(fri1200, r)
    expect(localParts(next, 'UTC').weekday).toBe(1) // Monday
  })

  it('snaps fires to the top of the hour', () => {
    const offset = MON_0900 + 17 * 60 * 1000 // 09:17
    const next = computeNextRun(offset, recurrence({ intervalHours: 1 }))
    expect(next % HOUR).toBe(0)
  })
})
