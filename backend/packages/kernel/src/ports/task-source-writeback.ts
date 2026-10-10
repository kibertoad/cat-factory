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

/**
 * The workspace + credentials one writeback BATCH runs for.
 *
 * One context object is built per `(workspace, source)` per hook and handed to every call the
 * hook makes for that source: a block linked to three issues on one tracker shares one context
 * across all three, and across the comment + state change each of them takes. That span is what
 * {@link TaskWritebackContext.once} memoises over, and it is why the context is constructed by
 * {@link createTaskWritebackContext} rather than written as an object literal.
 */
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
  /**
   * Memoise a WORKSPACE-INVARIANT read for the span of this batch, so an adapter that needs one
   * pays for it once however many issues the batch covers.
   *
   * It exists because the fan-out is the caller's and the read is the adapter's: the repo-backed
   * adapter resolves the workspace's VCS connection to address any issue at all, and the merge
   * hook calls it twice per issue, so three linked issues cost six reads of one row that cannot
   * differ between them. There is nothing to batch with an `IN` query here (it is one row asked
   * for repeatedly), and the adapter cannot hoist it itself because it does not own the loop, so
   * the hoist is a per-batch memo the CALLER's context carries.
   *
   * `key` is scoped to the one adapter that holds this context (a context belongs to a single
   * source), so an adapter names its reads however it likes without collision risk.
   *
   * The PROMISE is memoised, not the value: the fan-out is concurrent, so the first caller's
   * in-flight read is what every sibling joins. A REJECTION is memoised too, deliberately. Within
   * one batch the answer is the answer, and re-asking per issue on a disconnected installation
   * would multiply one failure into one call per issue at the exact moment the vendor is least
   * able to serve them. A later batch gets a fresh context and asks again.
   */
  once<T>(key: string, load: () => Promise<T>): Promise<T>
}

/**
 * Build the context for one writeback batch: the {@link TaskWritebackContext.once} memo is
 * private to the returned object and dies with it, so it can never serve a later batch a stale
 * answer and needs no invalidation.
 */
export function createTaskWritebackContext(input: {
  workspaceId: string
  credentials: TaskCredentials
}): TaskWritebackContext {
  const memo = new Map<string, Promise<unknown>>()
  return {
    workspaceId: input.workspaceId,
    credentials: input.credentials,
    once<T>(key: string, load: () => Promise<T>): Promise<T> {
      const cached = memo.get(key)
      if (cached) return cached as Promise<T>
      const pending = load()
      memo.set(key, pending)
      return pending
    },
  }
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
   * Where this adapter gets its authority, DECLARED rather than inferred from an empty bag:
   *
   *  - `stored-connection` (Jira, Linear): it authenticates with the workspace's stored
   *    credential bag, so a bag it cannot read is a bag it cannot write with.
   *  - `out-of-band` (GitHub Issues, GitLab Issues): it authenticates through the workspace's VCS
   *    installation, resolved from `workspaceId`. The tracker connection row holds only the
   *    inbound webhook secret for it, and often does not exist at all.
   *
   * The distinction decides what an UNREADABLE tracker connection costs. Read as one fact for
   * every source it would mean a rotated `TASKS_ENCRYPTION_KEY` or a transient row read failure
   * taking the PR notice, the close-on-merge, the pickup claim and the question echo away from
   * GitHub and GitLab too, which never needed that row to post. An out-of-band adapter therefore
   * still runs; only what the row actually carried (the reply channel) is withheld.
   *
   * Required, with no default: the two answers fail in opposite directions (a `stored-connection`
   * adapter treated as out-of-band authenticates as nobody and reports the vendor's rejection as
   * the fault; an out-of-band one treated as needing credentials silently loses its whole loop),
   * so a new adapter states it rather than inheriting whichever guess is written here.
   */
  readonly authenticates: 'stored-connection' | 'out-of-band'
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
