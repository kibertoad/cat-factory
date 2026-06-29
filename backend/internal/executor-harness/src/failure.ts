// Single source of truth for how a job FAILS: the canonical failure-cause vocabulary plus
// the watchdog abort-message builders.
//
// WHY THIS MODULE EXISTS — the backend classifies a failed job by REGEX-matching the
// harness's free-text `error` string (it has no other signal today):
//   - server `ContainerRepoBootstrapper.classifyBootstrapFailure`:
//       /inactivity|no agent activity|max duration/i → 'timeout', else → 'agent'
//   - orchestration `job.logic.isContainerEvictionError`: /evicted or crashed/i (FACADE-owned,
//     NOT emitted here — the harness must keep NOT emitting that phrase for a non-eviction)
// Because those phrases are matched downstream, their wording MUST stay stable. Centralizing
// the builders here keeps the emitted text from drifting away from the regex that reads it.
// Alongside the strings we now also emit a STRUCTURED {@link FailureCause} on the job view so
// the backend can prefer it and treat the regex as a backward-compatible fallback.

/**
 * The structured reason a harness job failed, surfaced on the job view's `failureCause`.
 * Covers only HARNESS-owned failures — container eviction is detected by the runtime facade
 * (a vanished container → `(container evicted or crashed)`), never set here.
 *
 *  - `inactivity-timeout` — the inactivity watchdog fired (no agent output for the window).
 *  - `max-duration`       — the overall wall-clock cap fired.
 *  - `agent`              — the agent ran but produced an unusable/failed result, or threw.
 *  - `git`                — a git operation failed (clone/push/merge/PR).
 *  - `api`                — an upstream API call failed (e.g. the GitHub/GitLab PR/MR REST call).
 *  - `no-usable-output`   — the agent finished but returned no usable report / structured output.
 *  - `no-changes`         — a coding agent finished without producing any change to push.
 */
export type FailureCause =
  | 'inactivity-timeout'
  | 'max-duration'
  | 'agent'
  | 'git'
  | 'api'
  | 'no-usable-output'
  | 'no-changes'

/**
 * The inactivity-watchdog abort message PREFIX. The `no agent activity` phrase is
 * regex-matched by the backend's `classifyBootstrapFailure` (→ `timeout`); do not reword it.
 * The caller appends a `(likely hung ...)` diagnostic clause (phase + last tool) after this,
 * so the prefix deliberately stops before the parenthetical (see `runner.ts` drive catch).
 */
export function inactivityAbortMessage(inactivityMs: number): string {
  return `Aborted: no agent activity for ${Math.round(inactivityMs / 1000)}s`
}

/**
 * The max-duration-watchdog abort message. The `max duration` phrase is regex-matched by the
 * backend's `classifyBootstrapFailure` (→ `timeout`); do not reword it.
 */
export function maxDurationAbortMessage(maxDurationMs: number): string {
  return `Aborted: exceeded max duration of ${Math.round(maxDurationMs / 1000)}s`
}
