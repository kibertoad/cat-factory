import type { ChildProcess } from 'node:child_process'
import { log, type Logger } from './logger.js'

// Shared child-process lifecycle helpers. Every CLI the harness spawns (Pi and the
// subscription harnesses) must die the same way when the watchdog or a no-progress
// guard aborts, so the SIGTERM→SIGKILL escalation lives here rather than being
// re-implemented per runner.

// How long to wait after SIGTERM before escalating to SIGKILL.
const KILL_GRACE_MS = 5_000

/**
 * Signal a child and, when it was spawned detached (a process-group leader on POSIX — see
 * `spawnDetached`), the whole group with it. The agent CLIs (`claude`/`codex`/Pi) spawn their
 * own grandchildren (a shell tool, a build, their own git); a plain `child.kill()` reaps only
 * the direct child and those grandchildren reparent to init and keep running unsupervised.
 * `process.kill(-pid)` targets the group instead. Falls back to a direct kill on Windows (no
 * POSIX process groups) or when the group send fails (already reaped, or the child wasn't
 * spawned detached so no group of its own exists).
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall through to the direct kill below.
    }
  }
  child.kill(signal)
}

/**
 * Terminate a child process (and its group — see {@link signalTree}): SIGTERM first, then
 * SIGKILL after a grace period if it hasn't exited (ignored an ordinary terminate). The
 * escalation timer is `unref()`d so it never by itself keeps the event loop alive. Safe to
 * call more than once.
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
  signalTree(child, 'SIGTERM')
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      logger.warn('killChildProcess: process ignored SIGTERM, escalating to SIGKILL', { graceMs })
      signalTree(child, 'SIGKILL')
    }
  }, graceMs).unref()
}

/**
 * Whether a spawned agent CLI should be its own process-group leader so {@link killChildProcess}
 * can reap the whole tree (its grandchildren) on abort. POSIX only; Windows has no process
 * groups (and `detached` there spawns a new console we don't want), so it stays false.
 */
export const spawnDetached = process.platform !== 'win32'
