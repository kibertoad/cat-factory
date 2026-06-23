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
  driveExecution as driveExecutionCore,
} from '@cat-factory/orchestration'

export type {
  DriveConfig,
  DriveLogger,
  DriveOptions,
  DriveOutcome,
} from '@cat-factory/orchestration'

type ExecutionService = Parameters<typeof driveExecutionCore>[0]

const realSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Drive one run to a standstill with real (timer-backed) sleeps between gate polls. */
export function driveExecution(
  exec: ExecutionService,
  workspaceId: string,
  executionId: string,
  cfg: DriveConfig,
  opts: DriveOptions = {},
): Promise<DriveOutcome> {
  return driveExecutionCore(exec, workspaceId, executionId, cfg, { sleep: realSleep, ...opts })
}
