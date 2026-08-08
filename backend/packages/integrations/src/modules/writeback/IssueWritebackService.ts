import {
  createTaskWritebackContext,
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
  type TaskCredentials,
  type TaskRecord,
  type TaskRepository,
  type TaskSourceKind,
  type TaskSourceProvider,
  type TaskSourceWritebackAdapter,
  type TaskWritebackContext,
  type ReviewReplyAck,
  type TrackerSettingsRepository,
  trackerWebhookSecret,
} from '@cat-factory/kernel'
import { issueRefFor, renderReviewQuestionsComment } from './reviewQuestions.logic.js'
import { renderReviewReplyAck } from './reviewReplies.logic.js'
import { MapTaskSourceRegistry } from '../tasks/tasks.logic.js'

// IssueWritebackService: the runtime-neutral `IssueWritebackProvider`. As a task's PR progresses
// the execution engine calls it to write back to the task's linked tracker issue(s): comment when
// the PR opens, comment + resolve when it merges, claim an issue the recurring intake picked up,
// echo a parked review's open questions, and acknowledge a reply that answered them.
//
// It owns the SHARED half of every one of those: the workspace's writeback settings (with the
// per-task override on the block), the linked-issue lookup, the per-issue failure isolation, and
// the parked-review idempotency marker. It owns NONE of the vendor half. Each source's provider
// declares a `TaskSourceWritebackAdapter` and this service dispatches through the registry, which
// is what makes the writeback a property of the SOURCE rather than of this file: the
// `if (source === 'github' | 'jira' | 'linear')` chain it replaced meant GitLab Issues shipped
// with full intake and no writeback at all, and a deployment-registered source could not have one
// however it was wired.
//
// Every action is best-effort: each issue's writeback is isolated so one failure never blocks the
// others, and the engine calls these fire-and-forget. Best-effort is not silent, though. An
// unwired source, an unreadable connection and a capability the vendor lacks are three different
// facts, and each is reported with the remedy it needs.

export interface IssueWritebackServiceDependencies {
  trackerSettingsRepository: TrackerSettingsRepository
  taskRepository: TaskRepository
  /**
   * The task sources this deployment wires, BY REFERENCE: the same array the tasks module builds
   * its registry from, so a source registered once is written back to without a second wiring
   * decision (and a deployment's own source gets the whole loop for free).
   *
   * Absent or empty ⇒ every writeback passes through, which is the honest reading of a deployment
   * with no tracker integration at all.
   */
  taskSourceProviders?: readonly TaskSourceProvider[]
  /**
   * The per-`(workspace, source)` tracker connection, read for two things: the credential bag a
   * writeback adapter authenticates with, and whether an inbound webhook secret has been minted,
   * which is what decides if a reply typed on the ticket can ever reach the run
   * (`backend/docs/adr/0032-tracker-webhook-intake.md` fails closed without one).
   *
   * A question comment that leads with `@cat-factory answer …` on a connection with no secret is
   * advice that silently does nothing, and it is the reporter — the one person who came in through
   * the ticket — who follows it. So the copy asks before it promises. Absent ⇒ the ticket channel
   * is reported UNWIRED and every adapter is handed an empty bag, which is the honest reading: a
   * facade that cannot open a connection cannot offer the channel or authenticate as the tenant.
   *
   * Only the per-workspace half is visible from here. The other half is the facade's own
   * `trackerCommentIngestRepository`, which both runtimes wire unconditionally and the tracker
   * webhook conformance suite proves end to end.
   */
  taskConnectionStore?: TaskConnectionStore
  /**
   * Idempotency markers for the parked-review question writeback. Absent → the writeback
   * passes through entirely, because posting without a marker would re-post the same
   * findings on every durable-driver replay (see the port doc).
   */
  reviewQuestionPostRepository?: ReviewQuestionPostRepository
  /**
   * Wall clock for the marker rows and their abandonment window. The facade's shared `Clock`,
   * like every other service here; defaults to the real clock so a test can pin time without
   * every construction site having to.
   */
  clock?: Clock
  /**
   * Where every degraded path reports: an unwired source, an unreadable connection, a marker that
   * could not be settled, a per-issue writeback that threw inside the fan-out. Absent ⇒
   * `noopLogger`.
   */
  logger?: Logger
}

