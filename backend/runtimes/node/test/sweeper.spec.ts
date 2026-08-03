import {
  createOperationalMetricsCollector,
  noopLogger,
  noopOperationalMetrics,
} from '@cat-factory/kernel'
import { createSweepHealthTracker } from '@cat-factory/server'
import { describe, expect, it, vi } from 'vitest'
import { startSweeper } from '../src/sweeper.js'

// Unit coverage for the shared Node sweeper helper (built on toad-scheduler): the
// run-once-immediately behaviour, the non-overlap (preventOverrun) guard that every
// Node sweep relies on, best-effort failure logging, and clean stop. Uses short real
// timers + `vi.waitFor` rather than fake timers (the job's immediate run + interval are
// async, which fake timers interleave awkwardly).

const noopLog = noopLogger

describe('startSweeper', () => {
  it('runs the tick once immediately, before the first interval', async () => {
    let calls = 0
    const stop = startSweeper({
      name: 'test-sweep',
      intervalMs: 10_000, // long enough that only the immediate run can fire
      log: noopLog,
      metrics: noopOperationalMetrics,
      failureMessage: 'x',
      tick: async () => {
        calls += 1
      },
    })
    await vi.waitFor(() => expect(calls).toBe(1))
    stop()
  })

  it('re-runs on the interval', async () => {
    let calls = 0
    const stop = startSweeper({
      name: 'test-sweep',
      intervalMs: 20,
      log: noopLog,
      metrics: noopOperationalMetrics,
      failureMessage: 'x',
      tick: async () => {
        calls += 1
      },
    })
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(3))
    stop()
  })

  it('does not overlap: a pass that outlasts the interval is not stacked', async () => {
    let active = 0
    let maxActive = 0
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stop = startSweeper({
      name: 'test-sweep',
      intervalMs: 20,
      log: noopLog,
      metrics: noopOperationalMetrics,
      failureMessage: 'x',
      tick: async () => {
        runs += 1
        active += 1
        maxActive = Math.max(maxActive, active)
        await gate
        active -= 1
      },
    })
    // Several intervals elapse while the first pass is blocked on the gate.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(runs).toBe(1) // the overlapping ticks were skipped, not stacked
    expect(maxActive).toBe(1)
    release() // let the blocked pass (and future ones) complete
    await vi.waitFor(() => expect(runs).toBeGreaterThan(1))
    stop()
  })

  it('logs a failing pass (best-effort), counts it, and keeps sweeping', async () => {
    const error = vi.fn()
    const log = { ...noopLogger, error }
    const metrics = createOperationalMetricsCollector()
    let runs = 0
    const stop = startSweeper({
      name: 'test-sweep',
      intervalMs: 20,
      log,
      metrics,
      failureMessage: 'kaizen sweep failed',
      tick: async () => {
        runs += 1
        throw new Error('boom')
      },
    })
    await vi.waitFor(() => expect(runs).toBeGreaterThanOrEqual(2))
    stop()
    expect(error).toHaveBeenCalled()
    const [message, fields] = error.mock.calls[0] as [string, { err: string }]
    expect(message).toBe('kaizen sweep failed')
    // The cause is bound (and scrubbed) rather than discarded — the whole point of the
    // failure message being a fixed string is that the variable part rides the fields.
    expect(fields.err).toBe('boom')
    // …and the failure is COUNTED under this sweep's name, which is what makes "the retention
    // sweep has been failing all week" a metric rather than a pattern in the logs. Dimensioned
    // by `sweep`, so one sick sweeper is identifiable among the fourteen.
    const failures = metrics.drain().filter((s) => s.counter === 'sweep.failed')
    expect(failures).toHaveLength(1)
    expect(failures[0]!.dimensions).toEqual({ sweep: 'test-sweep' })
    expect(failures[0]!.value).toBeGreaterThanOrEqual(2)
  })

  it("resets a sweeper's failure streak once a pass succeeds again", async () => {
    // The streak is what `sweep_degraded` alerts on, so a sweeper that failed twice and then
    // recovered must NOT keep accumulating toward the threshold across unrelated incidents.
    const health = createSweepHealthTracker()
    health.recordFailure('flaky')
    health.recordFailure('flaky')
    expect(health.worst()).toEqual({ sweep: 'flaky', consecutive: 2 })
    health.recordSuccess('flaky')
    expect(health.worst()).toBeUndefined()
  })

  it('stops ticking after the returned stop is called', async () => {
    let runs = 0
    const stop = startSweeper({
      name: 'test-sweep',
      intervalMs: 20,
      log: noopLog,
      metrics: noopOperationalMetrics,
      failureMessage: 'x',
      tick: async () => {
        runs += 1
      },
    })
    await vi.waitFor(() => expect(runs).toBeGreaterThanOrEqual(1))
    stop()
    const settled = runs
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(runs).toBe(settled)
  })
})
