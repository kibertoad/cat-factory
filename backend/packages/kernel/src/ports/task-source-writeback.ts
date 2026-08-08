import type { TaskCredentials } from './task-source.js'

// A task source's OUTBOUND capability: writing back onto an issue it serves.
//
// It is the mirror image of `TaskSourceWebhookAdapter` (the inbound half) and belongs to the
// provider for the same reason: the provider is the only place that knows a source's specifics.
// Before this seam existed the writeback was an `if (source === 'github' | 'jira' | 'linear')`
// chain inside one service, which made every writeback a property of THAT FILE rather than of a
// source. The cost was not hypothetical: GitLab Issues shipped as a full task source (import,
// search, recurring intake, bug hunt) and silently had no writeback at all, so a GitLab reporter
// got a parked review's questions echoed nowhere and an answered reply acknowledged nowhere, and
// a deployment-registered source could never have one however it was wired.
//
// Every method may be called for an issue the workspace can no longer reach (a disconnected
// installation, a revoked token, a deleted issue), and every caller is best-effort, so the
// contract is about what a RETURN means rather than about never failing:
//
//   - **Returning normally is the promise that the effect LANDED.** The parked-review question
//     echo records a per-`(review, iteration, issue)` marker on that promise, and a marker
//     recorded for a comment nobody received permanently suppresses the retry that reconnecting
//     the tracker should produce. So an adapter that cannot resolve its target, has no
//     credentials, or gets a non-OK response THROWS.
//   - **Absence is not failure.** An adapter that omits `resolve`/`markInProgress` states that
//     its vendor has no such notion; the caller reports that rather than treating it as an error
//     or, worse, as done.

/** The workspace + credentials one writeback call runs for. */
export interface TaskWritebackContext {
  /** The workspace whose linked issue is being written back to. */
  workspaceId: string
  /**
   * The workspace's stored credential bag for this source, `{}` when it has no stored connection
   * or the source is credentialless (GitHub Issues rides the workspace's App; GitLab Issues its
   * VCS connection, and both authenticate out-of-band from `workspaceId`).
   *
   * An adapter that NEEDS credentials and finds none throws rather than returning quietly: a
   * linked Jira issue in a workspace whose Jira connection is gone is a broken link to report,
   * not a comment to record as delivered.
   */
  credentials: TaskCredentials
}

/** How a picked-up issue is marked as being worked, where the vendor needs a value for it. */
export interface TaskInProgressMark {
  /**
   * The label to apply on a source with no native workflow status (GitHub Issues), as configured
   * on the intake schedule. An adapter whose vendor HAS a status transition ignores it.
   */
  label?: string
}

/**
 * The writeback capability of one task source. Optional on `TaskSourceProvider`: a source that
 * cannot be written back to simply omits it, and the engine's writeback provider reports the
 * omission per source instead of failing the run.
 */
export interface TaskSourceWritebackAdapter {
  /**
   * Post a comment on one issue. The one REQUIRED member: a source that cannot carry a comment
   * back can carry none of the loop (the PR notices, the parked review's questions, the reply
   * acknowledgement are all comments), so there is nothing for a writeback without it to do.
   */
  comment(ctx: TaskWritebackContext, externalId: string, body: string): Promise<void>
  /**
   * Mark the issue RESOLVED (the merge hook's close), using whatever the vendor's terminal state
   * is: a closed issue, a transition into the `done` status category, a `completed` workflow
   * state. Optional: a source with no closable notion omits it.
   */
  resolve?(ctx: TaskWritebackContext, externalId: string): Promise<void>
  /**
   * Mark the issue as being worked (the intake pickup's claim), using the vendor's in-progress
   * notion: a workflow transition where there is one, `mark.label` where there is not. Optional:
   * a source with neither omits it.
   */
  markInProgress?(
    ctx: TaskWritebackContext,
    externalId: string,
    mark: TaskInProgressMark,
  ): Promise<void>
}
