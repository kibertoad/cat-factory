/**
 * A frame loop that stops itself once its output stops changing.
 *
 * The board's DOM-measuring drivers (dependency edges, task expansion) have to follow
 * animations they cannot observe directly: a CSS height transition, a Vue Flow pan, a card
 * reflowing after its text changed. Running them unconditionally every frame makes an idle
 * board pay O(edges) forced layout reads 60 times a second; running them only on a change
 * signal makes them stop mid-transition, because the signal fires when the transition
 * STARTS and says nothing about the frames that follow.
 *
 * This resolves both: an external signal `poke()`s the loop awake, and the loop keeps
 * running while `compute()` reports it changed something. Once the output has held still
 * for `settleFrames` frames the animation is over and the loop parks at zero cost until the
 * next poke.
 *
 * The scheduler is injected so the behaviour is testable without a browser frame clock.
 */

/** `requestAnimationFrame` / `cancelAnimationFrame`, injected so tests can drive frames by hand. */
export type FrameScheduler = {
  schedule: (run: () => void) => number
  cancel: (handle: number) => void
}

export type SettlingLoop = {
  /** Wake the loop, and reset the settle countdown if it is already awake. */
  poke: () => void
  /** Park the loop and drop the pending frame. Idempotent. */
  stop: () => void
  /** Whether a frame is currently scheduled. */
  awake: () => boolean
}

/**
 * How many unchanged frames end a run. A signal fires when a style or class changes, one
 * frame BEFORE the transition it starts produces any geometry, so parking on the first
 * unchanged frame would miss every animation. Four frames (~66ms at 60Hz) clears that gap
 * while keeping a false wake-up cheap.
 */
export const DEFAULT_SETTLE_FRAMES = 4

export function createSettlingLoop(options: {
  /** Runs one frame; returns whether it changed anything the user can see. */
  compute: () => boolean
  scheduler: FrameScheduler
  settleFrames?: number
}): SettlingLoop {
  const { compute, scheduler } = options
  const settleFrames = options.settleFrames ?? DEFAULT_SETTLE_FRAMES
  let handle: number | null = null
  let unchangedFrames = 0

  function frame() {
    // `handle` deliberately stays set across `compute()`: a poke triggered by the compute's
    // own store write (a watcher, a re-render) must reset the countdown without also
    // scheduling a second frame beside the one this function is about to schedule.
    const changed = compute()
    unchangedFrames = changed ? 0 : unchangedFrames + 1
    handle = unchangedFrames < settleFrames ? scheduler.schedule(frame) : null
  }

  return {
    poke() {
      unchangedFrames = 0
      if (handle === null) handle = scheduler.schedule(frame)
    },
    stop() {
      if (handle !== null) scheduler.cancel(handle)
      handle = null
    },
    awake: () => handle !== null,
  }
}
