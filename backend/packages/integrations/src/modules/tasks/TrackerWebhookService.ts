import {
  type Clock,
  getErrorMessage,
  type IssueWritebackProvider,
  type Logger,
  noopLogger,
  redactSecrets,
  runBestEffort,
  type RequirementReview,
  type RequirementReviewItem,
  type ResolveRequirementsExceededChoice,
  type ReviewItemStatus,
  type ReviewQuestionFinding,
  type ReviewReplyAck,
  type ReviewReplyRejection,
  type TaskConnectionRepository,
  type TaskRepository,
  TRACKER_COMMENT_INGEST_CLAIM_TTL_MS,
  TRACKER_WEBHOOK_REPLY_ALLOW_KEY,
  type TrackerCommentEvent,
  type TrackerCommentIngestRepository,
  type TrackerIssueEvent,
  type TrackerWebhookEvent,
} from '@cat-factory/kernel'
import {
  isAllowedReplyAuthor,
  isPlatformAuthoredComment,
  parseReviewReplyCommands,
  type ReviewReplyCommand,
} from '../writeback/reviewReplies.logic.js'

// TrackerWebhookService: what a VERIFIED, parsed tracker delivery actually does.
//
// The receiver owns the transport and this owns the meaning, in exactly two branches:
//
//  - An ISSUE event may qualify a recurring `bug-intake` schedule, in which case the schedule is
//    FIRED — it does not import anything itself. The whole point (D3 of
//    `backend/docs/adr/0032-tracker-webhook-intake.md`) is that push removes the latency and reuses the
//    unchanged `BugIntakeService` path for everything else, so there is exactly one intake
//    implementation and its dedup/replace-link/pickup-mark behaviour cannot drift.
//  - A COMMENT event on an issue linked to a block with a parked requirements review may answer
//    that review's findings by their stable ids. Every mutation routes through the SAME service
//    methods the SPA and `PublicDecisionController` call, so the park's CAS/approval-id
//    arbitration and the task's preset knobs apply identically. There is NEVER a parallel
//    mutation path into the engine.
//
// Everything is best-effort and degrades to a no-op: an unwired dependency, an unlinked issue, a
// settled review or a comment with no commands all resolve to an ignored outcome rather than an
// error, because the caller is a webhook consumer whose only lever is retry — and retrying a
// delivery we will never act on just makes the tracker redeliver it.

/**
 * The requirements-review surface, narrowed to what a ticket reply drives.
 *
 * Declared structurally rather than imported: `@cat-factory/orchestration` depends on this
 * package, so naming its types here would invert the layering. The composition root binds these
 * to `requirements.service` + `executionService.requirementsReview` — the very methods the SPA
 * controller calls — which is what makes "no parallel mutation path" true by construction rather
 * than by discipline.
 */
export interface ReviewReplyGateway {
  /** The block's live review, or null when it has none. */
  getForBlock(workspaceId: string, blockId: string): Promise<RequirementReview | null>
  /** Record a human answer against one finding. */
  replyToItem(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    reply: string,
  ): Promise<RequirementReview>
  /** Set a finding's status (dismiss / reopen). */
  setItemStatus(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    status: ReviewItemStatus,
  ): Promise<RequirementReview>
  /** Fold the recorded answers in and re-review — the async path the durable driver runs. */
  incorporate(workspaceId: string, blockId: string, feedback?: string): Promise<RequirementReview>
  /** Settle the review with the last incorporated document and advance the parked run. */
  proceed(workspaceId: string, blockId: string): Promise<RequirementReview>
  /** Resolve a review that hit its iteration cap. */
  resolveExceeded(
    workspaceId: string,
    blockId: string,
    choice: ResolveRequirementsExceededChoice,
  ): Promise<RequirementReview>
}

