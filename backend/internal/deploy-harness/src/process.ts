import type { ChildProcess } from 'node:child_process'
import { log, type Logger } from './logger.js'

// Shared child-process lifecycle helper. Every CLI the harness spawns (kubectl /
// kustomize / helm / git) must die the same way when the watchdog aborts, so the
// SIGTERM→SIGKILL escalation lives here rather than being re-implemented per call.

// How long to wait after SIGTERM before escalating to SIGKILL.
const KILL_GRACE_MS = 5_000

/**
 * Terminate a child process: SIGTERM first, then SIGKILL after a grace period if it
 * hasn't exited. The escalation timer is `unref()`d so it never by itself keeps the
 * event loop alive. Safe to call more than once. An actual escalation is logged at warn.
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
