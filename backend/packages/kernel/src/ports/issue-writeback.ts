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
}
