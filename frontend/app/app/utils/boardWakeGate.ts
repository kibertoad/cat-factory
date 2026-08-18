/**
 * Rate limiter for the wakes the board's activity pulse raises from RENDERS.
 *
 * The canvas MutationObserver is deliberately broad (see `useBoardActivity`): it watches the
 * whole subtree for structure plus `style`/`class`, which is what lets it catch a geometry
 * change without enumerating the causes. The cost is that every Vue-driven card re-render
 * wakes the two DOM-measuring loops, and each wake carries a settle tail of several frames,
 * so under a steady execution-event stream a busy board never parks them: exactly the board
 * where the measurement is most expensive pays for it continuously.
 *
 * A render is not a gesture, though. A card whose badge changed may or may not have moved its
 * neighbours, and either way nobody is watching that pixel land within one frame, so these
 * wakes may be COALESCED where a pointer/wheel/camera wake may not. This gate fires the first
 * one straight through (an isolated change still follows within a frame) and then admits at
 * most one per interval for as long as the stream lasts.
 *
 * The scheduler is injected so the behaviour is testable without a timer clock.
 */
export type WakeGateScheduler = {
  schedule: (run: () => void, delayMs: number) => number
  cancel: (handle: number) => void
}

export type WakeGate = {
  /** Ask for a wake: immediate when the interval is clear, coalesced onto its end otherwise. */
  request: () => void
  /** Drop a coalesced wake that has not fired yet. Idempotent. */
  cancel: () => void
}

/**
 * How long one admitted render wake covers. The settle tail of a woken loop is ~4 frames
 * (~66ms at 60Hz), so this leaves a busy board measuring for a fraction of each interval
 * instead of every frame, while a change that really did move a card is on screen well inside
 * the window a reader would notice.
 */
export const RENDER_WAKE_INTERVAL_MS = 250

export function createWakeGate(options: {
  /** Raise the pulse. */
  wake: () => void
  scheduler: WakeGateScheduler
  intervalMs?: number
}): WakeGate {
  const { wake, scheduler } = options
  const intervalMs = options.intervalMs ?? RENDER_WAKE_INTERVAL_MS
  /** The open interval's handle, or null when no wake has been admitted recently. */
  let window: number | null = null
  /** Whether a request arrived while the interval was open and still owes a wake. */
  let owed = false

  function closeWindow() {
    window = null
    // A quiet interval simply ends: the next request is admitted immediately, so an isolated
    // render never waits. Only a stream that kept asking re-opens the interval, which is what
    // bounds it to one wake per interval for as long as it lasts.
    if (!owed) return
    owed = false
    wake()
    window = scheduler.schedule(closeWindow, intervalMs)
  }

  return {
    request() {
      if (window !== null) {
        owed = true
        return
      }
      wake()
      window = scheduler.schedule(closeWindow, intervalMs)
    },
    cancel() {
      if (window !== null) scheduler.cancel(window)
      window = null
      owed = false
    },
  }
}
