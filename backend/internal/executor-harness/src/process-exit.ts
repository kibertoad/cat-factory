// A deliberate COPY of kernel's `describeProcessExit` (`shared/process-exit.logic.ts`). The
// container image is built from `src/` plus typescript alone, so the harness can carry no runtime
// dependency on a workspace package — the same constraint that forces `src/host-markdown.ts` to be
// a copy. `test/process-exit.conformity.test.ts` pins the two to identical output, so change one
// and you must change the other.
//
// Kernel's module carries the rationale in full; the short version is that a `null` exit code
// means a SIGNAL killed the process, and telling that apart from the process's own non-zero exit
// is the first fork in the road when diagnosing a dead agent run.

/**
 * How a child process ended: its own exit code, or the signal that killed it.
 *
 * @example describeProcessExit(1, null)          // 'exited with code 1'
 * @example describeProcessExit(null, 'SIGKILL')  // 'killed by SIGKILL'
 */
export function describeProcessExit(code: number | null, signal: NodeJS.Signals | null): string {
  return code === null ? `killed by ${signal ?? 'signal'}` : `exited with code ${code}`
}
