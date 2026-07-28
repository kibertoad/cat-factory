import { describeError, type Logger } from '@cat-factory/kernel'

// Process-level failure visibility for the two Node-hosted facades (the Worker has no
// analogue — workerd owns the isolate lifecycle, so this is a genuine facade differentiator,
// not a parity gap).
//
// Before this, neither facade registered `unhandledRejection` or `uncaughtException`: a throw
// escaping a background sweeper, a pg-boss handler or an un-awaited promise killed the process
// (or, for a rejection, was silently ignored under Node's default) with the cause reaching only
// whatever the supervisor happened to capture from a raw stack trace. Both now land as one
// structured line naming the guard, so a crash-loop is diagnosable from the same log stream as
// everything else.

/**
 * Register the process-level failure guards. Idempotent per process — a second call is a
 * no-op — because `startLocal` boots on top of the same runtime as `start`.
 *
 * The two handlers deliberately differ:
 *
 * - `unhandledRejection` LOGS AND CONTINUES. A rejected background promise (a best-effort
 *   writeback, a sweeper tick) leaves the process in a defined state, and killing a healthy
 *   orchestrator over one dropped promise would be the more destructive failure.
 * - `uncaughtException` logs and EXITS non-zero. The exception unwound an unknown amount of
 *   stack, so the process's invariants are no longer trustworthy; the supervisor restarting it
 *   is the safe answer. `exitProcess` is injectable so a test can assert the decision without
 *   killing the runner.
 */
export function installProcessFailureGuards(
  logger: Logger,
  exitProcess: (code: number) => void = (code) => process.exit(code),
): void {
  if (installed) return
  installed = true
  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled promise rejection', {
      guard: 'unhandledRejection',
      ...describeError(reason),
    })
  })
  process.on('uncaughtException', (error: unknown) => {
    logger.error('uncaught exception; exiting', {
      guard: 'uncaughtException',
      ...describeError(error),
    })
    exitProcess(1)
  })
}

let installed = false

/** Reset the once-per-process latch. Test-only. */
export function resetProcessFailureGuardsForTest(): void {
  installed = false
  process.removeAllListeners('unhandledRejection')
  process.removeAllListeners('uncaughtException')
}
