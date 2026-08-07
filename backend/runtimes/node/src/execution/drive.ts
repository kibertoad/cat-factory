// The runtime-neutral execution driver loop lives in `@cat-factory/orchestration` so the
// cross-runtime conformance suite can drive runs through the SAME production loop both
// facades use (rather than a hand-rolled twin that can silently diverge from it).
// Orchestration is runtime-neutral and has no timers, so the Node service supplies the
// real `setTimeout` sleep here. This wrapper keeps the local import paths (`./drive.js`)
// stable for the runner/config/bootstrap modules.
import {
  type AdvanceOutcome,
  type DriveConfig,
  type DriveOptions,
  type DriveOutcome,
  driveExecution as driveExecutionCore,
} from '@cat-factory/orchestration'

export type { DriveConfig, DriveOptions, DriveOutcome } from '@cat-factory/orchestration'

type ExecutionService = Parameters<typeof driveExecutionCore>[0]

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * The facade clock behind `DriveConfig.advanceTimeoutMs`, which is Cloudflare's `step.do`
 * timeout on the advance expressed with the only bound Node has. `Promise.race` rather than an `AbortSignal`
 * because an advance is not one cancellable call but a whole engine step: the timer's job is to
 * stop the DRIVER waiting on it, and the abandoned work is left to settle (or not) behind the
 * rev-guarded `casPersist`. Racing also keeps a handler attached to the advance, so a late
 * rejection is delivered to the already-settled race rather than surfacing as an unhandled one.
 */
async function raceAdvanceCeiling<T>(work: Promise<T>, ms: number): Promise<AdvanceOutcome<T>> {
  const timer: { id?: ReturnType<typeof setTimeout> } = {}
  const expiry = new Promise<AdvanceOutcome<T>>((resolve) => {
    timer.id = setTimeout(() => resolve({ timedOut: true }), ms)
  })
  try {
    return await Promise.race([work.then((value) => ({ timedOut: false as const, value })), expiry])
  } finally {
    // Settled early: drop the pending timer instead of holding the event loop for the rest of
    // the ceiling on every advance a healthy run makes.
    clearTimeout(timer.id)
  }
}

/**
 * Drive one run to a standstill with real (timer-backed) sleeps between gate polls and a real
 * ceiling on each advance. Both Node-side callers (the pg-boss worker and the mothership
 * in-process runner) import `driveExecution` from here, so the clocks are wired once.
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
    withAdvanceCeiling: raceAdvanceCeiling,
    ...opts,
  })
}
