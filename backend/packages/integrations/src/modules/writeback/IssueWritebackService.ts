import {
  resolveWritebackFlag,
  type Block,
  type IssueWritebackProvider,
  type PullRequestRef,
  type TaskRecord,
  type TaskRepository,
  type TrackerSettingsRepository,
} from '@cat-factory/kernel'
import { buildJiraCommentPayload, pickDoneTransition } from '../tracker/jira.writeback.logic.js'
import type { FetchLike, JiraConnection } from '../tracker/TicketTrackerService.js'
import { toBase64 } from '../tracker/base64.js'

// IssueWritebackService: the runtime-neutral `IssueWritebackProvider`. As a task's
// PR progresses the execution engine calls it to write back to the task's linked
// tracker issue(s): comment when the PR opens, and comment + close as resolved when
// the PR merges. It resolves the workspace's writeback settings (with the per-task
// override on the block), finds the linked issues via the task projection, and
// dispatches per source. GitHub auth/installation resolution differs per runtime so
// it is injected as seams (the facade parses `owner/repo#number` and resolves the
// installation); the Jira HTTP + ADF logic stays here (identical across runtimes).
//
// Every action is best-effort: each issue's writeback is wrapped so one failure
// never blocks the others, and the engine already calls these fire-and-forget.

const USER_AGENT = 'cat-factory'

export interface IssueWritebackServiceDependencies {
  trackerSettingsRepository: TrackerSettingsRepository
  taskRepository: TaskRepository
  /**
   * Post a comment on a GitHub issue identified by its `owner/repo#number` external
   * id. The facade resolves the workspace's installation + repo ref and calls
   * `GitHubClient.comment`. Absent → GitHub writeback passes through.
   */
  commentOnGitHubIssue?: (workspaceId: string, externalId: string, body: string) => Promise<void>
  /**
   * Close a GitHub issue (as completed) identified by its `owner/repo#number`
   * external id. Absent → GitHub close passes through.
   */
  closeGitHubIssue?: (workspaceId: string, externalId: string) => Promise<void>
  /**
   * Resolve the workspace's Jira credentials, or null when Jira isn't configured.
   * Reuses the same seam as `TicketTrackerService`. Absent → Jira writeback passes through.
   */
  resolveJiraConnection?: (workspaceId: string) => Promise<JiraConnection | null>
  /** HTTP transport for the Jira calls (each runtime exposes a global `fetch`). */
  fetchImpl?: FetchLike
}

export class IssueWritebackService implements IssueWritebackProvider {
  constructor(private readonly deps: IssueWritebackServiceDependencies) {}

  async onPullRequestOpened(workspaceId: string, block: Block, pr: PullRequestRef): Promise<void> {
    const settings = await this.deps.trackerSettingsRepository.get(workspaceId)
    const enabled = resolveWritebackFlag(
      settings?.writebackCommentOnPrOpen ?? false,
      block.trackerCommentOnPrOpen,
    )
    if (!enabled) return
    const issues = await this.deps.taskRepository.listByBlock(workspaceId, block.id)
    if (issues.length === 0) return
    const body = `🔧 A pull request was opened for this issue: ${pr.url}`
    await this.forEachIssue(issues, (issue) => this.comment(workspaceId, issue, body))
  }

  async onPullRequestMerged(workspaceId: string, block: Block, pr: PullRequestRef): Promise<void> {
    const settings = await this.deps.trackerSettingsRepository.get(workspaceId)
    const enabled = resolveWritebackFlag(
      settings?.writebackResolveOnMerge ?? false,
      block.trackerResolveOnMerge,
    )
    if (!enabled) return
    const issues = await this.deps.taskRepository.listByBlock(workspaceId, block.id)
    if (issues.length === 0) return
    const body = `✅ The pull request was merged and this issue is resolved: ${pr.url}`
    await this.forEachIssue(issues, async (issue) => {
      await this.comment(workspaceId, issue, body)
      await this.resolve(workspaceId, issue)
    })
  }

  /** Run a writeback per issue, isolating failures so one bad issue can't block the rest. */
  private async forEachIssue(
    issues: TaskRecord[],
    fn: (issue: TaskRecord) => Promise<void>,
  ): Promise<void> {
    await Promise.all(issues.map((issue) => fn(issue).catch(() => {})))
  }

  private async comment(workspaceId: string, issue: TaskRecord, body: string): Promise<void> {
    if (issue.source === 'github') {
      await this.deps.commentOnGitHubIssue?.(workspaceId, issue.externalId, body)
      return
    }
    if (issue.source === 'jira') {
      await this.jiraRequest(workspaceId, `issue/${encodeURIComponent(issue.externalId)}/comment`, {
        method: 'POST',
        body: buildJiraCommentPayload(body),
      })
    }
  }

  private async resolve(workspaceId: string, issue: TaskRecord): Promise<void> {
    if (issue.source === 'github') {
      await this.deps.closeGitHubIssue?.(workspaceId, issue.externalId)
      return
    }
    if (issue.source === 'jira') {
      await this.resolveJira(workspaceId, issue.externalId)
    }
  }

  private async resolveJira(workspaceId: string, key: string): Promise<void> {
    const path = `issue/${encodeURIComponent(key)}/transitions`
    const list = (await this.jiraRequest(workspaceId, path, { method: 'GET' })) as {
      transitions?: Parameters<typeof pickDoneTransition>[0]
    } | null
    const transition = pickDoneTransition(list?.transitions ?? [])
    if (!transition?.id) return
    await this.jiraRequest(workspaceId, path, {
      method: 'POST',
      body: { transition: { id: transition.id } },
    })
  }

  /**
   * Issue a Jira REST v3 request for the workspace's connection. Returns the parsed
   * JSON body (or null on an empty/204 response). Throws on a non-OK status so the
   * per-issue `.catch` in {@link forEachIssue} swallows it.
   */
  private async jiraRequest(
    workspaceId: string,
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<unknown> {
    const { resolveJiraConnection, fetchImpl } = this.deps
    if (!resolveJiraConnection || !fetchImpl) return null
    const connection = await resolveJiraConnection(workspaceId)
    if (!connection?.baseUrl || !connection.accountEmail || !connection.apiToken) return null
    const base = connection.baseUrl.replace(/\/+$/, '')
    const url = `${base}/rest/api/3/${path}`
    const auth = toBase64(`${connection.accountEmail}:${connection.apiToken}`)
    const res = await fetchImpl(url, {
      method: init.method,
      headers: {
        authorization: `Basic ${auth}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: init.body === undefined ? '' : JSON.stringify(init.body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Jira ${init.method} ${url} → ${res.status}: ${text.slice(0, 300)}`)
    }
    return res.json().catch(() => null)
  }
}
