/**
 * Cheap boot-phase instrumentation (app-startup initiative, item 1). There is otherwise no
 * timing on the boot path — the only markers are the "… listening" lines — so a slow migrate /
 * pg-boss start / worker-registration wave is invisible and every later optimization slice would
 * have to guess which seconds matter. This stamps each phase with `performance.now()` and emits ONE
 * structured `ready` line with the per-phase millis, so a boot's cost is greppable in the logs and
 * comparable before/after a change.
 *
 * Deliberately dependency-free and side-effect-free (no logging of its own): the caller decides
 * when to emit the summary, so the same clock is reused by both the Node boot (`bootServer`) and
 * local mode's `bootLocal` preflights without either importing the other.
 */
export interface BootClock {
  /** Close the phase that started at the previous mark (or at construction) and name its duration. */
  mark(phase: string): void
  /** The per-phase millis recorded so far plus the total elapsed since construction. */
  summary(): { phases: Record<string, number>; totalMs: number }
}

/** Start a boot clock. `now` is injectable so the timing helper is unit-testable off a fake clock. */
export function startBootClock(now: () => number = () => performance.now()): BootClock {
  const t0 = now()
  let last = t0
  const phases: Record<string, number> = {}
  return {
    mark(phase) {
      const t = now()
      // Round to whole millis — sub-ms boot-phase precision is noise, and integers keep the log tidy.
      phases[phase] = Math.round(t - last)
      last = t
    },
    summary() {
      return { phases, totalMs: Math.round(now() - t0) }
    },
  }
}
