import type { Recurrence } from '@cat-factory/kernel'

// Pure cadence math for recurring pipelines. A schedule fires every
// `intervalHours`, but only at instants inside its allowed window — a set of
// weekdays plus an hour-of-day range, evaluated in the schedule's IANA timezone.
// `computeNextRun` advances by the interval and then rolls forward to the next
// eligible instant; `isWithinWindow` answers whether a given instant is eligible.
//
// Timezone handling uses `Intl.DateTimeFormat` (available in both workerd and
// Node), so we never depend on the host's local zone.

const HOUR_MS = 60 * 60 * 1000

/** The local weekday (0=Sun..6=Sat) and hour (0..23) of `ms` in `timezone`. */
export function localParts(ms: number, timezone: string): { weekday: number; hour: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: 'numeric',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(ms))
  const weekdayName = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  let hourStr = parts.find((p) => p.type === 'hour')?.value ?? '0'
  // `hour12: false` can render midnight as "24"; normalize to 0.
  if (hourStr === '24') hourStr = '0'
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return { weekday: weekdays[weekdayName] ?? 0, hour: Number(hourStr) }
}

/** Whether the allowed-day set permits `weekday` (empty set = every day). */
function weekdayAllowed(recurrence: Recurrence, weekday: number): boolean {
  return recurrence.weekdays.length === 0 || recurrence.weekdays.includes(weekday)
}

/**
 * Whether `hour` falls in the allowed window. Both bounds null = any hour. The
 * window is [start, end): a start without an end runs from `start` to midnight; an
 * end without a start runs from midnight to `end`. A `start >= end` window wraps
 * past midnight (e.g. 22→6 means 22,23,0..5).
 */
function hourAllowed(recurrence: Recurrence, hour: number): boolean {
  const { windowStartHour: start, windowEndHour: end } = recurrence
  if (start === null && end === null) return true
  const lo = start ?? 0
  const hi = end ?? 24
  if (lo < hi) return hour >= lo && hour < hi
  // Wrapping window (lo >= hi): allowed outside the [hi, lo) gap.
  return hour >= lo || hour < hi
}

/** Whether `ms` is an instant the schedule is allowed to fire at. */
export function isWithinWindow(ms: number, recurrence: Recurrence): boolean {
  const { weekday, hour } = localParts(ms, recurrence.timezone)
  return weekdayAllowed(recurrence, weekday) && hourAllowed(recurrence, hour)
}

/**
 * The next instant at or after `fromMs` that satisfies the window, snapping to the
 * top of the hour. Steps hour-by-hour (bounded) so DST transitions and wrapping
 * windows are handled by the same `isWithinWindow` check rather than date math.
 */
function nextEligible(fromMs: number, recurrence: Recurrence): number {
  // Snap up to the next whole hour boundary so fires land at :00.
  let candidate = Math.ceil(fromMs / HOUR_MS) * HOUR_MS
  // At most a year of hourly steps — guards against an impossible window.
  for (let i = 0; i < 24 * 366; i++) {
    if (isWithinWindow(candidate, recurrence)) return candidate
    candidate += HOUR_MS
  }
  return candidate
}

/**
 * The next fire time after `fromMs`: advance by `intervalHours`, then roll forward
 * to the next instant inside the allowed weekday/hour window.
 */
export function computeNextRun(fromMs: number, recurrence: Recurrence): number {
  const base = fromMs + recurrence.intervalHours * HOUR_MS
  return nextEligible(base, recurrence)
}
