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
import {
  LINEAR_COMMENT_CREATE_MUTATION,
  LINEAR_ISSUE_ID_QUERY,
  LINEAR_ISSUE_RESOLVE_LOOKUP_QUERY,
  LINEAR_ISSUE_UPDATE_MUTATION,
  buildLinearCommentVariables,
  buildLinearStateUpdateVariables,
  pickCompletedStateId,
} from '../tracker/linear.writeback.logic.js'
import type {
  FetchLike,
  JiraConnection,
  LinearConnection,
} from '../tracker/TicketTrackerService.js'
import { LINEAR_GRAPHQL_URL, linearAuthHeader, unwrapLinearData } from '../shared/linear.client.js'
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
  /**
   * Resolve the workspace's Linear credentials, or null when Linear isn't configured.
   * Reuses the same seam as `TicketTrackerService`. Absent → Linear writeback passes through.
   */
  resolveLinearConnection?: (workspaceId: string) => Promise<LinearConnection | null>
  /** HTTP transport for the Jira/Linear calls (each runtime exposes a global `fetch`). */
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
      return
    }
    if (issue.source === 'linear') {
      await this.commentLinear(workspaceId, issue.externalId, body)
    }
  }

  private async resolve(workspaceId: string, issue: TaskRecord): Promise<void> {
    if (issue.source === 'github') {
      await this.deps.closeGitHubIssue?.(workspaceId, issue.externalId)
      return
    }
    if (issue.source === 'jira') {
      await this.resolveJira(workspaceId, issue.externalId)
      return
    }
    if (issue.source === 'linear') {
      await this.resolveLinear(workspaceId, issue.externalId)
    }
  }

  /** Comment on a Linear issue: resolve its UUID by identifier, then `commentCreate`. */
  private async commentLinear(
    workspaceId: string,
    identifier: string,
    body: string,
  ): Promise<void> {
    const lookup = (await this.linearRequest(workspaceId, LINEAR_ISSUE_ID_QUERY, {
      id: identifier,
    })) as { issue?: { id?: string } } | null
    const issueId = lookup?.issue?.id
    if (!issueId) return
    await this.linearRequest(
      workspaceId,
      LINEAR_COMMENT_CREATE_MUTATION,
      buildLinearCommentVariables(issueId, body),
    )
  }

  /** Resolve a Linear issue: look up its UUID + team states, then transition to completed. */
  private async resolveLinear(workspaceId: string, identifier: string): Promise<void> {
    const lookup = (await this.linearRequest(workspaceId, LINEAR_ISSUE_RESOLVE_LOOKUP_QUERY, {
      id: identifier,
    })) as { issue?: { id?: string; team?: { states?: { nodes?: unknown[] } } } } | null
    const issueId = lookup?.issue?.id
    const stateId = pickCompletedStateId(
      (lookup?.issue?.team?.states?.nodes ?? []) as Parameters<typeof pickCompletedStateId>[0],
    )
    if (!issueId || !stateId) return
    await this.linearRequest(
      workspaceId,
      LINEAR_ISSUE_UPDATE_MUTATION,
      buildLinearStateUpdateVariables(issueId, stateId),
    )
  }

  /**
   * Issue a Linear GraphQL request for the workspace's connection. Returns the
   * validated `data` (or null when Linear isn't configured). Throws on a GraphQL /
   * HTTP error so the per-issue `.catch` in {@link forEachIssue} swallows it.
   */
  private async linearRequest(
    workspaceId: string,
    document: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const { resolveLinearConnection, fetchImpl } = this.deps
    if (!resolveLinearConnection || !fetchImpl) return null
    const connection = await resolveLinearConnection(workspaceId)
    if (!connection?.apiKey) return null
    const res = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        authorization: linearAuthHeader({ apiKey: connection.apiKey }),
        accept: 'application/json',
        'content-type': 'application/json',
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({ query: document, variables }),
    })
    return unwrapLinearData<unknown>(res.status, res.ok, await res.json().catch(() => null))
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
      // Omit the body entirely for a bodyless (GET) request: the real `fetch` throws
      // for ANY non-null body on a GET — including an empty string — which the
      // per-issue catch would silently swallow, leaving Jira issues never resolved.
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Jira ${init.method} ${url} → ${res.status}: ${text.slice(0, 300)}`)
    }
    return res.json().catch(() => null)
  }
}
