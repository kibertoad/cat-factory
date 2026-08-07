import {
  describeError,
  type Logger,
  noopLogger,
  redactSecrets,
  resolveWritebackFlag,
  runBestEffort,
  REVIEW_QUESTION_POLICIES,
  REVIEW_QUESTION_POST_CLAIM_TTL_MS,
  type Block,
  type Clock,
  type IssueWritebackProvider,
  type PullRequestRef,
  type ReviewQuestionPost,
  type ReviewQuestionPostOutcome,
  type ReviewQuestionPostRepository,
  type TaskConnectionStore,
  type TaskRecord,
  type TaskRepository,
  type TaskSourceKind,
  type ReviewReplyAck,
  type TrackerSettingsRepository,
  trackerWebhookSecret,
} from '@cat-factory/kernel'
import { issueRefFor, renderReviewQuestionsComment } from './reviewQuestions.logic.js'
import { renderReviewReplyAck } from './reviewReplies.logic.js'
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
  pickStateIdByType,
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
   *
   * MUST THROW when it cannot deliver — an unparseable external id, or a workspace whose
   * installation is gone. Returning normally is the seam's promise that the comment landed. The
   * fire-and-forget hooks swallow the throw as they always have, but the parked-review writeback
   * depends on it: a facade that silently returned on an unresolved target would have its marker
   * recorded `posted` for a comment nobody ever received, permanently suppressing the retry that
   * reconnecting the installation should produce.
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
  /**
   * Idempotency markers for the parked-review question writeback. Absent → the writeback
   * passes through entirely, because posting without a marker would re-post the same
   * findings on every durable-driver replay (see the port doc).
   */
  reviewQuestionPostRepository?: ReviewQuestionPostRepository
  /**
   * The per-`(workspace, source)` tracker connection, read for ONE thing here: whether an inbound
   * webhook secret has been minted, which is what decides if a reply typed on the ticket can ever
   * reach the run (`backend/docs/adr/0032-tracker-webhook-intake.md` fails closed without one).
   *
   * A question comment that leads with `@cat-factory answer …` on a connection with no secret is
   * advice that silently does nothing, and it is the reporter — the one person who came in through
   * the ticket — who follows it. So the copy asks before it promises. Absent ⇒ the ticket channel
   * is reported UNWIRED, which is the honest reading: a facade that cannot establish the fact
   * cannot offer the channel.
   *
   * Only the per-workspace half is visible from here. The other half is the facade's own
   * `trackerCommentIngestRepository`, which both runtimes wire unconditionally and the tracker
   * webhook conformance suite proves end to end.
   */
  taskConnectionStore?: TaskConnectionStore
  /**
   * Wall clock for the marker rows and their abandonment window. The facade's shared `Clock`,
   * like every other service here; defaults to the real clock so a test can pin time without
   * every construction site having to.
   */
  clock?: Clock
  /**
   * Where the two swallowed paths below report: a marker that could not be settled, and a
   * per-issue writeback that threw inside the fan-out. Absent ⇒ `noopLogger`.
   */
  logger?: Logger
}

/** The GitHub in-progress label applied on pickup when the schedule doesn't name one. */
export const DEFAULT_IN_PROGRESS_LABEL = 'in-progress'

export class IssueWritebackService implements IssueWritebackProvider {
  private readonly log: Logger

