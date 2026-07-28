import { describeError, type Logger } from '@cat-factory/kernel'

// Process-level failure visibility for the two Node-hosted facades (the Worker has no
// analogue — workerd owns the isolate lifecycle, so this is a genuine facade differentiator,
// not a parity gap).
//
// Before this, neither facade registered `unhandledRejection` or `uncaughtException`: both
// already terminated the process (see below), but the cause reached only whatever the supervisor
// happened to scrape from a raw stack trace on stderr. Both now land as one structured line
// naming the guard, so a crash-loop is diagnosable from the same log stream as everything else.

/** The two process events this module guards. */
type GuardedEvent = 'unhandledRejection' | 'uncaughtException'

/** One registered guard, retained so the test reset can remove exactly what we added. */
interface InstalledGuard {
  event: GuardedEvent
  handler: (cause: unknown) => void
}

/**
 * The guards this module registered, or `undefined` before the once-per-process install. Held as
 * the listener list rather than a boolean because `process.removeAllListeners(...)` would also
 * strip the test runner's own handlers — which is how a later failing spec in the same vitest
 * worker ends up misreported.
 */
let installed: InstalledGuard[] | undefined

/**
 * Register the process-level failure guards. Idempotent per process — a second call is a
 * no-op — because `startLocal` boots on top of the same runtime as `start`.
 *
 * **These guards add the log line and nothing else: both dispositions match what Node already
 * did.** That is deliberate. Node's default for BOTH conditions is to terminate with a non-zero
 * exit — `uncaughtException` has always done so, and since Node 15 an unhandled rejection is
 * raised as an uncaught exception too (`--unhandled-rejections=throw`; this repo requires
 * `node >= 20`). Registering a listener is what takes that decision away from Node, so each
 * handler hands it straight back by exiting. A logging change must not quietly become a change
 * to when the orchestrator stays up.
 *
 * Continuing past an unhandled rejection was considered and rejected. Deliberate fire-and-forget
 * work already has a convention that logs and swallows at the call site (`runBestEffort`), so a
 * rejection that escapes all the way to the process is by definition an OVERSIGHT — an `await`
 * whose continuation never ran, leaving a lease unreleased or a structure half-updated. That is
 * precisely the case Node's default is right about, and a supervisor restart beats serving
 * traffic on invariants nobody can vouch for. Revisit it as its own change, with its own
 * rationale, if a real incident argues otherwise.
 *
 * `exitProcess` is injectable so a test can assert the decision without killing the runner.
 */
export function installProcessFailureGuards(
  logger: Logger,
  exitProcess: (code: number) => void = (code) => process.exit(code),
): void {
  if (installed) return
  const guards: InstalledGuard[] = []
  installed = guards
  const on = (event: GuardedEvent, handler: (cause: unknown) => void): void => {
    guards.push({ event, handler })
    process.on(event, handler)
  }
  on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled promise rejection; exiting', {
      guard: 'unhandledRejection',
      ...describeError(reason),
    })
    exitProcess(1)
  })
  on('uncaughtException', (error: unknown) => {
    logger.error('uncaught exception; exiting', {
      guard: 'uncaughtException',
      ...describeError(error),
    })
    exitProcess(1)
  })
}

/** Reset the once-per-process latch, removing only the listeners we added. Test-only. */
export function resetProcessFailureGuardsForTest(): void {
  for (const { event, handler } of installed ?? []) process.off(event, handler)
  installed = undefined
}
