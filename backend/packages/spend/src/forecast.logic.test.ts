import { describe, expect, it } from 'vitest'
import {
  BURN_RATE_WINDOW_MS,
  MIN_OBSERVED_SPAN_MS,
  type SpendAlertState,
  type SpendForecast,
  forecastSpend,
  mergeSpendAlertStates,
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

  it('reports a zero consumed fraction for a zero limit rather than dividing by it', () => {
    // A 0 limit is a real tier ("no paid spend"), and the fraction it implies is not a number.
    // Reporting 0 keeps the alert fold honest; NaN would compare false against every threshold
    // and quietly report a maxed-out tier as fine.
    const f = forecastSpend(input({ costSpent: 20, costLimit: 0 }))
    expect(f.consumedFraction).toBe(0)
  })

  it('reports a zero rate for a window whose whole history is the observation instant', () => {
    const now = PERIOD_START + 10 * DAY
    // The first metered row landed at `now`: nothing has been OBSERVED to divide by, so the rate
    // is zero rather than an infinite one derived from a zero-length span.
    const f = forecastSpend(input({ now, windowCost: 5, windowFirstSeenAt: now }))
    expect(f.burnRatePerDay).toBe(0)
    expect(f.confidence).toBe('insufficient-history')
  })

  it('publishes the projection at exactly the minimum observed span', () => {
    const now = PERIOD_START + 10 * DAY
    const f = forecastSpend(
      input({ now, windowCost: 20, windowFirstSeenAt: now - MIN_OBSERVED_SPAN_MS }),
    )
    expect(f.confidence).toBe('ok')
    expect(f.projectedTotal).not.toBeNull()
  })

  it('reports no exhaustion date at exactly the limit, or when it lands exactly at the period end', () => {
    const now = PERIOD_START + 10 * DAY
    // Spend sitting exactly ON the limit is already the reactive gate's business.
    const atLimit = forecastSpend(
      input({ now, costSpent: 100, windowCost: 70, windowFirstSeenAt: now - BURN_RATE_WINDOW_MS }),
    )
    expect(atLimit.projectedExhaustionAt).toBeNull()

    // 100 EUR of headroom at 10/day is exactly the 10 days left in the period: the limit is
    // reached as the period ends, which is not "inside this period".
    const endOfPeriod = PERIOD_END - 10 * DAY
    const exact = forecastSpend(
      input({
        now: endOfPeriod,
        costSpent: 0,
        windowCost: 70,
        windowFirstSeenAt: endOfPeriod - BURN_RATE_WINDOW_MS,
      }),
    )
    expect(exact.burnRatePerDay).toBeCloseTo(10)
    expect(exact.projectedExhaustionAt).toBeNull()
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

  // The cases below hand `spendAlertState` a forecast literal rather than one `forecastSpend`
  // produced, because the two arguments are independent: the state has to hold for whatever a
  // caller pairs, and only a literal can put a value exactly on a boundary.
  const forecast = (overrides: Partial<SpendForecast> = {}): SpendForecast => ({
    burnRatePerDay: 10,
    projectedTotal: 120,
    projectedExhaustionAt: null,
    consumedFraction: 0.5,
    confidence: 'ok',
    ...overrides,
  })

  it('fires nothing against a limit that is zero or unlimited, whatever the forecast says', () => {
    const hot = forecast({ consumedFraction: 0.9 })
    expect(spendAlertState(hot, PERIOD_START, 0)).toEqual({
      periodStart: PERIOD_START,
      threshold: null,
      projectedOverrun: false,
    })
    expect(spendAlertState(hot, PERIOD_START, Number.POSITIVE_INFINITY).threshold).toBeNull()
  })

  it('crosses a threshold at exactly the threshold, and ignores a zero threshold', () => {
    expect(spendAlertState(forecast({ consumedFraction: 0.8 }), PERIOD_START, 100).threshold).toBe(
      0.8,
    )
    // A 0 threshold would fire for every scope from its first cent, so it is not a threshold.
    expect(
      spendAlertState(forecast({ consumedFraction: 0 }), PERIOD_START, 100, [0]).threshold,
    ).toBeNull()
  })

  it('withholds an overrun from an unpublishable projection even when a number is attached', () => {
    // `forecastSpend` nulls the projection whenever confidence is not `ok`, so the confidence
    // check reads as redundant against it. It is not: it is what makes the pairing unrepresentable
    // for any other producer of a forecast.
    const shaky = forecast({ confidence: 'insufficient-history', projectedTotal: 500 })
    expect(spendAlertState(shaky, PERIOD_START, 100).projectedOverrun).toBe(false)
  })

  it('needs the projection to EXCEED the limit, not merely to reach it', () => {
    expect(
      spendAlertState(forecast({ projectedTotal: 100 }), PERIOD_START, 100).projectedOverrun,
    ).toBe(false)
    expect(
      spendAlertState(forecast({ projectedTotal: 100.01 }), PERIOD_START, 100).projectedOverrun,
    ).toBe(true)
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
    // Not even with nothing notified yet: "nothing is firing" is never news.
    expect(spendAlertEscalated(null, quiet)).toBe(false)
  })

  it('does not re-escalate an overrun that was already notified', () => {
    const overrun: SpendAlertState = { ...at80, threshold: null, projectedOverrun: true }
    expect(spendAlertEscalated(overrun, overrun)).toBe(false)
  })
})

describe('mergeSpendAlertStates', () => {
  it('takes the highest threshold across tiers, and an overrun projected by any of them', () => {
    expect(
      mergeSpendAlertStates(PERIOD_START, [
        { threshold: 0.8, projectedOverrun: false },
        { threshold: null, projectedOverrun: true },
      ]),
    ).toEqual({ periodStart: PERIOD_START, threshold: 0.8, projectedOverrun: true })
  })

  it('keeps the highest threshold whatever order the tiers arrive in', () => {
    const descending = mergeSpendAlertStates(PERIOD_START, [
      { threshold: 0.95, projectedOverrun: false },
      { threshold: 0.8, projectedOverrun: false },
    ])
    expect(descending.threshold).toBe(0.95)
    // A tier crossing nothing never clears one that did.
    const thenNull = mergeSpendAlertStates(PERIOD_START, [
      { threshold: 0.8, projectedOverrun: false },
      { threshold: null, projectedOverrun: false },
    ])
    expect(thenNull.threshold).toBe(0.8)
  })

  it('folds an empty tier list into a state that fires nothing', () => {
    const folded = mergeSpendAlertStates(PERIOD_START, [])
    expect(folded).toEqual({ periodStart: PERIOD_START, threshold: null, projectedOverrun: false })
    expect(spendAlertFiring(folded)).toBe(false)
  })

  it('escalates when a SECOND tier starts firing beside an unchanged first one', () => {
    // The asymmetry this fold exists to prevent: comparing the previously notified card (which
    // lists every tier) against one tier's own state would find nothing new here, and the
    // account's projected overrun would never be announced.
    const notified = mergeSpendAlertStates(PERIOD_START, [
      { threshold: 0.8, projectedOverrun: false },
    ])
    const now = mergeSpendAlertStates(PERIOD_START, [
      { threshold: 0.8, projectedOverrun: false },
      { threshold: null, projectedOverrun: true },
    ])
    expect(spendAlertEscalated(notified, now)).toBe(true)
    // ...and still does not re-escalate once that second tier has been notified too.
    expect(spendAlertEscalated(now, now)).toBe(false)
  })
})