/**
 * What this deployment can do for one source right now, resolved ONCE per distinct source across
 * a block's linked issues rather than per issue: every leg of it belongs to `(workspace, source)`,
 * and a block linked to three issues on one tracker would otherwise pay three decrypting reads
 * for one answer.
 */
type ResolvedSource =
  /**
   * A writeback adapter plus the batch context every call for this source shares: one
   * `TaskWritebackContext`, so an adapter's workspace-invariant reads are paid for once across a
   * block's linked issues rather than once per call (see the port's `once`).
   */
  | {
      status: 'ready'
      adapter: TaskSourceWritebackAdapter
      ctx: TaskWritebackContext
      ticketReplies: boolean
    }
  /** No provider registered for this source, or one without the writeback capability. */
  | { status: 'unwired' }
  /** The stored connection would not open, so nothing at all was learned about this source. */
  | { status: 'unreadable' }

export class IssueWritebackService implements IssueWritebackProvider {
  private readonly log: Logger
  private readonly sources: MapTaskSourceRegistry

  constructor(private readonly deps: IssueWritebackServiceDependencies) {
    this.log = (deps.logger ?? noopLogger).child({ service: 'issueWriteback' })
    this.sources = new MapTaskSourceRegistry([...(deps.taskSourceProviders ?? [])])
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
    const resolved = await this.resolveSources(workspaceId, issues)
    const body = `🔧 A pull request was opened for this issue: ${pr.url}`
    await this.forEachIssue(
      { label: 'writeback.onPullRequestOpened', workspaceId },
      issues,
      async (issue) => {
        await this.comment(workspaceId, resolved, issue, body)
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
    const resolved = await this.resolveSources(workspaceId, issues)
    const body = `✅ The pull request was merged and this issue is resolved: ${pr.url}`
    await this.forEachIssue(
      { label: 'writeback.onPullRequestMerged', workspaceId },
      issues,
      async (issue) => {
        await this.comment(workspaceId, resolved, issue, body)
        await this.applyState(workspaceId, resolved, issue, 'resolve', {})
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
    const resolved = await this.resolveSources(workspaceId, issues)
    const body = info.runUrl
      ? `🤖 Taken by cat-factory — this issue is being worked autonomously: ${info.runUrl}`
      : '🤖 Taken by cat-factory — this issue is being worked autonomously.'
    await this.forEachIssue(
      { label: 'writeback.onIssuePickedUp', workspaceId },
      issues,
      async (issue) => {
        await this.comment(workspaceId, resolved, issue, body)
        await this.applyState(
          workspaceId,
          resolved,
          issue,
          'markInProgress',
          info.inProgressLabel ? { label: info.inProgressLabel } : {},
        )
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

    // Which of these issues can be REPLIED to rides the same per-source resolution the comment
    // transport does, so the two cannot disagree about a connection. Two bodies at most, so the
    // render is memoised on the same boolean instead of being recomputed alongside it.
    const resolved = await this.resolveSources(workspaceId, issues)
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
      const source = resolved.get(issue.source)
      const ticketReplies = source?.status === 'ready' && source.ticketReplies
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
        const delivered = await this.comment(workspaceId, resolved, issue, bodyFor(ticketReplies))
        if (!delivered) throw new Error(`No ${issue.source} writeback is wired`)
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
    const resolved = await this.resolveSources(workspaceId, [issue])
    await this.comment(workspaceId, resolved, issue, renderReviewReplyAck(ack))
  }

  /**
   * What this deployment can do for each source the given issues sit on: the registered
   * provider's writeback adapter, the batch context carrying the workspace's credential bag for
   * it, and whether a reply typed on one of its tickets reaches the run.
   *
   * ONE connection read for the whole set, indexed by source.
   *
   * What an unreadable row costs is the ADAPTER's own declaration (`authenticates`), never a guess
   * from the empty bag it leaves behind. A `stored-connection` adapter resolves to `unreadable`
   * and is REPORTED: writing back with a bag that would not open authenticates as nobody, and the
   * vendor's rejection would name the wrong fault. An `out-of-band` adapter (GitHub Issues rides
   * the workspace's App, GitLab Issues its VCS connection) never needed the row to post, so it
   * stays READY and loses only what the row actually carried: the reply channel, which is
   * WITHHELD rather than assumed, because telling a reporter to reply where nothing listens is
   * the exact thing this resolution exists to prevent.
   *
   * Both verdicts are scoped to the SOURCE they were learned about. A block's issues can span
   * trackers, and a corrupt Linear envelope is no evidence at all about the workspace's Jira
   * connection, so a batch-wide failure would take a working channel away from a healthy ticket.
   */
  private async resolveSources(
    workspaceId: string,
    issues: readonly Pick<TaskRecord, 'source'>[],
  ): Promise<Map<TaskSourceKind, ResolvedSource>> {
    const sources = [...new Set(issues.map((issue) => issue.source))]
    const out = new Map<TaskSourceKind, ResolvedSource>()
    /** The adapter for a source, or `undefined` when nothing is registered to write back with. */
    const adapterFor = (source: TaskSourceKind) => this.sources.get(source)?.writeback
    const ready = (
      adapter: TaskSourceWritebackAdapter,
      credentials: TaskCredentials,
      ticketReplies: boolean,
    ): ResolvedSource => ({
      status: 'ready',
      adapter,
      ctx: createTaskWritebackContext({ workspaceId, credentials }),
      ticketReplies,
    })
    /**
     * A source that HAS no stored connection: no row, or no store wired at all. Every adapter
     * stays ready with an empty bag, because absence is the adapter's own question to answer. A
     * credentialless one is unaffected, and one that needs credentials throws from the call with
     * a message naming the missing connection, which beats this file guessing that fault from
     * outside (see the port doc on `TaskWritebackContext.credentials`).
     *
     * A row that FAILED to open is the opposite case and is handled below: something exists and
     * could not be read, so an adapter that needs it must not be asked to try.
     */
    for (const source of sources) {
      const adapter = adapterFor(source)
      out.set(source, adapter ? ready(adapter, {}, false) : { status: 'unwired' })
    }

    const connections = this.deps.taskConnectionStore
    if (!connections) return out
    let opened: Awaited<ReturnType<typeof connections.listBySources>>
    try {
      opened = await connections.listBySources(workspaceId, sources)
    } catch (error) {
      // The stored-row READ itself failed, before any source was opened, so nothing was learned
      // about any of them.
      this.markUnreadable(out, workspaceId, sources, error)
      return out
    }
    for (const result of opened) {
      if (result.status === 'unreadable') {
        this.markUnreadable(out, workspaceId, [result.source], result.cause)
        continue
      }
      const adapter = adapterFor(result.source)
      if (!adapter) continue
      const credentials = result.connection.credentials
      out.set(result.source, ready(adapter, credentials, trackerWebhookSecret(credentials) !== ''))
    }
    return out
  }

  /**
   * Record a connection that would not open, costing each source only what it actually costs.
   *
   * An adapter that authenticates WITH the bag is lost until the connection is repaired, so it
   * resolves to `unreadable` and every call for it fails loudly. An `out-of-band` one keeps its
   * whole writeback (it authenticates from `workspaceId` and only ever read this row for the
   * inbound secret) and loses just the reply channel, which the seeded entry already withholds.
   * Reading the failure as one fact for every source is what would let a rotated
   * `TASKS_ENCRYPTION_KEY` silence GitHub's PR notices, and the two log lines say which happened
   * because an operator acts on them differently.
   */
  private markUnreadable(
    out: Map<TaskSourceKind, ResolvedSource>,
    workspaceId: string,
    sources: readonly TaskSourceKind[],
    cause: unknown,
  ): void {
    for (const source of sources) {
      const outOfBand = this.sources.get(source)?.writeback?.authenticates === 'out-of-band'
      if (!outOfBand) out.set(source, { status: 'unreadable' })
      this.log.warn(
        outOfBand
          ? 'tracker connection unreadable; the writeback still posts but can offer no ticket reply channel'
          : 'tracker connection unreadable; writeback cannot authenticate',
        { workspaceId, source, ...describeError(cause) },
      )
    }
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
   * Post a comment on one linked issue. Returns whether this deployment has a writeback for that
   * issue's source at all; an adapter that cannot deliver THROWS (see the port), so `true` means
   * the comment landed. The fire-and-forget hooks ignore both signals, but the parked-review
   * writeback distinguishes them: an unwired source is a permanent no-op to retry once someone
   * wires it, a throw is a failure to retry on the next replay, and neither may be recorded as
   * `posted`.
   */
  private async comment(
    workspaceId: string,
    resolved: Map<TaskSourceKind, ResolvedSource>,
    // Narrowed to the natural key rather than the whole record: the ticket-reply ack addresses the
    // issue the comment ARRIVED on, which it knows as `(source, externalId)` off the delivery and
    // has no reason to re-read from the projection.
    issue: Pick<TaskRecord, 'source' | 'externalId'>,
    body: string,
  ): Promise<boolean> {
    const source = resolved.get(issue.source)
    if (source?.status !== 'ready') {
      // An unreadable connection is a FAILURE to retry, not an absent capability: the source is
      // wired and the row exists, it just could not be opened this time.
      if (source?.status === 'unreadable') {
        throw new Error(`The ${issue.source} connection for this workspace could not be opened`)
      }
      this.log.warn('no writeback is wired for this source; the comment was not posted', {
        workspaceId,
        source: issue.source,
        externalId: issue.externalId,
        remedy: `register a ${issue.source} task-source provider declaring a writeback adapter`,
      })
      return false
    }
    await source.adapter.comment(source.ctx, issue.externalId, body)
    return true
  }

  /**
   * Apply the issue's state change for a hook: `resolve` on merge, `markInProgress` on pickup.
   *
   * Both are OPTIONAL on the adapter, and an omitted one is reported rather than passed over in
   * silence. A tracker whose vendor has no such notion is a real answer an operator may need (the
   * merge comment landed and the issue stayed open, and only this line says why), and it must not
   * read like the write simply succeeded.
   */
  private async applyState(
    workspaceId: string,
    resolved: Map<TaskSourceKind, ResolvedSource>,
    issue: TaskRecord,
    action: 'resolve' | 'markInProgress',
    mark: { label?: string },
  ): Promise<void> {
    const source = resolved.get(issue.source)
    // An unwired or unreadable source has already been reported by the comment that preceded
    // every call site, so this stays quiet rather than logging the same fact twice.
    if (source?.status !== 'ready') return
    const ctx = source.ctx
    if (action === 'resolve') {
      if (!source.adapter.resolve) {
        this.log.warn('this source cannot resolve an issue; it was commented on but left open', {
          workspaceId,
          source: issue.source,
          externalId: issue.externalId,
        })
        return
      }
      await source.adapter.resolve(ctx, issue.externalId)
      return
    }
    if (!source.adapter.markInProgress) {
      this.log.warn('this source cannot mark an issue in progress; the pickup is comment-only', {
        workspaceId,
        source: issue.source,
        externalId: issue.externalId,
      })
      return
    }
    await source.adapter.markInProgress(ctx, issue.externalId, mark)
  }
}