export interface TrackerWebhookServiceDependencies {
  taskRepository: TaskRepository
  taskConnectionRepository: TaskConnectionRepository
  /**
   * Fire every recurring schedule whose intake configuration this issue event qualifies for,
   * returning how many fired. Bound to `RecurringPipelineService.triggerForIssueEvent`. Absent ⇒
   * push-driven intake is off and the polling schedule alone covers it (which is the pre-existing
   * behaviour, so an unwired facade is byte-for-byte unchanged).
   */
  triggerIntake?: (workspaceId: string, event: TrackerIssueEvent) => Promise<number>
  /** The requirements-review surface. Absent ⇒ ticket replies are ignored. */
  reviewGateway?: ReviewReplyGateway
  /**
   * Idempotency markers. Absent ⇒ replies are ignored entirely, because applying without a claim
   * would re-answer the same finding on every redelivery — the same "pass through rather than act
   * unsafely" stance `postReviewQuestions` takes without its marker store.
   */
  commentIngestRepository?: TrackerCommentIngestRepository
  /** Posts the follow-up acknowledgement. Absent ⇒ replies still apply, silently. */
  issueWriteback?: Pick<IssueWritebackProvider, 'postReviewReplyAck'>
  /** Resolve the run parked on a block, so the ack can name it. Absent ⇒ the ack omits the id. */
  resolveRunId?: (workspaceId: string, blockId: string) => Promise<string | null>
  clock?: Clock
  /** Structured logger for the silent-drop paths (an unauthorized reply leaves no other trace). */
  logger?: Logger
}

/**
 * What a delivery did, for the consumer's logs. Deliberately coarse: a webhook consumer's only
 * decisions are "ack" and "retry", and every outcome here is an ack.
 */
export type TrackerWebhookOutcome =
  | { kind: 'intake'; fired: number }
  | { kind: 'reply'; outcome: ReviewReplyAck['outcome'] }
  | { kind: 'ignored'; reason: string }

/** Longest reply text stored against a finding, after scrubbing. */
const MAX_REPLY_CHARS = 4_000

export class TrackerWebhookService {
  private readonly log: Logger

  constructor(private readonly deps: TrackerWebhookServiceDependencies) {
    this.log = (deps.logger ?? noopLogger).child({ service: 'trackerWebhook' })
  }

  /** Route one verified, parsed delivery. */
  async handle(workspaceId: string, event: TrackerWebhookEvent): Promise<TrackerWebhookOutcome> {
    return event.kind === 'issue'
      ? this.handleIssue(workspaceId, event)
      : this.handleComment(workspaceId, event)
  }

  /**
   * An issue moved on the tracker: fire any recurring intake schedule it qualifies for.
   *
   * Nothing is imported here. The fired run's `bug-intake` step does the searching, dedup,
   * importing, linking and claiming through the unchanged `BugIntakeService`, so a push-driven
   * pickup is byte-for-byte a cadence pickup that simply happened sooner.
   */
  private async handleIssue(
    workspaceId: string,
    event: TrackerIssueEvent,
  ): Promise<TrackerWebhookOutcome> {
    if (!this.deps.triggerIntake) return { kind: 'ignored', reason: 'intake_not_wired' }
    const fired = await this.deps.triggerIntake(workspaceId, event)
    return { kind: 'intake', fired }
  }

