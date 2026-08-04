import { describe, expect, it } from 'vitest'
import {
  BURN_RATE_WINDOW_MS,
  MIN_OBSERVED_SPAN_MS,
  type SpendAlertState,
  forecastSpend,
  spendAlertEscalated,
  spendAlertFiring,
  spendAlertState,
} from './forecast.logic.js'

const DAY = 24 * 60 * 60 * 1000
const PERIOD_START = Date.UTC(2026, 6, 1)
const PERIOD_END = Date.UTC(2026, 7, 1)

/** A forecast input at `now`, with sensible defaults for everything the case doesn't pin. */
function input(overrides: Partial<Parameters<typeof forecastSpend>[0]> = {}) {
  const now = overrides.now ?? PERIOD_START + 10 * DAY
  return {
    costSpent: 0,
    costLimit: 100,
    windowCost: 0,
    windowFirstSeenAt: null,
    windowStart: now - BURN_RATE_WINDOW_MS,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    now,
    ...overrides,
  }
}

describe('forecastSpend', () => {
  it('derives the burn rate from the full window when history spans it', () => {
    const now = PERIOD_START + 10 * DAY
    const f = forecastSpend(
      input({ now, windowCost: 70, windowFirstSeenAt: now - BURN_RATE_WINDOW_MS, costSpent: 40 }),
    )
    expect(f.burnRatePerDay).toBeCloseTo(10)
    expect(f.confidence).toBe('ok')
    // 21 days left in July at 10/day, on top of the 40 already spent.
    expect(f.projectedTotal).toBeCloseTo(40 + 21 * 10)
  })

  it('divides by the OBSERVED span, not the nominal window, for a scope younger than the window', () => {
    const now = PERIOD_START + 10 * DAY
    // Two full days of history inside a seven-day window: 20 EUR is 10/day, not 20/7.
    const f = forecastSpend(input({ now, windowCost: 20, windowFirstSeenAt: now - 2 * DAY }))
    expect(f.burnRatePerDay).toBeCloseTo(10)
  })

  it('withholds the projection when the observed span is too short to mean anything', () => {
    const now = PERIOD_START + 10 * DAY
    const f = forecastSpend(
      input({ now, windowCost: 20, windowFirstSeenAt: now - (MIN_OBSERVED_SPAN_MS - 1) }),
    )
    expect(f.confidence).toBe('insufficient-history')
    expect(f.projectedTotal).toBeNull()
    expect(f.projectedExhaustionAt).toBeNull()
    // The rate is still reported: it is the projection that is unpublishable, not the measurement.
    expect(f.burnRatePerDay).toBeGreaterThan(0)
  })

  it('treats an empty window as a confident zero rather than missing history', () => {
    const f = forecastSpend(input({ costSpent: 40, windowCost: 0, windowFirstSeenAt: null }))
    expect(f.confidence).toBe('ok')
    expect(f.burnRatePerDay).toBe(0)
    // Nothing is being spent, so the projection is exactly what is already spent.
    expect(f.projectedTotal).toBeCloseTo(40)
    expect(f.projectedExhaustionAt).toBeNull()
  })

  it('dates the projected exhaustion inside the period, and reports none beyond it', () => {
    const now = PERIOD_START + 10 * DAY
    const soon = forecastSpend(
      input({ now, costSpent: 40, windowCost: 70, windowFirstSeenAt: now - BURN_RATE_WINDOW_MS }),
    )
    // 60 EUR of headroom at 10/day lands six days out, well inside July.
    expect(soon.projectedExhaustionAt).toBeCloseTo(now + 6 * DAY, -3)

    const never = forecastSpend(
      input({ now, costSpent: 40, windowCost: 7, windowFirstSeenAt: now - BURN_RATE_WINDOW_MS }),
    )
    // 1/day against 60 EUR of headroom needs 60 days; the period ends in 21.
    expect(never.projectedExhaustionAt).toBeNull()
    expect(never.projectedTotal).toBeCloseTo(61)
  })

  it('reports no exhaustion date once the limit is already reached (the gate has acted)', () => {
    const now = PERIOD_START + 10 * DAY
    const f = forecastSpend(
      input({ now, costSpent: 120, windowCost: 70, windowFirstSeenAt: now - BURN_RATE_WINDOW_MS }),
    )
    expect(f.consumedFraction).toBeCloseTo(1.2)
    expect(f.projectedExhaustionAt).toBeNull()
  })

  it('reports a zero consumed fraction for an inactive (unlimited) tier', () => {
    const f = forecastSpend(input({ costSpent: 500, costLimit: Number.POSITIVE_INFINITY }))
    expect(f.consumedFraction).toBe(0)
    expect(f.projectedExhaustionAt).toBeNull()
  })
})

