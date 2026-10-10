// How a child process ENDED, in one sentence — the shared vocabulary every transport that
// reports a dead subprocess renders its failure with.
//
// WHY THIS IS SHARED — the distinction it encodes is operational knowledge, not formatting. A
// `null` exit code means a SIGNAL killed the process, and telling that apart from the process's
// own non-zero exit is the first fork in the road when diagnosing a dead agent run: an
// externally-killed job (an OOM kill, a `docker stop` racing teardown, a pool eviction) needs a
// different investigation from a CLI that gave up on its own. Rendering the `null` verbatim
// produces "exited with code null", which reads as neither.
//
// Every process-reporting transport should render through this rather than re-deriving it: the
// local inline CLI runner, and (by the pinned copy in `executor-harness/src/agent-runner.ts`,
// which cannot depend on a workspace package) the container harness. A new transport that
// reports an exit — a pooled runner, a K8s pod, a native host process — inherits the
// distinction by calling this instead of by someone remembering it.

/**
 * How a child process ended: its own exit code, or the signal that killed it.
 *
 * Node reports exactly one of the two on `close` — a `null` code means the process did not exit
 * of its own accord. A signal-killed process with no signal name reported (possible on some
 * platforms) degrades to the generic word rather than to a wrong claim about an exit code.
 *
 * `signal` is a plain `string`, not `NodeJS.Signals`: kernel is runtime-neutral and compiles
 * without Node's ambient types (it also runs on workerd). A Node caller's `NodeJS.Signals` is a
 * union of string literals, so it passes without a cast and keeps its own precision locally.
 *
 * @example describeProcessExit(1, null)          // 'exited with code 1'
 * @example describeProcessExit(null, 'SIGKILL')  // 'killed by SIGKILL'
 */
export function describeProcessExit(code: number | null, signal: string | null): string {
  return code === null ? `killed by ${signal ?? 'signal'}` : `exited with code ${code}`
}
