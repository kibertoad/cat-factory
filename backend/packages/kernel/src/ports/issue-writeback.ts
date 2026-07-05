import type { Block, PullRequestRef } from '../domain/types.js'

// Issue-tracker writeback port. As a task's PR progresses, the execution engine
// asks this provider to write back to the task's linked tracker issue(s): post a
// comment when the PR opens, and comment + close the issue as resolved when the PR
// merges. The concrete provider resolves the workspace's writeback settings (with
// the per-task override on the block), finds the linked issues via the task
// projection, and dispatches per source (GitHub Issues / Jira).
//
// Every method is best-effort: the engine calls them fire-and-forget so a tracker
// outage never fails a run. A provider that finds writeback disabled (workspace
// off and no task override) or no linked issues simply does nothing.

export interface IssueWritebackProvider {
  /** A task's implementation PR just opened — comment on its linked tracker issue(s). */
  onPullRequestOpened(workspaceId: string, block: Block, pr: PullRequestRef): Promise<void>
  /** A task's PR merged — comment + close its linked tracker issue(s) as resolved. */
  onPullRequestMerged(workspaceId: string, block: Block, pr: PullRequestRef): Promise<void>
  /**
   * The recurring `bug-intake` step just picked the block's linked issue up —
   * post a "taken by cat-factory" comment (with the run/board link when given)
   * and mark the issue in-progress: the vendor's in-progress workflow transition
   * (Jira in-progress status category / Linear `started` state), or for GitHub —
   * which has no native status — apply `inProgressLabel` (default `in-progress`),
   * creating the label if absent. Unlike the PR hooks this is NOT gated on the
   * workspace writeback settings: the pickup mark is intake semantics (the whole
   * point is claiming the issue where it was filed), not an optional courtesy.
   */
  onIssuePickedUp(
    workspaceId: string,
    blockId: string,
    info: { runUrl?: string; inProgressLabel?: string },
  ): Promise<void>
  /**
   * The bug-triage clarification gate (`clarity-review`) parked for a human because the
   * investigator flagged the report as unclear — echo the open questions as a comment on
   * the block's linked tracker issue(s) so the reporter sees the ask where they filed the
   * bug. This is an ECHO only: answers still arrive in-app (the clarity window); there is
   * no tracker-side reply polling. Best-effort like the other hooks (a tracker outage never
   * fails the run) and, like {@link onIssuePickedUp}, NOT gated on the workspace writeback
   * settings — asking the reporter for the detail needed to fix their bug is intake
   * semantics, not an optional courtesy. A no-op when the block has no linked issue.
   */
  postQuestions(workspaceId: string, blockId: string, questions: string[]): Promise<void>
}
