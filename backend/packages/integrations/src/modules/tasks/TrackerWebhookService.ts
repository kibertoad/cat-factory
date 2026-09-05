import { reviewAwaitsHuman } from '@cat-factory/contracts'
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
  REVIEW_QUESTION_POLICIES,
  type ReviewQuestionFinding,
  type ReviewQuestionSubject,
  type ReviewReplyAck,
  type ReviewReplyRejection,
  type TaskConnectionStore,
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
//  - A COMMENT event on an issue linked to a block with a parked review (requirements OR the
//    bug-triage clarity gate) may answer that review's findings by their stable ids. Every
//    mutation routes through the SAME service methods the SPA and `PublicDecisionController`
//    call, so the park's CAS/approval-id arbitration and the task's preset knobs apply
//    identically. There is NEVER a parallel mutation path into the engine.
//
// Everything is best-effort and degrades to a no-op: an unwired dependency, an unlinked issue, a
// settled review or a comment with no commands all resolve to an ignored outcome rather than an
// error, because the caller is a webhook consumer whose only lever is retry — and retrying a
// delivery we will never act on just makes the tracker redeliver it.

/**
 * A live review, narrowed to what a ticket reply reads off it.
 *
 * The two subjects persist the same item shape and the same lifecycle and differ only in the
 * DOCUMENT each converges on, which a reply never touches — so one structural type covers both
 * rather than a union the apply loop would have to narrow on every branch.
 */
interface ReplyableReview {
  id: string
  status: RequirementReview['status']
  items: RequirementReviewItem[]
}

/**
 * One review subject's surface, narrowed to what a ticket reply drives.
 *
 * Declared structurally rather than imported: `@cat-factory/orchestration` depends on this
 * package, so naming its types here would invert the layering. The composition root binds these
 * to the review's own service + `executionService.{requirements,clarity}Review` — the very
 * methods the SPA controller calls — which is what makes "no parallel mutation path" true by
 * construction rather than by discipline.
 */
export interface ReviewReplyGateway {
  /** The block's live review, or null when it has none. */
  getForBlock(workspaceId: string, blockId: string): Promise<ReplyableReview | null>
  /** Record a human answer against one finding. */
  replyToItem(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    reply: string,
  ): Promise<ReplyableReview>
  /** Set a finding's status (dismiss / reopen). */
  setItemStatus(
    workspaceId: string,
    reviewId: string,
    itemId: string,
    status: ReviewItemStatus,
  ): Promise<ReplyableReview>
  /** Fold the recorded answers in and re-review — the async path the durable driver runs. */
  incorporate(workspaceId: string, blockId: string, feedback?: string): Promise<ReplyableReview>
  /** Settle the review with the last incorporated document and advance the parked run. */
  proceed(workspaceId: string, blockId: string): Promise<ReplyableReview>
  /** Resolve a review that hit its iteration cap. */
  resolveExceeded(
    workspaceId: string,
    blockId: string,
    choice: ResolveRequirementsExceededChoice,
  ): Promise<ReplyableReview>
}

/** The review a comment resolved to, with the surface that drives it. */
interface ReplyTarget {
  subject: ReviewQuestionSubject
  gateway: ReviewReplyGateway
  review: ReplyableReview
  /**
   * Finding ids that are real but belong to one of the block's OTHER live reviews.
   *
   * Carried from the resolution (which held every candidate) so the apply loop can tell
   * "there is no such finding" from "that finding is in the other loop on this ticket". Both are
   * rejections, but only the second has a remedy the reporter can act on, and a comment answering
   * both reviews at once is the ordinary way to produce one: they are reading a single ticket
   * carrying both sets of ids.
   */
  foreignItemIds: ReadonlySet<string>
}

/**
 * The order candidate reviews are considered in when a comment names no finding id.
 *
 * Derived from the policy table rather than written out, so a subject added there is considered
 * here too instead of being silently unreachable from a ticket.
 */
const REPLY_SUBJECTS = Object.keys(REVIEW_QUESTION_POLICIES) as ReviewQuestionSubject[]

/** The finding ids a comment's commands name, across every id-addressed verb. */
function namedItemIds(commands: readonly ReviewReplyCommand[]): ReadonlySet<string> {
  return new Set(
    commands.flatMap((command) =>
      command.verb === 'answer' || command.verb === 'dismiss' ? [command.itemId] : [],
    ),
  )
}

export interface TrackerWebhookServiceDependencies {
  taskRepository: TaskRepository
  taskConnectionStore: TaskConnectionStore
  /**
   * Fire every recurring schedule whose intake configuration this issue event qualifies for,
   * returning how many fired. Bound to `RecurringPipelineService.triggerForIssueEvent`. Absent ⇒
   * push-driven intake is off and the polling schedule alone covers it (which is the pre-existing
   * behaviour, so an unwired facade is byte-for-byte unchanged).
   */
  triggerIntake?: (workspaceId: string, event: TrackerIssueEvent) => Promise<number>
  /**
   * The review surfaces a ticket reply may drive, per subject. An empty/absent map ⇒ replies are
   * ignored; a partially-wired one drives only what it holds, which is the same branch-by-branch
   * degradation every other collaborator here gets.
   */
  reviewGateways?: Partial<Record<ReviewQuestionSubject, ReviewReplyGateway>>
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
    const gateways = this.deps.reviewGateways
    const markers = this.deps.commentIngestRepository
    if (!gateways || !markers || REPLY_SUBJECTS.every((s) => !gateways[s])) {
      return { kind: 'ignored', reason: 'replies_not_wired' }
    }