  /**
   * A comment landed on a tracked issue: apply any review commands it carries.
   *
   * The guard ORDER is load-bearing and runs cheapest-and-most-silencing first:
   *
   *  1. **No commands ⇒ ignore, before anything else.** Most comments on a linked issue are
   *     ordinary human discussion; reading the projection for each of them would make every
   *     conversation cost a database round trip.
   *  2. **Bot / unauthorized author ⇒ drop SILENTLY** — no state change and, deliberately, no ack.
   *     Replying would confirm the hook exists and hand an attacker an oracle (D7). The bot half
   *     also stops the platform's own ack comment from feeding itself.
   *  3. Only then the projection lookup, the review lookup, and the claim.
   */
  private async handleComment(
    workspaceId: string,
    event: TrackerCommentEvent,
  ): Promise<TrackerWebhookOutcome> {
    const gateway = this.deps.reviewGateway
    const markers = this.deps.commentIngestRepository
    if (!gateway || !markers) return { kind: 'ignored', reason: 'replies_not_wired' }

    // Our OWN comments, refused structurally before anything else. The author-side bot check below
    // catches them on GitHub and Jira, but Linear flags no bots and the default allow-list admits
    // any author — so on Linear an acknowledgement is an allowed author commenting on an issue we
    // are linked to, and an ack that could re-enter its own ingest is an unbounded comment loop
    // rather than a duplicate (each ack carries a fresh comment id, so the claim cannot stop it).
    // Cheap, vendor-independent, and it holds whatever a future renderer writes.
    if (isPlatformAuthoredComment(event.body)) return { kind: 'ignored', reason: 'self_authored' }

    const commands = parseReviewReplyCommands(event.body)
    if (commands.length === 0) return { kind: 'ignored', reason: 'no_commands' }

    const connection = await this.deps.taskConnectionRepository.getByWorkspace(
      workspaceId,
      event.source,
    )
    const allowList = connection?.credentials?.[TRACKER_WEBHOOK_REPLY_ALLOW_KEY] ?? ''
    if (!isAllowedReplyAuthor(event.author, allowList)) {
      // The one path that leaves NO other trace, so it must leave a log line.
      this.log.warn('tracker reply ignored: author not allowed', {
        workspaceId,
        source: event.source,
        externalId: event.externalId,
        author: event.author.handle,
        bot: event.author.bot,
      })
      return { kind: 'ignored', reason: 'author_not_allowed' }
    }

    const issue = await this.deps.taskRepository.get(workspaceId, event.source, event.externalId)
    const blockId = issue?.linkedBlockId
    if (!blockId) return { kind: 'ignored', reason: 'issue_not_linked' }

    const review = await gateway.getForBlock(workspaceId, blockId)
    if (!review) return { kind: 'ignored', reason: 'no_review' }

    // Claim BEFORE applying: a crash between applying an answer and writing the marker must not
    // re-answer on the next delivery. A `failed` marker is re-claimable so a transient failure is
    // retried; a long-abandoned `pending` one is re-claimable too, so an ingester killed mid-apply
    // does not silence that comment forever.
    //
    // A claim that ERRORS is deliberately allowed to propagate rather than being read as "someone
    // else has it". `false` means another delivery owns the ingest — a fact this one can act on —
    // whereas a store failure means NOTHING is known and nothing was written: reporting it as
    // already-ingested would ack the delivery, drop the reporter's answer, and leave no trace, all
    // while looking like a successful dedup. Letting it throw hands the delivery back to the retry
    // machinery the whole claim exists to make safe.
    const at = this.now()
    const key = {
      workspaceId,
      source: event.source,
      externalId: event.externalId,
      commentId: event.commentId,
    }
    const claimed = await markers.claim(key, {
      now: at,
      reclaimPendingBefore: at - TRACKER_COMMENT_INGEST_CLAIM_TTL_MS,
    })
    if (!claimed) return { kind: 'ignored', reason: 'already_ingested' }

    try {
      const ack = await this.applyCommands(workspaceId, blockId, review, commands, gateway)
      await markers.settle(key, { status: 'applied' }, this.now())
      // Commit the state, THEN talk to the tracker: a failed ack must never look like a failed
      // reply, and the answer is already durable by the time this runs.
      const writeback = this.deps.issueWriteback
      if (writeback) {
        await runBestEffort(
          this.log,
          'writeback.postReviewReplyAck',
          () =>
            writeback.postReviewReplyAck(
              workspaceId,
              { source: event.source, externalId: event.externalId },
              ack,
            ),
          { workspaceId, blockId, source: event.source, externalId: event.externalId },
        )
      }
      return { kind: 'reply', outcome: ack.outcome }
    } catch (error) {
      const raw = getErrorMessage(error)
      const scrubbed = (redactSecrets(raw) ?? '').slice(0, 500)
      // The apply already threw; a failed marker settle on top leaves the claim `pending` until
      // its TTL reclaims it, so the delivery still self-heals — but nothing else would say the
      // marker store is the second thing that is broken.
      await runBestEffort(
        this.log,
        'trackerCommentIngest.settleFailed',
        () => markers.settle(key, { status: 'failed', error: scrubbed }, this.now()),
        { workspaceId, source: event.source, externalId: event.externalId },
      )
      throw error
    }
  }

