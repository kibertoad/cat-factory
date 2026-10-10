import type { DelegationBrief, DelegationHandle } from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// WHICH WORKFLOW a call addresses.
//
// Two deployment shapes, and the helper has to serve both from one registration. A central
// automation repository holds one workflow that works on many product repositories: the location
// is a constant, and `ref` really is "a branch that holds the workflow, not the work". Or a caller
// shim is committed to each onboarded repository, so the workflow lives wherever the work does and
// the dispatch target varies per task.
//
// The second shape is why this is a function of the dispatch rather than four fixed fields, and
// the SCOPE it is handed is why the answer is stable: `start` holds a brief and `poll`/`cancel`
// hold a handle written hours earlier in another process, so anything a resolver may read has to
// be on BOTH.
// ---------------------------------------------------------------------------

/** Where a workflow lives, and which ref it is dispatched on. */
export interface GitHubActionsWorkflowLocation {
  owner: string
  repo: string
  /** The workflow file name (`implement.yml`) or its numeric id, as the REST path takes it. */
  workflowFile: string
  /** The git ref the workflow is dispatched on (a branch that HOLDS the workflow, not the work). */
  ref: string
}

/**
 * What a {@link GitHubActionsWorkflowResolver} may resolve a location from: the INTERSECTION of
 * what a brief and a handle carry, and nothing else.
 *
 * Narrowed deliberately. A resolver reading a brief-only fact would address one repository at
 * dispatch and a different one at every call after it, so the run would be dispatched, then polled
 * where it does not exist, and reported as a workflow that never appeared. Offering only the
 * intersection is what keeps that off a resolver author's shoulders.
 *
 * Every field is GUARANTEED, not best-effort: the engine refuses a poll whose handle is short of
 * the workspace, the block, the run or the agent kind (`requireHandleScope`) rather than filling
 * one in, precisely so a resolver keyed on `agentKind` cannot dispatch `implement.yml` and then
 * poll `''`. The narrowing is only half the property; the refusal is the other half.
 */
export interface GitHubActionsWorkflowScope {
  /**
   * The repository the WORK targets, which is what a per-repository workflow is keyed by. Always
   * present: a call that could not name it is refused before a resolver is asked.
   */
  repo: { owner: string; name: string }
  workspaceId: string
  runId: string
  agentKind: string
  correlationKey: string
}

/** Resolve which workflow one dispatch runs. Called again on every poll and cancel. */
export type GitHubActionsWorkflowResolver = (
  scope: GitHubActionsWorkflowScope,
) => GitHubActionsWorkflowLocation

/** What a deployment states: one location, or a function of the dispatch. */
export type GitHubActionsWorkflowTarget =
  | GitHubActionsWorkflowLocation
  | GitHubActionsWorkflowResolver

/** Addressing bound to one description, asked once per call. */
export interface WorkflowAddressing {
  forBrief(brief: DelegationBrief): GitHubActionsWorkflowLocation
  forHandle(handle: DelegationHandle): GitHubActionsWorkflowLocation
}

/**
 * Bind a description's `workflow` to the two call shapes that ask it.
 *
 * A literal target never builds a scope at all, which is what keeps it addressable from a handle
 * written before the work repository was persisted.
 */
export function workflowAddressing(target: GitHubActionsWorkflowTarget): WorkflowAddressing {
  if (typeof target !== 'function') return { forBrief: () => target, forHandle: () => target }
  return {
    forBrief: (brief) =>
      target({
        repo: { owner: brief.repo.owner, name: brief.repo.name },
        workspaceId: brief.workspaceId,
        runId: brief.runId,
        agentKind: brief.agentKind,
        correlationKey: brief.correlationKey,
      }),
    forHandle: (handle) => {
      const repo = handle.repo
      if (!repo) {
        // REFUSED rather than defaulted to the description's own repository, for the reason the
        // result reader refuses a handle carrying no branches: every rule that picks a repository
        // without being told one can pick somebody else's, and this poll would then settle the
        // step on a run it never dispatched. Reachable only for a record written before the work
        // repo was persisted.
        throw new Error(
          'This executor resolves its workflow per dispatch, and this delegation record carries ' +
            'no work repository to resolve one from. Re-run the step: a dispatch persists it.',
        )
      }
      return target({
        repo,
        workspaceId: handle.workspaceId,
        runId: handle.runId,
        agentKind: handle.agentKind,
        correlationKey: handle.correlationKey,
      })
    },
  }
}
