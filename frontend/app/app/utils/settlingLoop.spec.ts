import { describe, it, expect } from 'vitest'
import { createSettlingLoop, type FrameScheduler } from './settlingLoop'

/** A hand-driven frame clock: `flush()` runs exactly one scheduled frame. */
function fakeScheduler() {
  let nextHandle = 1
  const pending = new Map<number, () => void>()
  const scheduler: FrameScheduler = {
    schedule(run) {
      const handle = nextHandle++
      pending.set(handle, run)
      return handle
    },
    cancel(handle) {
      pending.delete(handle)
    },
  }
  return {
    scheduler,
    pending: () => pending.size,
    /** Run every currently scheduled frame; frames they schedule wait for the next flush. */
    flush() {
      const due = [...pending.entries()]
      pending.clear()
      for (const [, run] of due) run()
    },
  }
}

describe('createSettlingLoop', () => {
  it('does not run until poked', () => {
    const clock = fakeScheduler()
    let frames = 0
    const loop = createSettlingLoop({
      compute: () => {
        frames++
        return false
      },
      scheduler: clock.scheduler,
      settleFrames: 3,
    })

    expect(loop.awake()).toBe(false)
    clock.flush()
    expect(frames).toBe(0)
  })

  it('keeps running while the output changes, and parks once it holds still', () => {
    const clock = fakeScheduler()
    let changed = true
    let frames = 0
    const loop = createSettlingLoop({
      compute: () => {
        frames++
        return changed
      },
      scheduler: clock.scheduler,
      settleFrames: 3,
    })

    loop.poke()
    for (let i = 0; i < 10; i++) clock.flush()
    expect(frames).toBe(10)
    expect(loop.awake()).toBe(true)

    // The animation ends: three unchanged frames later the loop is parked and the frame
    // count stops moving no matter how many times the clock ticks.
    changed = false
    clock.flush()
    clock.flush()
    expect(loop.awake()).toBe(true)
    clock.flush()
    expect(loop.awake()).toBe(false)

    const settledAt = frames
    for (let i = 0; i < 10; i++) clock.flush()
    expect(frames).toBe(settledAt)
  })

  it('runs the settle tail after a poke that changed nothing, then parks', () => {
    const clock = fakeScheduler()
    let frames = 0
    const loop = createSettlingLoop({
      compute: () => {
        frames++
        return false
      },
      scheduler: clock.scheduler,
      settleFrames: 3,
    })

    // A signal fires one frame BEFORE the transition it starts produces geometry, so a wake
    // that measures no change still owes the tail rather than parking immediately.
    loop.poke()
    clock.flush()
    expect(loop.awake()).toBe(true)
    clock.flush()
    clock.flush()
    expect(frames).toBe(3)
    expect(loop.awake()).toBe(false)
  })

  it('wakes a parked loop again on the next poke', () => {
    const clock = fakeScheduler()
    let frames = 0
    const loop = createSettlingLoop({
      compute: () => {
        frames++
        return false
      },
      scheduler: clock.scheduler,
      settleFrames: 1,
    })

    loop.poke()
    clock.flush()
    expect(loop.awake()).toBe(false)

    loop.poke()
    clock.flush()
    expect(frames).toBe(2)
  })

  it('restarts the countdown on a poke without scheduling a second frame', () => {
    const clock = fakeScheduler()
    let frames = 0
    const loop = createSettlingLoop({
      compute: () => {
        frames++
        return false
      },
      scheduler: clock.scheduler,
      settleFrames: 2,
    })

    loop.poke()
    loop.poke()
    loop.poke()
    expect(clock.pending()).toBe(1)
    clock.flush()
    expect(frames).toBe(1)
  })

  it('does not schedule a second frame when the compute itself pokes', () => {
    const clock = fakeScheduler()
    let frames = 0
    // A compute that writes to a store can wake watchers that poke back synchronously. That
    // must reset the countdown, not double the frame rate.
    const loop = createSettlingLoop({
      compute: () => {
        frames++
        loop.poke()
        return false
      },
      scheduler: clock.scheduler,
      settleFrames: 2,
    })

    loop.poke()
    for (let i = 0; i < 5; i++) {
      expect(clock.pending()).toBe(1)
      clock.flush()
    }
    expect(frames).toBe(5)
  })

  it('drops the pending frame on stop', () => {
    const clock = fakeScheduler()
    let frames = 0
    const loop = createSettlingLoop({
      compute: () => {
        frames++
        return true
      },
      scheduler: clock.scheduler,
      settleFrames: 3,
    })

    loop.poke()
    loop.stop()
    expect(loop.awake()).toBe(false)
    clock.flush()
    expect(frames).toBe(0)
  })
})
