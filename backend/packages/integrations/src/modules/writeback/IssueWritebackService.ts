import {
  resolveWritebackFlag,
  type Block,
  type IssueWritebackProvider,
  type PullRequestRef,
  type TaskRecord,
  type TaskRepository,
  type TrackerSettingsRepository,
} from '@cat-factory/kernel'
import {
  buildJiraCommentPayload,
  pickTransitionByCategory,
} from '../tracker/jira.writeback.logic.js'
import {
  LINEAR_COMMENT_CREATE_MUTATION,
  LINEAR_ISSUE_ID_QUERY,
  LINEAR_ISSUE_RESOLVE_LOOKUP_QUERY,
  LINEAR_ISSUE_UPDATE_MUTATION,
  buildLinearCommentVariables,
  buildLinearStateUpdateVariables,
  pickCompletedStateId,
  pickStartedStateId,
} from '../tracker/linear.writeback.logic.js'
import type {
  FetchLike,
  JiraConnection,
  LinearConnection,
} from '../tracker/TicketTrackerService.js'
import { linearAuthFromCredentials, postLinearGraphql } from '../shared/linear.client.js'
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
   * Apply a label to a GitHub issue (creating the label if absent) identified by
   * its `owner/repo#number` external id — the intake pickup's in-progress mark
   * (GitHub has no native workflow status). Absent → the mark passes through.
   */
  labelGitHubIssue?: (workspaceId: string, externalId: string, label: string) => Promise<void>
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

/** The GitHub in-progress label applied on pickup when the schedule doesn't name one. */
export const DEFAULT_IN_PROGRESS_LABEL = 'in-progress'

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

  async onIssuePickedUp(
    workspaceId: string,
    blockId: string,
    info: { runUrl?: string; inProgressLabel?: string },
  ): Promise<void> {
    // Deliberately NOT gated on the workspace writeback settings: claiming the
    // issue where it was filed is the intake step's semantics, not a courtesy
    // (see the port doc). Still best-effort per issue, like every hook here.
    const issues = await this.deps.taskRepository.listByBlock(workspaceId, blockId)
    if (issues.length === 0) return
    const body = info.runUrl
      ? `🤖 Taken by cat-factory — this issue is being worked autonomously: ${info.runUrl}`
      : '🤖 Taken by cat-factory — this issue is being worked autonomously.'
    await this.forEachIssue(issues, async (issue) => {
      await this.comment(workspaceId, issue, body)
      await this.markInProgress(workspaceId, issue, info.inProgressLabel)
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
      await this.transitionJira(workspaceId, issue.externalId, 'done')
      return
    }
    if (issue.source === 'linear') {
      await this.transitionLinear(workspaceId, issue.externalId, pickCompletedStateId)
    }
  }

  /**
   * Mark a picked-up issue in-progress: the vendor's in-progress workflow
   * transition (Jira's `indeterminate` status category / Linear's `started`
   * state), or the in-progress label for GitHub, which has no native status.
   */
  private async markInProgress(
    workspaceId: string,
    issue: TaskRecord,
    inProgressLabel: string | undefined,
  ): Promise<void> {
    if (issue.source === 'github') {
      await this.deps.labelGitHubIssue?.(
        workspaceId,
        issue.externalId,
        inProgressLabel ?? DEFAULT_IN_PROGRESS_LABEL,
      )
      return
    }
    if (issue.source === 'jira') {
      await this.transitionJira(workspaceId, issue.externalId, 'indeterminate')
      return
    }
    if (issue.source === 'linear') {
      await this.transitionLinear(workspaceId, issue.externalId, pickStartedStateId)
    }
  }

  /**
   * Comment on a Linear issue: resolve its UUID by identifier, then `commentCreate`.
   * On merge this runs before {@link resolveLinear}, so the issue is looked up twice
   * (here for the UUID, there for the UUID + the team's workflow states). That second
   * lookup is unavoidable — only it carries the states needed to pick the resolved
   * state — and the duplicated read is one cheap `issue(id:){id}` call, so the seam is
   * kept uniform with the GitHub/Jira comment/resolve split rather than special-cased.
   */
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

  /**
   * Transition a Linear issue: look up its UUID + team states, pick the target
   * state (`completed` on resolve, `started` on pickup), then `issueUpdate`.
   */
  private async transitionLinear(
    workspaceId: string,
    identifier: string,
    pickStateId: (states: Parameters<typeof pickCompletedStateId>[0]) => string | null,
  ): Promise<void> {
    const lookup = (await this.linearRequest(workspaceId, LINEAR_ISSUE_RESOLVE_LOOKUP_QUERY, {
      id: identifier,
    })) as { issue?: { id?: string; team?: { states?: { nodes?: unknown[] } } } } | null
    const issueId = lookup?.issue?.id
    const stateId = pickStateId(
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
    if (!connection?.token && !connection?.apiKey) return null
    return postLinearGraphql<unknown>(
      fetchImpl,
      linearAuthFromCredentials(connection),
      document,
      variables,
    )
  }

  /**
   * Transition a Jira issue into a standard status category: `done` on resolve,
   * `indeterminate` (In Progress) on pickup. Lists the issue's available
   * transitions and fires the first one landing in the category.
   */
  private async transitionJira(
    workspaceId: string,
    key: string,
    category: 'indeterminate' | 'done',
  ): Promise<void> {
    const path = `issue/${encodeURIComponent(key)}/transitions`
    const list = (await this.jiraRequest(workspaceId, path, { method: 'GET' })) as {
      transitions?: Parameters<typeof pickTransitionByCategory>[0]
    } | null
    const transition = pickTransitionByCategory(list?.transitions ?? [], category)
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