  /**
   * Apply a comment's commands to a live review, in the order written, and describe what happened.
   *
   * A review that has already SETTLED (`incorporated`) applies nothing — the run is no longer
   * waiting on these questions — but still produces an ack, because a reporter who answered in
   * good faith deserves to learn the questions moved on rather than watch their reply vanish.
   */
  private async applyCommands(
    workspaceId: string,
    blockId: string,
    review: RequirementReview,
    commands: ReviewReplyCommand[],
    gateway: ReviewReplyGateway,
  ): Promise<ReviewReplyAck> {
    const runId = (await this.deps.resolveRunId?.(workspaceId, blockId)) ?? ''
    if (review.status === 'incorporated') {
      return {
        reviewId: review.id,
        runId,
        outcome: 'settled',
        answered: [],
        dismissed: [],
        outstanding: [],
        rejected: [],
      }
    }

    const byId = new Map(review.items.map((item) => [item.id, item]))
    const answered: string[] = []
    const dismissed: string[] = []
    const rejected: ReviewReplyRejection[] = []
    let control: ResolveRequirementsExceededChoice | 'proceed-now' | null = null
    let current = review

    for (const command of commands) {
      switch (command.verb) {
        case 'answer': {
          if (!byId.has(command.itemId)) {
            rejected.push({ command: command.line, reason: `no finding \`${command.itemId}\`` })
            break
          }
          const reply = (redactSecrets(command.text) ?? '').trim().slice(0, MAX_REPLY_CHARS)
          if (!reply) {
            rejected.push({ command: command.line, reason: 'the answer was empty' })
            break
          }
          current = await gateway.replyToItem(workspaceId, current.id, command.itemId, reply)
          answered.push(command.itemId)
          break
        }
        case 'dismiss': {
          if (!byId.has(command.itemId)) {
            rejected.push({ command: command.line, reason: `no finding \`${command.itemId}\`` })
            break
          }
          current = await gateway.setItemStatus(
            workspaceId,
            current.id,
            command.itemId,
            'dismissed',
          )
          dismissed.push(command.itemId)
          break
        }
        case 'proceed':
          // `proceed` is meaningful in BOTH states — at the cap it is one of the three choices, and
          // outside it, it is the ordinary "settle and advance" the SPA offers — so it is the one
          // control verb that never needs the cap. `stop` / `extra-round` only exist at the cap.
          control = current.status === 'exceeded' ? 'proceed' : 'proceed-now'
          break
        case 'stop':
        case 'extra-round':
          if (current.status !== 'exceeded') {
            rejected.push({
              command: command.line,
              reason: 'only available once the review has used its full iteration budget',
            })
            break
          }
          control = command.verb === 'stop' ? 'stop-reset' : 'extra-round'
          break
        case 'unknown':
          rejected.push({
            command: command.line,
            reason: 'unrecognised command (try `answer <id> …`, `dismiss <id>`, or `proceed`)',
          })
          break
      }
    }

    if (control) {
      current =
        control === 'proceed-now'
          ? await gateway.proceed(workspaceId, blockId)
          : await gateway.resolveExceeded(workspaceId, blockId, control)
      return {
        reviewId: current.id,
        runId,
        outcome: 'resolved',
        answered,
        dismissed,
        outstanding: [],
        rejected,
      }
    }

    const outstanding = current.items.filter((item) => item.status === 'open')
    // Nothing left open ⇒ fold the answers in and let the durable driver re-review, exactly as the
    // SPA's incorporate does. This is the D6 default that makes the ticket a complete surface: a
    // reporter who answered everything should not also have to know to press a button.
    if (outstanding.length === 0 && (answered.length > 0 || dismissed.length > 0)) {
      current = await gateway.incorporate(workspaceId, blockId)
      return {
        reviewId: current.id,
        runId,
        outcome: 'incorporating',
        answered,
        dismissed,
        outstanding: [],
        rejected,
      }
    }

    return {
      reviewId: current.id,
      runId,
      outcome: current.status === 'exceeded' ? 'exceeded' : 'awaiting',
      answered,
      dismissed,
      outstanding: outstanding.map(toFinding),
      rejected,
    }
  }

  private now(): number {
    return (this.deps.clock ?? Date).now()
  }
}

/** Project a live review item onto the finding shape the ack renders (ids verbatim, prose capped). */
function toFinding(item: RequirementReviewItem): ReviewQuestionFinding {
  return { id: item.id, title: item.title, detail: item.detail }
}
