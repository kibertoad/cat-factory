import type { Logger } from '@cat-factory/server'
import { describe, expect, it, vi } from 'vitest'
import { startSweeper } from '../src/sweeper.js'

// Unit coverage for the shared Node sweeper helper (built on toad-scheduler): the
// run-once-immediately behaviour, the non-overlap (preventOverrun) guard that every
// Node sweep relies on, best-effort failure logging, and clean stop. Uses short real
// timers + `vi.waitFor` rather than fake timers (the job's immediate run + interval are
// async, which fake timers interleave awkwardly).

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

describe('startSweeper', () => {
  it('runs the tick once immediately, before the first interval', async () => {
    let calls = 0
    const stop = startSweeper({
      name: 'test-sweep',
      intervalMs: 10_000, // long enough that only the immediate run can fire
      log: noopLog,
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

  it('logs a failing pass (best-effort) and keeps sweeping', async () => {
    const error = vi.fn()
    const log = { info: () => {}, warn: () => {}, error } as unknown as Logger
    let runs = 0
    const stop = startSweeper({
      name: 'test-sweep',
      intervalMs: 20,
      log,
      failureMessage: 'kaizen sweep failed',
      tick: async () => {
        runs += 1
        throw new Error('boom')
      },
    })
    await vi.waitFor(() => expect(runs).toBeGreaterThanOrEqual(2))
    stop()
    expect(error).toHaveBeenCalled()
    const [payload, message] = error.mock.calls[0] as [{ err: string }, string]
    expect(message).toBe('kaizen sweep failed')
    expect(payload.err).toBe('boom')
  })

  it('stops ticking after the returned stop is called', async () => {
    let runs = 0
    const stop = startSweeper({
      name: 'test-sweep',
      intervalMs: 20,
      log: noopLog,
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
