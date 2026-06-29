import type { ChildProcess } from 'node:child_process'
import { log, type Logger } from './logger.js'

// Shared child-process lifecycle helpers. Every CLI the harness spawns (Pi and the
// subscription harnesses) must die the same way when the watchdog or a no-progress
// guard aborts, so the SIGTERM→SIGKILL escalation lives here rather than being
// re-implemented per runner.

// How long to wait after SIGTERM before escalating to SIGKILL.
const KILL_GRACE_MS = 5_000

/**
 * Terminate a child process: SIGTERM first, then SIGKILL after a grace period if it
 * hasn't exited (ignored an ordinary terminate). The escalation timer is `unref()`d
 * so it never by itself keeps the event loop alive. Safe to call more than once.
 *
 * An actual escalation to SIGKILL is logged at warn level: a process that ignores
 * SIGTERM and has to be force-killed is a signal worth seeing (a wedged Pi/CLI), and
 * was previously invisible. Pass a child logger to carry the run's `jobId`.
 */
export function killChildProcess(
  child: ChildProcess,
  graceMs: number = KILL_GRACE_MS,
  logger: Logger = log,
): void {
  child.kill('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      logger.warn('killChildProcess: process ignored SIGTERM, escalating to SIGKILL', { graceMs })
      child.kill('SIGKILL')
    }
  }, graceMs).unref()
}
