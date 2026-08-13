// Single source of truth for how a job FAILS: the canonical failure-cause vocabulary plus
// the watchdog abort-message builders.
//
// WHY THIS MODULE EXISTS — a failed job surfaces a STRUCTURED {@link FailureCause} on the job
// view, and that is the ONLY signal the backend classifies on (`failureKindFromHarnessCause`);
// the watchdog kills set their cause from `killReason`. Centralizing the cause vocabulary + the
// abort-message builders here keeps the two in step.
//
// The abort-message wording is now HUMAN-READABLE ONLY — the backend no longer regex-matches it
// (the string-fallback classifiers `classify{Agent,Bootstrap,Repair}Failure` were deleted in
// error-message coverage I5), so it is free to change. The one phrase that stays load-bearing is
// the facade-owned eviction sentinel `(container evicted or crashed)`, which
// `job.logic.isContainerEvictionError` still matches for a DISPATCH-time throw that carries no job
// view — and which the harness must keep NOT emitting for a non-eviction failure.

/**
 * The structured reason a harness job failed, surfaced on the job view's `failureCause`.
 * Covers only HARNESS-owned failures — container eviction is detected by the runtime facade
 * (a vanished container → `(container evicted or crashed)`), never set here.
 *
 *  - `inactivity-timeout` — the inactivity watchdog fired (no agent output for the window).
 *  - `max-duration`       — the overall wall-clock cap fired.
 *  - `no-tool-progress`   — the tool-silence watchdog fired: the agent kept TALKING but completed
 *                           no tool call for the window. Distinct from `inactivity-timeout` on
 *                           purpose, because the two need different fixes: one says the container
 *                           went quiet, this one says the model rabbit-holed while streaming.
 *  - `agent`              — the agent ran but produced an unusable/failed result, or threw.
 *  - `git`                — a git operation failed (clone/push/merge/PR).
 *  - `branch-contended`   — a push to the work branch was REFUSED because the branch carries
 *                           commits this push would drop (a second writer, or a rewrite of an
 *                           earlier run's history). Split out of `git` because it is the one git
 *                           fault the ENGINE can recover from on its own: re-dispatching the step
 *                           resumes the branch as it now stands, where every other `git` failure
 *                           would only fail again.
 *  - `api`                — an upstream API call failed (e.g. the GitHub/GitLab PR/MR REST call).
 *  - `llm-upstream`       — the model provider rejected every call (auth/quota/rate-limit) and Pi
 *                           exhausted its retries, so the run never produced a result.
 *  - `no-usable-output`   — the agent finished but returned no usable report / structured output.
 *  - `no-changes`         — a coding agent finished without producing any change to push.
 */
export const FAILURE_CAUSES = [
  'inactivity-timeout',
  'max-duration',
  'no-tool-progress',
  'agent',
  'git',
  'branch-contended',
  'api',
  'llm-upstream',
  'no-usable-output',
  'no-changes',
] as const

/**
 * See {@link FAILURE_CAUSES}. Derived from the array rather than declared beside it so the two
 * cannot disagree, and so the list is ENUMERABLE at runtime — which is what lets
 * `failure-cause.conformity.test.ts` check this image's vocabulary against the kernel union that
 * has to classify it (the two are kept in step by hand; the image can carry no workspace dep).
 */
export type FailureCause = (typeof FAILURE_CAUSES)[number]

/**
 * A thrown failure that carries a structured {@link FailureCause}, so a `git` / `api`
 * operation that fails deep in a helper surfaces its real cause instead of being flattened
 * to the generic `agent` in the registry's catch. The watchdog kills set their cause from
 * `killReason` and never throw this; anything else thrown without a cause stays `agent`.
 */
export class HarnessFailure extends Error {
  readonly failureCause: FailureCause
  constructor(failureCause: FailureCause, message: string) {
    super(message)
    this.name = 'HarnessFailure'
    this.failureCause = failureCause
  }
}

/** The structured cause a thrown error carries, or undefined for a plain/agent error. */
export function failureCauseOf(err: unknown): FailureCause | undefined {
  return err instanceof HarnessFailure ? err.failureCause : undefined
}

/**
 * The inactivity-watchdog abort message PREFIX. Human-readable only now — the backend reads the
 * structured `inactivity-timeout` {@link FailureCause}, not this phrase (the string fallback was
 * deleted in error-message coverage I5), so it is free to change. The caller appends a `(likely
 * hung ...)` diagnostic clause (phase + last tool) after this, so the prefix deliberately stops
 * before the parenthetical (see `runner.ts` drive catch).
 */
export function inactivityAbortMessage(inactivityMs: number): string {
  return `Aborted: no agent activity for ${Math.round(inactivityMs / 1000)}s`
}

/**
 * The max-duration-watchdog abort message. Human-readable only now — the backend reads the
 * structured `max-duration` {@link FailureCause}, not this phrase (the string fallback was deleted
 * in error-message coverage I5), so it is free to change.
 */
export function maxDurationAbortMessage(maxDurationMs: number): string {
  return `Aborted: exceeded max duration of ${Math.round(maxDurationMs / 1000)}s`
}

/**
 * The tool-silence-watchdog abort message. Human-readable only, like its two siblings — the
 * backend reads the structured `no-tool-progress` {@link FailureCause}. Says what it observed
 * (output, but no completed tool call) rather than "hung": the run was demonstrably alive, which
 * is exactly why the inactivity watchdog never fired.
 */
export function toolSilenceAbortMessage(toolSilenceMs: number): string {
  return (
    `Aborted: the agent produced output but completed no tool call for ` +
    `${Math.round(toolSilenceMs / 1000)}s`
  )
}
