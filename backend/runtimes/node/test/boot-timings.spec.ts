import { describe, expect, it } from 'vitest'
import { startBootClock } from '../src/bootTimings.js'

// Boot-phase instrumentation (app-startup initiative, item 1). The clock is injected with a fake
// `now` so the per-phase millis are deterministic — no real timing, no sleeps.
describe('startBootClock', () => {
  it('records each phase as the delta since the previous mark, plus a running total', () => {
    let t = 100
    const clock = startBootClock(() => t)

    t = 130 // +30 since construction
    clock.mark('config')
    t = 330 // +200
    clock.mark('migrate')
    t = 335 // +5
    clock.mark('bossStart')

    const { phases, totalMs } = clock.summary()
    expect(phases).toEqual({ config: 30, migrate: 200, bossStart: 5 })
    // Total is measured from construction to the summary call, independent of the marks.
    expect(totalMs).toBe(235)
  })

  it('rounds sub-millisecond deltas to whole millis', () => {
    let t = 0
    const clock = startBootClock(() => t)
    t = 1.4
    clock.mark('a')
    t = 2.1 // delta 0.7 → rounds up to 1
    clock.mark('b')
    expect(clock.summary().phases).toEqual({ a: 1, b: 1 })
  })

  it('defaults to performance.now() when no clock is injected', () => {
    const clock = startBootClock()
    clock.mark('phase')
    const { phases, totalMs } = clock.summary()
    expect(phases.phase).toBeGreaterThanOrEqual(0)
    expect(totalMs).toBeGreaterThanOrEqual(0)
  })
})
