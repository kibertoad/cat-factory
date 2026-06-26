import type { ChildProcess } from 'node:child_process'

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
 */
export function killChildProcess(child: ChildProcess, graceMs: number = KILL_GRACE_MS): void {
  child.kill('SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, graceMs).unref()
}