    // Our OWN comments, refused structurally before anything else. The author-side bot check below
    // catches them on GitHub and Jira, but Linear flags no bots and the default allow-list admits
    // any author — so on Linear an acknowledgement is an allowed author commenting on an issue we
    // are linked to, and an ack that could re-enter its own ingest is an unbounded comment loop
    // rather than a duplicate (each ack carries a fresh comment id, so the claim cannot stop it).
    // Cheap, vendor-independent, and it holds whatever a future renderer writes.
    if (isPlatformAuthoredComment(event.body)) return { kind: 'ignored', reason: 'self_authored' }

    const commands = parseReviewReplyCommands(event.body)
    if (commands.length === 0) return { kind: 'ignored', reason: 'no_commands' }

    const connection = await this.deps.taskConnectionStore.getByWorkspace(workspaceId, event.source)
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

    const target = await this.resolveReview(workspaceId, blockId, commands, gateways)
    if (!target) return { kind: 'ignored', reason: 'no_review' }

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
      const ack = await this.applyCommands(workspaceId, blockId, target, commands)
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
   * Which of the block's reviews this comment is answering.
   *
   * A block can hold a live review of more than one subject (a task re-run under a different
   * pipeline leaves the earlier one behind), and both were posted onto the same issue with their
   * own ids, so the comment itself is the only thing that says which loop the reporter is in.
   * Three tie-breaks, most specific first:
   *
   *  1. **A named finding id decides it.** The ids are platform-minted and unique across both
   *     stores, so a comment that names one is unambiguous no matter how many reviews are live.
   *     A comment naming ids from BOTH reviews still resolves to one of them, and `applyCommands`
   *     then rejects the other's ids as belonging to another review — reported in the ack rather
   *     than dropped, because "that id is real, just not in the loop you are answering" is the one
   *     rejection a reporter can act on.
   *  2. **Otherwise the review PARKED ON A HUMAN decides it** (`reviewAwaitsHuman`). A bare
   *     `proceed` is about the loop that stopped the run, which is the one holding a human's
   *     answer and not merely the one that has not settled: `incorporating` / `reviewing` are the
   *     driver's own transients, and picking one of those over a review sitting at `exceeded`
   *     would drive the wrong loop with the reporter's verb.
   *  3. **Otherwise the declaration order.** Reached only by a control verb sent to a block whose
   *     every review is settled or mid-cycle, where the ack says what it did (`settled`, or the
   *     current state) whichever one is picked, so the choice cannot mislead.
   *
   * Deliberately NO special case for a single candidate. Tie-break 1 already answers the one-review
   * case correctly (there is nothing to break a tie between), so a `length <= 1` short-circuit
   * would only create a second path that could answer differently from the general one.
   *
   * Reads every wired subject's store in parallel: they are independent point lookups on a path
   * that has already established the comment carries commands.
   */
  private async resolveReview(
    workspaceId: string,
    blockId: string,
    commands: ReviewReplyCommand[],
    gateways: Partial<Record<ReviewQuestionSubject, ReviewReplyGateway>>,
  ): Promise<ReplyTarget | null> {
    type Candidate = Omit<ReplyTarget, 'foreignItemIds'>
    const candidates = (
      await Promise.all(
        REPLY_SUBJECTS.map(async (subject) => {
          const gateway = gateways[subject]
          if (!gateway) return null
          const review = await gateway.getForBlock(workspaceId, blockId)
          return review ? { subject, gateway, review } : null
        }),
      )
    ).filter((candidate): candidate is Candidate => candidate !== null)

    const named = namedItemIds(commands)
    const chosen =
      candidates.find((c) => c.review.items.some((item) => named.has(item.id))) ??
      candidates.find((c) => reviewAwaitsHuman(c.review.status)) ??
      candidates[0]
    if (!chosen) return null
    return {
      ...chosen,
      foreignItemIds: new Set(
        candidates
          .filter((c) => c !== chosen)
          .flatMap((c) => c.review.items.map((item) => item.id)),
      ),
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
    target: ReplyTarget,
    commands: ReviewReplyCommand[],
  ): Promise<ReviewReplyAck> {
    const { subject, gateway, review, foreignItemIds } = target
    const runId = (await this.deps.resolveRunId?.(workspaceId, blockId)) ?? ''
    if (review.status === 'incorporated') {
      return {
        subject,
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
    /**
     * Why an id-addressed command found no finding. A ticket can carry the question comments of
     * BOTH live reviews, so an id that is real but in the other loop is the likely mistake, and it
     * has a remedy: a separate comment naming only that review's ids resolves to that review.
     * Reporting it as "no finding" would tell a reporter an id they can see is not real.
     */
    const missingReason = (itemId: string): string =>
      foreignItemIds.has(itemId)
        ? `finding \`${itemId}\` belongs to the other review on this ticket — answer it in a ` +
          'separate comment naming only its findings'
        : `no finding \`${itemId}\``
    const answered: string[] = []
    const dismissed: string[] = []
    const rejected: ReviewReplyRejection[] = []
    let control: ResolveRequirementsExceededChoice | 'proceed-now' | null = null
    let current = review

    for (const command of commands) {
      switch (command.verb) {
        case 'answer': {
          if (!byId.has(command.itemId)) {
            rejected.push({ command: command.line, reason: missingReason(command.itemId) })
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
            rejected.push({ command: command.line, reason: missingReason(command.itemId) })
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
        subject,
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
        subject,
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
      subject,
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
