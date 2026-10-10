// The runtime-neutral execution driver loop lives in `@cat-factory/orchestration` so the
// cross-runtime conformance suite can drive runs through the SAME production loop both
// facades use (rather than a hand-rolled twin that can silently diverge from it).
// Orchestration is runtime-neutral and has no timers, so the Node service supplies the
// real `setTimeout` sleep here. This wrapper keeps the local import paths (`./drive.js`)
// stable for the runner/config/bootstrap modules.
import {
  type DriveConfig,
  type DriveOptions,
  type DriveOutcome,
  type StepOutcome,
  driveExecution as driveExecutionCore,
} from '@cat-factory/orchestration'

export type { DriveConfig, DriveOptions, DriveOutcome } from '@cat-factory/orchestration'

type ExecutionService = Parameters<typeof driveExecutionCore>[0]

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The facade clock behind `DriveConfig.advanceTimeoutMs`, which is Cloudflare's `step.do` timeout
 * expressed with the only bound Node has. `Promise.race` rather than an `AbortSignal` because the
 * work is not one cancellable call but a whole engine step: the timer's job is to stop the DRIVER
 * waiting on it, and the abandoned work is left to settle (or not) behind the rev-guarded
 * `casPersist`. Racing also keeps a handler attached to that work, so a late rejection is
 * delivered to the already-settled race rather than surfacing as an unhandled one.
 *
 * `ms` is safe to hand a timer unchecked: every duration knob is parsed by the shared
 * `parseConfigDuration`, which refuses anything above `MAX_TIMER_DELAY_MS` rather than let
 * `setTimeout` truncate it to 1ms and expire every step on the next tick.
 */
async function raceStepCeiling<T>(work: Promise<T>, ms: number): Promise<StepOutcome<T>> {
  const timer: { id?: ReturnType<typeof setTimeout> } = {}
  const expiry = new Promise<StepOutcome<T>>((resolve) => {
    timer.id = setTimeout(() => resolve({ timedOut: true }), ms)
  })
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), expiry])
  } finally {
    // Settled early: drop the pending timer instead of holding the event loop for the rest of
    // the ceiling on every advance and every poll a healthy run makes.
    clearTimeout(timer.id)
  }
}

/**
 * Drive one run to a standstill with real (timer-backed) sleeps between gate polls and a real
 * ceiling on every engine call the loop waits on. Both Node-side callers (the pg-boss worker and
 * the mothership in-process runner) import `driveExecution` from here, so the clocks are wired
 * once.
 */
export function driveExecution(
  exec: ExecutionService,
  workspaceId: string,
  executionId: string,
  cfg: DriveConfig,
  opts: DriveOptions = {},
): Promise<DriveOutcome> {
  return driveExecutionCore(exec, workspaceId, executionId, cfg, {
    sleep: realSleep,
    withStepCeiling: raceStepCeiling,
    ...opts,
  })
}