describe('spendAlertState', () => {
  const base = forecastSpend(
    input({
      costSpent: 85,
      windowCost: 70,
      windowFirstSeenAt: PERIOD_START + 3 * DAY,
      now: PERIOD_START + 10 * DAY,
    }),
  )

  it('names the highest crossed threshold', () => {
    const state = spendAlertState(base, PERIOD_START, 100, [0.5, 0.8, 0.95])
    expect(state.threshold).toBe(0.8)
    expect(spendAlertFiring(state)).toBe(true)
  })

  it('fires a projected overrun below the threshold, and stops once the limit is actually reached', () => {
    const now = PERIOD_START + 10 * DAY
    // 10 EUR spent of 100 but burning 10/day with 21 days left: nowhere near 80%, badly over pace.
    const pacing = forecastSpend(
      input({ now, costSpent: 10, windowCost: 70, windowFirstSeenAt: now - BURN_RATE_WINDOW_MS }),
    )
    const pacingState = spendAlertState(pacing, PERIOD_START, 100)
    expect(pacingState.threshold).toBeNull()
    expect(pacingState.projectedOverrun).toBe(true)

    const spent = forecastSpend(
      input({ now, costSpent: 100, windowCost: 70, windowFirstSeenAt: now - BURN_RATE_WINDOW_MS }),
    )
    expect(spendAlertState(spent, PERIOD_START, 100).projectedOverrun).toBe(false)
  })

  it('does not report an unpublishable projection as an overrun', () => {
    const now = PERIOD_START + 10 * DAY
    const green = forecastSpend(
      input({ now, costSpent: 5, windowCost: 40, windowFirstSeenAt: now - 60 * 60 * 1000 }),
    )
    expect(green.confidence).toBe('insufficient-history')
    expect(spendAlertState(green, PERIOD_START, 100).projectedOverrun).toBe(false)
  })

  it('fires nothing for an inactive tier however much it spent', () => {
    const f = forecastSpend(input({ costSpent: 5_000, costLimit: Number.POSITIVE_INFINITY }))
    expect(spendAlertFiring(spendAlertState(f, PERIOD_START, Number.POSITIVE_INFINITY))).toBe(false)
  })
})

describe('spendAlertEscalated', () => {
  const at80: SpendAlertState = {
    periodStart: PERIOD_START,
    threshold: 0.8,
    projectedOverrun: false,
  }

  it('escalates when nothing has been notified yet', () => {
    expect(spendAlertEscalated(null, at80)).toBe(true)
  })

  it('does not re-escalate the same crossing within the period', () => {
    expect(spendAlertEscalated(at80, at80)).toBe(false)
  })

  it('escalates on a higher threshold and on a newly projected overrun', () => {
    expect(spendAlertEscalated(at80, { ...at80, threshold: 0.95 })).toBe(true)
    expect(spendAlertEscalated(at80, { ...at80, projectedOverrun: true })).toBe(true)
  })

  it('re-arms at the period rollover', () => {
    const nextPeriod = { ...at80, periodStart: PERIOD_END }
    expect(spendAlertEscalated(at80, nextPeriod)).toBe(true)
  })

  it('never escalates on a fall-back or on a state that fires nothing', () => {
    const quiet: SpendAlertState = {
      periodStart: PERIOD_START,
      threshold: null,
      projectedOverrun: false,
    }
    expect(spendAlertEscalated(at80, quiet)).toBe(false)
    expect(spendAlertEscalated({ ...at80, threshold: 0.95 }, at80)).toBe(false)
  })
})
