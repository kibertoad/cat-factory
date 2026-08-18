import { describe, it, expect } from 'vitest'
import { createWakeGate, type WakeGateScheduler } from './boardWakeGate'

/** A hand-driven timer: `run()` fires the one scheduled callback, whatever its delay. */
function fakeScheduler() {
  let nextHandle = 1
  const pending = new Map<number, { run: () => void; delayMs: number }>()
  const scheduler: WakeGateScheduler = {
    schedule(run, delayMs) {
      const handle = nextHandle++
      pending.set(handle, { run, delayMs })
      return handle
    },
    cancel(handle) {
      pending.delete(handle)
    },
  }
  return {
    scheduler,
    pending: () => pending.size,
    delays: () => [...pending.values()].map((p) => p.delayMs),
    /** Fire every scheduled callback; anything they schedule waits for the next elapse. */
    elapse() {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, { run }] of due) run()
    },
  }
}

function gateWith(intervalMs?: number) {
  const clock = fakeScheduler()
  let wakes = 0
  const gate = createWakeGate({
    wake: () => {
      wakes++
    },
    scheduler: clock.scheduler,
    intervalMs,
  })
  return { clock, gate, wakes: () => wakes }
}

describe('createWakeGate', () => {
  it('wakes immediately on the first request', () => {
    const { gate, wakes, clock } = gateWith()
    gate.request()
    expect(wakes()).toBe(1)
    expect(clock.pending()).toBe(1)
  })

  it('admits at most one wake per interval while requests keep arriving', () => {
    const { gate, wakes, clock } = gateWith()
    gate.request()
    gate.request()
    gate.request()
    expect(wakes()).toBe(1)

    // The suppressed requests are owed one wake, which lands when the interval ends.
    clock.elapse()
    expect(wakes()).toBe(2)
    // ... and the wake it just admitted opens the next interval, so a continuing stream
    // stays bounded rather than firing per request.
    gate.request()
    expect(wakes()).toBe(2)
    clock.elapse()
    expect(wakes()).toBe(3)
  })

  it('goes idle after a quiet interval, so an isolated request is never delayed', () => {
    const { gate, wakes, clock } = gateWith()
    gate.request()
    expect(wakes()).toBe(1)

    clock.elapse()
    // Nothing was owed, so the interval simply closed: no wake, nothing scheduled.
    expect(wakes()).toBe(1)
    expect(clock.pending()).toBe(0)

    gate.request()
    expect(wakes()).toBe(2)
  })

  it('drops an owed wake when cancelled, and admits the next request immediately', () => {
    const { gate, wakes, clock } = gateWith()
    gate.request()
    gate.request()
    gate.cancel()
    clock.elapse()
    expect(wakes()).toBe(1)

    gate.request()
    expect(wakes()).toBe(2)
  })

  it('schedules the interval the caller configured', () => {
    const { gate, clock } = gateWith(40)
    gate.request()
    expect(clock.delays()).toEqual([40])
  })
})
