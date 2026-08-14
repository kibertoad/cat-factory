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
  /**
   * Whether the loop still owns the frame stream: a frame is scheduled, or `compute()` is
   * running right now. The two are deliberately not the same fact, and only this one decides
   * whether a `poke()` has to schedule anything.
   */
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
  /** The scheduled frame's handle, and ONLY that: null the whole time `compute()` runs. */
  let pending: number | null = null
  /** Whether the loop owns the frame stream, which stays true across `compute()`. */
  let isAwake = false
  let unchangedFrames = 0

  function frame() {
    // This callback's own handle is spent the moment it runs, so nothing may cancel it later;
    // `isAwake` is what carries "the loop is running" across the compute below.
    pending = null
    let changed: boolean
    try {
      changed = compute()
    } catch (error) {
      // Park before letting the error reach the frame callback, where the browser reports it.
      // Staying awake with no frame scheduled would make every later `poke()` a no-op, so one
      // throwing frame would freeze the board for the rest of the session; rescheduling would
      // be worse still, since a compute that threw on this frame throws on the next one too
      // and a 60Hz error storm costs more than an arrow that waits for the next pulse.
      isAwake = false
      throw error
    }
    // A `stop()` that ran during `compute()` (an unmount driven by the compute's own store
    // write) parks the loop for good: it must not be resurrected by the frame below.
    if (!isAwake) return
    unchangedFrames = changed ? 0 : unchangedFrames + 1
    if (unchangedFrames < settleFrames) pending = scheduler.schedule(frame)
    else isAwake = false
  }

  return {
    poke() {
      unchangedFrames = 0
      // A poke triggered by the compute's own store write (a watcher, a re-render) resets the
      // countdown and nothing more: `isAwake` is still set, so it cannot schedule a second
      // frame beside the one `frame()` is about to schedule itself.
      if (isAwake) return
      isAwake = true
      pending = scheduler.schedule(frame)
    },
    stop() {
      isAwake = false
      if (pending !== null) scheduler.cancel(pending)
      pending = null
    },
    awake: () => isAwake,
  }
}