  constructor(private readonly deps: IssueWritebackServiceDependencies) {
    this.log = (deps.logger ?? noopLogger).child({ service: 'issueWriteback' })
  }

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
    await this.forEachIssue(
      { label: 'writeback.onPullRequestOpened', workspaceId },
      issues,
      async (issue) => {
        await this.comment(workspaceId, issue, body)
      },
    )
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
    await this.forEachIssue(
      { label: 'writeback.onPullRequestMerged', workspaceId },
      issues,
      async (issue) => {
        await this.comment(workspaceId, issue, body)
        await this.resolve(workspaceId, issue)
      },
    )
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
    await this.forEachIssue(
      { label: 'writeback.onIssuePickedUp', workspaceId },
      issues,
      async (issue) => {
        await this.comment(workspaceId, issue, body)
        await this.markInProgress(workspaceId, issue, info.inProgressLabel)
      },
    )
  }

  async postReviewQuestions(
    workspaceId: string,
    block: Block,
    post: ReviewQuestionPost,
  ): Promise<ReviewQuestionPostOutcome> {
    const empty: ReviewQuestionPostOutcome = { posted: 0, skipped: 0, failed: 0 }
    const markers = this.deps.reviewQuestionPostRepository
    // No marker store ⇒ no idempotency ⇒ a replaying driver would spam the issue. Pass through
    // rather than post unsafely; the park is still surfaced by the in-app review card.
    if (!markers || post.findings.length === 0) return empty

    // Only an OPT-IN subject reads the settings, and only then does it pay for the read: bug-report
    // triage asks the reporter for what they left out, which is intake semantics (the same stance
    // `onIssuePickedUp` takes) rather than an optional courtesy about someone else's tracker.
    if (REVIEW_QUESTION_POLICIES[post.subject].optIn) {
      const settings = await this.deps.trackerSettingsRepository.get(workspaceId)
      const enabled = resolveWritebackFlag(
        settings?.writebackQuestionsOnPark ?? false,
        block.trackerQuestionsOnPark,
      )
      if (!enabled) return empty
    }

    const issues = await this.deps.taskRepository.listByBlock(workspaceId, block.id)
    if (issues.length === 0) return empty

    // Which of these issues can be REPLIED to, resolved once per distinct source rather than per
    // issue: the answer is a property of the `(workspace, source)` connection, and several issues
    // on one block routinely share one. Two bodies at most, so the render is memoised on the same
    // boolean instead of being recomputed alongside it.
    const repliesBySource = await this.resolveTicketReplyChannels(workspaceId, issues)
    const bodies = new Map<boolean, string>()
    const bodyFor = (ticketReplies: boolean): string => {
      const cached = bodies.get(ticketReplies)
      if (cached !== undefined) return cached
      const rendered = renderReviewQuestionsComment(post, { ticketReplies })
      bodies.set(ticketReplies, rendered)
      return rendered
    }
    const now = () => (this.deps.clock ?? Date).now()
    const outcome = { ...empty }
    // Sequential on purpose: a review typically has ONE linked issue, and posting the same
    // long comment to several trackers at once buys nothing while making a rate-limit
    // response more likely.
    for (const issue of issues) {
      const key = {
        workspaceId,
        reviewId: post.reviewId,
        iteration: post.iteration,
        issueRef: issueRefFor(issue),
      }
      // Claim BEFORE posting: a crash between the comment and the marker write must not
      // re-post on the next replay. A `failed` marker is re-claimable, so a tracker outage is
      // retried rather than swallowed; a long-abandoned `pending` one is re-claimable too, so
      // a poster killed mid-post doesn't silence this iteration forever.
      const at = now()
      const window = {
        now: at,
        reclaimPendingBefore: at - REVIEW_QUESTION_POST_CLAIM_TTL_MS,
      }
      // A store failure reads as "someone else holds the claim", which silently suppresses this
      // iteration's post — so it is the one fallback-value catch here that must still say why.
      const claimed = await markers.claim(key, window).catch((error: unknown) => {
        this.log.warn('review question claim unreadable; treating it as already claimed', {
          workspaceId,
          blockId: block.id,
          issueRef: key.issueRef,
          ...describeError(error),
        })
        return false
      })
      if (!claimed) {
        outcome.skipped += 1
        continue
      }
      const ticketReplies = repliesBySource.get(issue.source) ?? false
      if (!ticketReplies) {
        // Said once per claimed post (the marker bounds it), because the remedy is the operator's
        // and the symptom otherwise reaches nobody: the reporter is being asked a question they
        // cannot answer from where they are reading it, and the comment they get says so only by
        // omission.
        this.log.warn('review questions posted with no ticket reply channel', {
          workspaceId,
          blockId: block.id,
          subject: post.subject,
          source: issue.source,
          externalId: issue.externalId,
          remedy: `mint an inbound webhook secret for the ${issue.source} connection`,
        })
      }
      try {
        // Deliberately NOT wrapped in a wall-clock deadline. A timeout cannot distinguish "the
        // comment never landed" from "it landed, slowly": settling `failed` on that guess makes
        // the next replay post a SECOND copy onto an issue a human is reading, which is the one
        // outcome this whole marker exists to prevent. A hung transport is instead cut off by
        // the driver's own step limit, and the claim's abandonment window (above) makes that
        // row re-claimable — self-healing without ever inventing a duplicate.
        const delivered = await this.comment(workspaceId, issue, bodyFor(ticketReplies))
        if (!delivered) throw new Error(`No ${issue.source} comment transport is wired`)
        await markers.settle(key, { status: 'posted' }, now())
        outcome.posted += 1
      } catch (e) {
        outcome.failed += 1
        // Scrubbed like every other stored free text: a transport error can quote the request
        // URL, and this row is read back by operators (and, in slice 2b, by support tooling).
        const raw = e instanceof Error ? e.message : String(e)
        const error = (redactSecrets(raw) ?? '').slice(0, 500)
        this.log.warn('review question post failed', {
          workspaceId,
          blockId: block.id,
          source: issue.source,
          externalId: issue.externalId,
          err: error,
        })
        // A settle that ALSO fails leaves the claim `pending` until its TTL reclaims it, so the
        // post still self-heals — but the marker store being the second broken thing needs saying.
        await runBestEffort(
          this.log,
          'reviewQuestionPost.settleFailed',
          () => markers.settle(key, { status: 'failed', error }, now()),
          { workspaceId, blockId: block.id, source: issue.source, externalId: issue.externalId },
        )
      }
    }
    return outcome
  }

  /**
   * Whether a reply typed on a ticket reaches the run, per DISTINCT source across the block's
   * linked issues.
   *
   * One connection read per distinct source, indexed into a `Map`, rather than one per issue: the
   * fact belongs to `(workspace, source)`, and a block linked to three issues on one tracker would
   * otherwise pay three decrypting reads for one answer.
   *
   * An unreadable connection resolves to `false` and is REPORTED, never guessed at: the failure
   * mode of guessing `true` is a reporter told to reply where nothing listens, which is the exact
   * thing this resolution exists to prevent.
   */
  private async resolveTicketReplyChannels(
    workspaceId: string,
    issues: readonly Pick<TaskRecord, 'source'>[],
  ): Promise<Map<TaskSourceKind, boolean>> {
    const wired = new Map<TaskSourceKind, boolean>()
    const connections = this.deps.taskConnectionStore
    if (!connections) return wired
    const sources = [...new Set(issues.map((issue) => issue.source))]
    try {
      const opened = await connections.listBySources(workspaceId, sources)
      // Default FALSE for every source asked about, then raise the ones that answered: a source
      // with no stored connection is simply absent from the result, and it has no reply channel.
      for (const source of sources) wired.set(source, false)
      for (const connection of opened) {
        wired.set(connection.source, trackerWebhookSecret(connection.credentials) !== '')
      }
    } catch (error) {
      this.log.warn('tracker connections unreadable; offering the API answer path only', {
        workspaceId,
        sources,
        ...describeError(error),
      })
      for (const source of sources) wired.set(source, false)
    }
    return wired
  }

  /**
   * Acknowledge a ticket reply on the very issue it arrived on.
   *
   * Deliberately NOT marker-gated, unlike {@link postReviewQuestions}: an ack is the terminal
   * effect of an ingest that is ALREADY claimed exactly once by `tracker_comment_ingests`, so a
   * second marker here would guard nothing and add a second thing to reason about. It is also not
   * gated on the workspace writeback settings — a reply is an explicit request for a response, not
   * an unsolicited courtesy.
   *
   * Best-effort throughout: the reply is applied and settled before this runs, so a tracker outage
   * costs the acknowledgement, never the answer.
   */
  async postReviewReplyAck(
    workspaceId: string,
    issue: { source: TaskSourceKind; externalId: string },
    ack: ReviewReplyAck,
  ): Promise<void> {
    await this.comment(workspaceId, issue, renderReviewReplyAck(ack))
  }

  /**
   * Run a writeback per issue, isolating failures so one bad issue can't block the rest. Each
   * isolated failure names the issue it belongs to: these hooks are fire-and-forget, so a
   * permanently broken tracker connection produces no other symptom than comments that never
   * appear.
   */
  private async forEachIssue(
    op: { label: string; workspaceId: string },
    issues: TaskRecord[],
    fn: (issue: TaskRecord) => Promise<void>,
  ): Promise<void> {
    await Promise.all(
      issues.map((issue) =>
        runBestEffort(this.log, op.label, () => fn(issue), {
          workspaceId: op.workspaceId,
          source: issue.source,
          externalId: issue.externalId,
        }),
      ),
    )
  }

  /**
   * Post a comment on one linked issue. Returns whether this deployment has a transport for that
   * issue's source at all; a wired transport that cannot deliver THROWS (see the seam docs), so
   * `true` means the comment landed. The fire-and-forget hooks ignore both signals, but the
   * parked-review writeback distinguishes them: an unwired source is a permanent no-op to retry
   * once someone wires it, a throw is a failure to retry on the next replay, and neither may be
   * recorded as `posted`.
   */
  private async comment(
    workspaceId: string,
    // Narrowed to the natural key rather than the whole record: the ticket-reply ack addresses the
    // issue the comment ARRIVED on, which it knows as `(source, externalId)` off the delivery and
    // has no reason to re-read from the projection.
    issue: Pick<TaskRecord, 'source' | 'externalId'>,
    body: string,
  ): Promise<boolean> {
    if (issue.source === 'github') {
      if (!this.deps.commentOnGitHubIssue) return false
      await this.deps.commentOnGitHubIssue(workspaceId, issue.externalId, body)
      return true
    }
    if (issue.source === 'jira') {
      if (!this.deps.resolveJiraConnection || !this.deps.fetchImpl) return false
      await this.jiraRequest(workspaceId, `issue/${encodeURIComponent(issue.externalId)}/comment`, {
        method: 'POST',
        body: buildJiraCommentPayload(body),
      })
      return true
    }
    if (issue.source === 'linear') {
      if (!this.deps.resolveLinearConnection || !this.deps.fetchImpl) return false
      await this.commentLinear(workspaceId, issue.externalId, body)
      return true
    }
    return false
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
      await this.transitionLinear(workspaceId, issue.externalId, 'completed')
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
      await this.transitionLinear(workspaceId, issue.externalId, 'started')
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
    stateType: 'completed' | 'started',
  ): Promise<void> {
    const lookup = (await this.linearRequest(workspaceId, LINEAR_ISSUE_RESOLVE_LOOKUP_QUERY, {
      id: identifier,
    })) as { issue?: { id?: string; team?: { states?: { nodes?: unknown[] } } } } | null
    const issueId = lookup?.issue?.id
    const stateId = pickStateIdByType(
      (lookup?.issue?.team?.states?.nodes ?? []) as Parameters<typeof pickStateIdByType>[0],
      stateType,
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
   * HTTP error so the per-issue isolation in {@link forEachIssue} reports and swallows it.
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
   * per-issue isolation in {@link forEachIssue} reports and swallows it.
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
