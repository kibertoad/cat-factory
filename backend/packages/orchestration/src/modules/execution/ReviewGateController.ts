import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  ExecutionRepository,
  IssueWritebackProvider,
  Logger,
  PipelineStep,
  RequestRecommendationItem,
  RequirementConcernLevel,
  RequirementRecommendation,
  ResolveRequirementsExceededChoice,
  ReviewQuestionSubject,
  RunAutonomy,
  WorkRunner,
} from '@cat-factory/kernel'
import { assertFound, ConflictError, ValidationError } from '@cat-factory/kernel'
import {
  DEFAULT_MIN_AUTO_ANSWER_CONFIDENCE,
  reviewSettledForUnattended,
} from '@cat-factory/contracts'
import { hasNotesToIncorporate } from '../requirements/requirements.logic.js'
import type { ReviewCommon } from '../review/IterativeReviewService.js'
import type { AdvanceResult } from './advance.js'
import {
  buildReviewQuestionPost,
  shouldPostReviewQuestions,
} from './reviewQuestionWriteback.logic.js'
import type { RunStateMachine } from './RunStateMachine.js'
import { resolvesOwnCaps, type RunPolicyScope } from './policy-types.js'
import type { StepGraph } from './StepGraph.js'

/**
 * A review as `reviewSettledForUnattended` reads it: the findings, plus the Writer recommendations
 * where the kind has any.
 *
 * The one cast in this file, and it is a read of a field the GENERIC type cannot promise: only the
 * requirements review carries recommendations, and the clarity gate deliberately has no Writer at
 * all. Absent reads as none, which is the answer that keeps a reporter's unanswered question
 * parking the run (see the predicate's own note).
 */
function unattendedReviewView(
  review: ReviewCommon,
): Parameters<typeof reviewSettledForUnattended>[0] {
  const held = (review as { recommendations?: unknown }).recommendations
  return {
    items: review.items,
    ...(Array.isArray(held) ? { recommendations: held as RequirementRecommendation[] } : {}),
  }
}

/**
 * The merge-preset knobs an iterative review consults: how many reviewer passes it
 * may run and the severity it tolerates before it must raise a finding for a human.
 * A structural subset of the full merge preset, so {@link ReviewGateControllerDeps.resolveRiskPolicy}
 * can return the whole preset unchanged.
 */
export interface ReviewPreset {
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  /**
   * Whether the run may proceed on its own when the loop exhausts `maxRequirementIterations`.
   * Optional for the reason it is optional on `ResolvedRunRiskPolicy`: a test preset that gates on
   * nothing else should not have to state a posture, and absent reads as `attended`.
   */
  autonomy?: RunAutonomy
  /**
   * The confidence floor a Writer suggestion must report for an `unattended` run to fold it in as a
   * finding's answer instead of parking. Optional for the reason `autonomy` is, and absent reads as
   * the shipped default rather than `0`: an unstated floor is not a licence to accept an answer the
   * model never graded.
   */
  minAutoAnswerConfidence?: number
}

/**
 * One review subject (requirements vs clarity) expressed as the operations the gate flow
 * drives, so the control flow below is written exactly once. Each kind closes over its own
 * {@link IterativeReviewService} subclass instance (and, for clarity, the per-run
 * investigation lookup) and over the live event publisher — the controller never branches
 * on which kind it is handling.
 *
 * @typeParam TReview the persisted review type (requirements or clarity), both `ReviewCommon`.
 */
export interface ReviewKind<TReview extends ReviewCommon> {
  /** The pipeline-step `agentKind` this gate runs as (e.g. `requirements-review`). */
  readonly agentKind: string
  /** Label for `assertFound` when a block has no current review (e.g. `Requirement review`). */
  readonly entityName: string
  /** Whether the LLM-backed reviewer is wired (pass-through when false). */
  enabled(): boolean
  /** The block's current review, or null. Throws if the reviewer is not configured. */
  getForBlock(workspaceId: string, blockId: string): Promise<TReview | null>
  /** Run a fresh reviewer pass with the task's preset knobs (and any per-kind context). */
  review(workspaceId: string, block: Block, preset: ReviewPreset): Promise<TReview>
  /** Re-review the incorporated document (one more pass). */
  reReview(workspaceId: string, reviewId: string, preset: ReviewPreset): Promise<TReview>
  /** Fold the human's settled answers (+ any redo feedback) into the standardized document. */
  incorporate(
    workspaceId: string,
    blockId: string,
    reviewId: string,
    feedback: string | undefined,
  ): Promise<void>
  markIncorporated(workspaceId: string, reviewId: string): Promise<TReview>
  markReReviewing(workspaceId: string, reviewId: string): Promise<TReview>
  markIncorporating(workspaceId: string, reviewId: string): Promise<TReview>
  grantExtraRound(workspaceId: string, reviewId: string): Promise<TReview>
  /**
   * Requirements-only (the Requirement Writer): append `pending` placeholder recommendations
   * for a batch of findings so the SPA shows "generating…" at once. Each item carries its finding
   * id plus optional per-finding guidance (the note the human typed before choosing "recommend").
   * The slow Writer runs later via {@link fillRecommendations}. Optional — absent on the clarity
   * kind (no Writer).
   */
  prepareRecommendations?(
    workspaceId: string,
    reviewId: string,
    items: RequestRecommendationItem[],
  ): Promise<TReview>
  /** Requirements-only: reset a settled recommendation back to `pending` for a re-request. Optional. */
  markRecommendationPending?(
    workspaceId: string,
    reviewId: string,
    recId: string,
    note: string,
  ): Promise<TReview>
  /**
   * Requirements-only: run the Writer over the review's `pending` placeholders — filling them in
   * one by one (emitting progress per finding) and notifying when the batch finishes. Returns the
   * final review. Runs in the durable driver (see {@link ReviewGateController.evaluate} re-entry),
   * or inline off-path. Optional.
   */
  fillRecommendations?(workspaceId: string, blockId: string): Promise<TReview>
  /**
   * Requirements-only (the auto-recommendation automation): for the block's current review,
   * auto-generate + auto-accept recommendations for every OPEN finding the reviewer flagged
   * answerable without a product owner. A no-op when nothing qualifies. Runs inline in the
   * durable driver right after a reviewer pass raises findings. Optional — absent on the
   * clarity kind (no Writer). See {@link RequirementReviewService.autoRecommend}.
   */
  autoRecommend?(workspaceId: string, blockId: string): Promise<void>
  /** Push a live review-changed event so an open window/inspector reflects the new status. */
  emit(workspaceId: string, review: TReview): Promise<void>
  /**
   * Which review this kind's parks echo onto the block's linked tracker issue(s) as, or absent
   * when a park of this kind echoes nothing.
   *
   * The subject is what picks the audience and the opt-in gating (`REVIEW_QUESTION_POLICIES`),
   * so the two loops that DO echo share this one call path: the clarity gate used to post its
   * questions from its own `review()` closure as bare strings, which rendered no finding ids and
   * was therefore unanswerable from the ticket it landed on. Absent on the brainstorm kinds: a
   * dialogue converges on a direction rather than answering a reporter's filing, and its block
   * has no issue whose author asked for it.
   */
  readonly questionsOnPark?: ReviewQuestionSubject
}

/**
 * What the review gates need beyond the shared run state-machine spine. The spine primitives
 * the gate flow drives (park / advance-past-resolved / finalize / persist / emit / progress /
 * start-finish a step) now come from the cohesive {@link RunStateMachine} + {@link StepGraph}
 * collaborators instead of a per-callback bag, so this is just the gate's own data access plus
 * the two genuinely gate-flow operations (`resolveRiskPolicy`, `dispatchIterationCap`).
 */
export interface ReviewGateControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  /** The async instance/block spine (park/advance/finalize/persist/emit/progress/notify). */
  stateMachine: RunStateMachine
  /** The pure step mutators (start/finish a step). */
  stepGraph: StepGraph
  /**
   * Issue-tracker writeback, used here for ONE thing: echoing a parked HEADLESS review's open
   * findings onto the block's linked issue(s) so a caller with no in-app surface learns what
   * the run is waiting for. Absent (tests, no tracker) → parks behave exactly as before.
   */
  issueWriteback?: IssueWritebackProvider
  /** Structured logger for the best-effort writeback above. Absent → failures are silent. */
  logger?: Logger
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
    run: RunPolicyScope,
  ) => Promise<ReviewPreset>
  dispatchIterationCap: (
    workspaceId: string,
    blockId: string,
    choice: ResolveRequirementsExceededChoice,
    handlers: { extraRound: () => Promise<unknown>; proceed: () => Promise<unknown> },
  ) => Promise<void>
}

/**
 * Drives the two iterative review gates — `requirements-review` and `clarity-review` — which
 * share the SAME control flow: an inline reviewer LLM raises findings, the run parks on a
 * durable decision-wait, a human answers/dismisses through the dedicated window, an
 * incorporation pass folds the answers into one standardized document, and the reviewer
 * re-reviews it until it converges (or the iteration budget runs out). Only the subject and
 * the persisted document differ; everything structural is shared, so each method below takes
 * a {@link ReviewKind} and is written exactly once. Extracted out of `ExecutionService`; the
 * shared step-graph primitives it calls (the parking gate, the resolved-gate advance, the
 * iteration-cap dispatch, the block/instance writes) stay on the engine and are injected via
 * {@link ReviewGateControllerDeps}.
 */
export class ReviewGateController {
  constructor(private readonly deps: ReviewGateControllerDeps) {}

  /**
   * The run scope a policy resolution here runs under.
   *
   * Every entry point on this controller is reachable two ways: from the pipeline gate, which
   * already holds the run, and from the off-path inspector surfaces, which are handed a BLOCK id
   * by an HTTP request. `known` is the first case and costs nothing; the second reads the block's
   * live run, because the review's iteration budget must come from the same policy the run itself
   * is governed by, and an off-path "run review" on an API-started task is still that task's run.
   *
   * A block with no live run at all degrades to `undefined`, which
   * {@link runDefaultScopeFor} reads as interactive: there is no unattended run to speak
   * for, and somebody is making this request right now.
   */
  private async runScope(
    workspaceId: string,
    blockId: string,
    known?: RunPolicyScope,
  ): Promise<RunPolicyScope> {
    if (known) return known
    const run = await this.deps.executionRepository.getByBlock(workspaceId, blockId)
    return { intakeOrigin: run?.intakeOrigin }
  }

  /**
   * Run a review gate step. When the reviewer isn't wired the step passes through (pipelines
   * run unchanged without the feature). Otherwise it runs the initial reviewer pass: an
   * auto-pass (no findings, or all at/below the task's tolerated severity) advances
   * immediately, recording the findings; anything else parks the run for the dedicated review
   * window to drive the iterative loop. Re-entrant on incorporation: when the human answered
   * the findings and asked to incorporate, the (slow) fold + re-review LLM work runs here in
   * the durable driver instead of in the HTTP request the user is no longer waiting on.
   */
  async evaluate<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    if (!kind.enabled()) {
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }

    // The auto-recommendation automation is on by default; a pipeline step opts out via
    // `stepOptions.autoRecommend === false` (authored in the pipeline builder).
    const autoRecommendEnabled = step.stepOptions?.autoRecommend !== false

    // Re-entry: the human asked the Requirement Writer to recommend answers for a batch of
    // findings (or re-requested one). Run the Writer here in the durable driver — filling the
    // `pending` placeholders one by one (progress streams to the window) and notifying when the
    // batch finishes — then re-park. Recommendations NEVER advance the run: the human still has
    // to accept/reject them and then incorporate, so this always returns to the decision wait.
    const pendingRec = step.pendingRecommendation
    if (pendingRec && kind.fillRecommendations) {
      step.pendingRecommendation = null
      const filled = await kind.fillRecommendations(workspaceId, block.id)
      return this.park(kind, workspaceId, instance, step, block, filled)
    }

    // Re-entry: the human answered the findings and asked to incorporate. Do the (slow)
    // LLM work here in the durable driver — fold the answers into a document, then
    // re-review it — instead of in the HTTP request that the user is no longer waiting on.
    // `reReview` raises the re-summon notification itself when it finds findings.
    const pending = step.pendingIncorporation
    if (pending) {
      step.pendingIncorporation = null
      const cycled = await this.runIncorporationCycle(
        kind,
        workspaceId,
        block.id,
        pending.feedback,
        autoRecommendEnabled,
        instance,
      )
      // The same self-settling the fresh pass gets, for the same reason: a re-review can surface a
      // fresh batch of practice-level findings, and an unattended run that could settle the first
      // batch is not helped by parking on the second.
      const review =
        cycled.status === 'ready' && autoRecommendEnabled
          ? await this.settleQuestionsUnattended(
              kind,
              workspaceId,
              instance,
              step,
              block,
              autoRecommendEnabled,
            )
          : cycled
      if (review.status === 'incorporated') {
        return this.completeStep(workspaceId, instance, step, isFinalStep)
      }
      const settled = await this.settleCapUnattended(
        kind,
        workspaceId,
        instance,
        block,
        review,
        step,
      )
      if (settled) return this.completeStep(workspaceId, instance, step, isFinalStep)
      // `ready`/`exceeded`: re-park (a fresh decision id) and wait for the human again.
      // At the cap, raise a notification so the three-choice decision is discoverable.
      if (review.status === 'exceeded')
        await this.deps.stateMachine.raiseDecisionRequired(workspaceId, instance)
      return this.park(kind, workspaceId, instance, step, block, review)
    }

    // Fresh entry: run the initial reviewer pass with the task's preset knobs (shared with
    // the off-path inspector surface). Auto-pass (status `incorporated`) → advance; the
    // findings stay recorded on the review for transparency. `ready`/`exceeded` → park for
    // the dedicated window.
    const review = await this.review(kind, workspaceId, block.id, instance)
    if (review.status === 'incorporated') {
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }
    // At the cap with nobody to ask: settle on the last clarified report and advance (see
    // `settleCapUnattended`). Checked before the auto-recommendation pass below, which exists to
    // hand a HUMAN a mostly-filled review and buys an unattended run nothing.
    if (await this.settleCapUnattended(kind, workspaceId, instance, block, review, step)) {
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }
    // Pre-answer the findings the reviewer judged answerable without a product owner, so the
    // human is handed a mostly-filled review (only the genuine business decisions remain
    // blank). Best-effort — a failure here must not wedge the parked run. Skipped on `exceeded`
    // (the human is picking how to proceed, not answering findings).
    let current = review
    if (review.status === 'ready' && autoRecommendEnabled) {
      await this.maybeAutoRecommend(kind, workspaceId, block.id)
      current = await this.settleQuestionsUnattended(
        kind,
        workspaceId,
        instance,
        step,
        block,
        autoRecommendEnabled,
      )
    }
    if (current.status === 'incorporated') {
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }
    if (await this.settleCapUnattended(kind, workspaceId, instance, block, current, step)) {
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }
    if (current.status === 'exceeded')
      await this.deps.stateMachine.raiseDecisionRequired(workspaceId, instance)
    return this.park(kind, workspaceId, instance, step, block, current)
  }

  /**
   * The QUESTIONS an unattended run may answer for itself: fold in and re-review, for as long as
   * every outstanding finding is either settled by a person or is one the REVIEWER classified as
   * answerable without a product owner and the Writer graded at or above the policy's floor.
   *
   * ADR 0053 drew the line this sits on and left it where a person still had to be there: an
   * unattended policy may answer a park the AUTOMATION raised by giving up, and may never invent a
   * product judgement. The narrowing that makes this compatible with that rule rather than an
   * exception to it is that two independent judgements have to agree before anything is folded — the
   * reviewer sorted its own findings into "answerable from practice" and "needs an owner", and the
   * Writer then said how sure it is of the specific answer. A finding in the second group, or one
   * graded below the floor, holds the whole review exactly as before, and a floor of `0` is the
   * operator asking for the ungraded behaviour explicitly.
   *
   * Re-READS rather than taking the caller's snapshot, because the auto-recommendation pass that
   * runs immediately before it has just rewritten the row this decision is about. Each cycle's own
   * snapshot comes from `runIncorporationCycle`, which owes the same guarantee for the same reason.
   *
   * The loop is bounded by the review's OWN pass budget: each cycle spends one reviewer pass, and
   * `disposeReview` turns the last of them into `exceeded`, which `settleCapUnattended` then answers
   * on the same policy. Without the loop, a re-review that surfaced a fresh batch of practice-level
   * findings would park a run that had just demonstrated it could settle exactly that kind.
   */
  private async settleQuestionsUnattended<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    autoRecommendEnabled: boolean,
  ): Promise<TReview> {
    let current = await this.currentReview(kind, workspaceId, block.id)
    const preset = await this.deps.resolveRiskPolicy(workspaceId, block, instance)
    if (!resolvesOwnCaps(preset)) return current
    const floor = preset.minAutoAnswerConfidence ?? DEFAULT_MIN_AUTO_ANSWER_CONFIDENCE
    for (let cycle = 0; cycle < current.maxIterations; cycle += 1) {
      if (current.status !== 'ready') return current
      if (!reviewSettledForUnattended(unattendedReviewView(current), floor)) return current
      // Stamped BEFORE the fold, so a driver that dies mid-cycle still leaves the run saying a
      // machine answered these questions. The answers themselves are on the review, each with its
      // grade and its provenance; this is what stops the step reading like a signed-off review.
      step.autoAnsweredByPolicy = true
      this.deps.logger?.info('review questions auto-answered by policy', {
        workspaceId,
        runId: instance.id,
        blockId: block.id,
        reviewId: current.id,
        agentKind: step.agentKind,
        minConfidence: floor,
      })
      current = await this.runIncorporationCycle(
        kind,
        workspaceId,
        block.id,
        undefined,
        autoRecommendEnabled,
        instance,
      )
    }
    return current
  }

  /**
   * The ITERATION CAP under an unattended policy: the reviewer loop spent its whole pass budget
   * without converging, and there is nobody to pick among the three choices the cap offers.
   *
   * Takes `proceed`, the same disposition a person picks when they accept the last clarified
   * report as good enough, through the SAME `markIncorporated` the human path runs: this is not a
   * second way to settle a review, it is the human's own answer given by policy. The other two
   * choices are deliberately unavailable to it — "one more round" spends model calls on a loop
   * that has already demonstrated it does not converge, and "stop and reset" throws away the work
   * on a run whose whole point was to finish without supervision.
   *
   * Returns whether it settled, so the caller advances instead of parking. Only `exceeded`
   * qualifies: a `ready` review is a reviewer asking QUESTIONS, which is the consultation an
   * unattended policy never answers on a person's behalf. Settling one would mean building from
   * requirements nobody agreed to, and the step is worth nothing if it does that.
   *
   * **So this branch is RARE by construction, and that is correct rather than a bug to fix.**
   * `disposeReview` reaches `exceeded` only at `iteration >= maxIterations`, the initial pass is
   * iteration 1, and the counter advances only through human answer → incorporate → re-review
   * cycles. An unattended run therefore meets `ready` first and parks there, and reaches this at
   * all only when a run that HAD a person is later governed by an unattended policy, or when the
   * preset allows a single pass. The answer to "an unattended run should not sit on an
   * attended-heavy step" is not to settle the questions here: it is not to put the step in the
   * pipeline that unwatched runs resolve.
   */
  private async settleCapUnattended<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    review: TReview,
    step: PipelineStep,
  ): Promise<boolean> {
    if (review.status !== 'exceeded') return false
    const preset = await this.deps.resolveRiskPolicy(workspaceId, block, instance)
    if (!resolvesOwnCaps(preset)) return false
    const settled = await kind.markIncorporated(workspaceId, review.id)
    // Stamped BEFORE the caller advances, so the record lands with the step that carries it. The
    // review row itself says only `incorporated`, which is also what a person's own "proceed"
    // writes; this is the one thing that tells those apart afterwards.
    step.reviewCapSettledByPolicy = true
    await kind.emit(workspaceId, settled)
    this.deps.logger?.info('review iteration cap settled by policy', {
      workspaceId,
      runId: instance.id,
      blockId: block.id,
      reviewId: review.id,
      agentKind: step.agentKind,
      iterations: preset.maxRequirementIterations,
    })
    return true
  }

  /**
   * Park a review gate on its human decision, then best-effort echo the still-open findings
   * onto the block's linked tracker issue(s) when the kind's subject says this run qualifies.
   *
   * Every park in {@link evaluate} funnels through here so the echo cannot be forgotten by a
   * future branch, and so the requirements loop's SPA path is provably untouched:
   * {@link shouldPostReviewQuestions} refuses anything whose `intakeOrigin` is not headless for
   * a subject whose audience is `headless`.
   *
   * **The park is committed FIRST, and that ordering is load-bearing.** A run that failed to
   * park is a run that answers nobody, so it must never queue behind an outbound HTTP call to
   * a third party that may be slow, rate-limiting, or down. With the park already durable, the
   * worst a wedged tracker can do is stall this driver step — the run is answerable over the
   * API the moment the park lands, and the questions arrive when the post does. The echo's own
   * failure is logged rather than swallowed; either way the park stays discoverable in-app via
   * the `requirement_review` card the reviewer pass already raised.
   */
  private async park<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    review: TReview,
  ): Promise<AdvanceResult> {
    const parked = await this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
    await this.echoQuestionsToTracker(kind, workspaceId, instance, block, review)
    return parked
  }

  /**
   * The headless question echo. Split from {@link park} so the park's own control flow stays a
   * single line and this stays entirely best-effort: nothing it does can change the parked
   * result it runs behind.
   */
  private async echoQuestionsToTracker<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    review: TReview,
  ): Promise<void> {
    const writeback = this.deps.issueWriteback
    const subject = kind.questionsOnPark
    // The subject first: it is a free in-memory check, and for a `headless`-audience subject the
    // intake check behind it is the scope boundary of the whole feature, so a UI-started
    // requirements run pays nothing at all for the re-read below.
    if (!writeback || !subject || !shouldPostReviewQuestions(instance, review, subject)) return
    // Re-read the review: an auto-recommendation pass may have answered findings since `review`
    // was taken, and the echo must ask only what is still genuinely open. Deliberately
    // UNCONDITIONAL rather than flagged from the one call site that mutates today — a future
    // branch that adds another mutation would silently start asking already-answered questions,
    // and the cost is one indexed read on a path that is about to wait on a human for hours.
    const fresh = (await kind.getForBlock(workspaceId, block.id).catch(() => null)) ?? review
    if (!shouldPostReviewQuestions(instance, fresh, subject)) return
    try {
      const outcome = await writeback.postReviewQuestions(
        workspaceId,
        block,
        buildReviewQuestionPost(instance, fresh, subject),
      )
      if (outcome.failed > 0) {
        this.deps.logger?.warn('review question writeback failed for some linked issues', {
          workspaceId,
          runId: instance.id,
          reviewId: fresh.id,
          ...outcome,
        })
      }
    } catch (e) {
      this.deps.logger?.warn('review question writeback threw', {
        workspaceId,
        runId: instance.id,
        reviewId: fresh.id,
        err: String(e),
      })
    }
  }

  /**
   * Fold the human's settled answers into a standardized document and re-review it (one
   * iteration of the loop), emitting the live review-changed event after each phase so an
   * open window/inspector tracks progress. Runs inside the durable driver (see
   * {@link evaluate} re-entry); shared by the no-run inline fallback in {@link incorporate}.
   * Returns the re-reviewed review.
   */
  private async runIncorporationCycle<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
    feedback?: string,
    autoRecommendEnabled = true,
    run?: RunPolicyScope,
  ): Promise<TReview> {
    const review = await this.currentReview(kind, workspaceId, blockId)
    // Nothing to fold in (every finding dismissed, no answered replies, no redo
    // feedback) → the requirements stand as-is. Skip the rework + re-review LLM calls
    // and settle the review directly. `markIncorporated` preserves any
    // incorporated document from an earlier iteration, so downstream consumes that
    // prior doc when one exists, else falls back to the original description (nothing
    // was clarified). Mirrors a polling gate's precheck skip.
    if (!hasNotesToIncorporate(review.items, feedback)) {
      const settled = await kind.markIncorporated(workspaceId, review.id)
      await kind.emit(workspaceId, settled)
      return settled
    }
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const preset = await this.deps.resolveRiskPolicy(
      workspaceId,
      block,
      await this.runScope(workspaceId, blockId, run),
    )
    await kind.incorporate(workspaceId, blockId, review.id, feedback)
    // The fold is done; flag the SECOND stage (`reviewing`) so the board/window can show
    // "re-reviewing" distinctly from "incorporating" — either of the two LLM calls can be
    // the slow one, so the human needs to know which is currently running.
    const reReviewing = await kind.markReReviewing(workspaceId, review.id)
    await kind.emit(workspaceId, reReviewing)
    const reviewed = await kind.reReview(workspaceId, review.id, preset)
    await kind.emit(workspaceId, reviewed)
    // A re-review can surface fresh findings; pre-answer the auto-answerable ones just like the
    // first pass, so the human only ever hand-answers the genuine business decisions.
    //
    // Re-READ when that pass ran, because it rewrote the very row this returns: `reviewed` was
    // snapshotted before it, so it shows the fresh findings still OPEN and carrying no grades.
    // Handing that back reads as "nothing was auto-answerable this round" to every caller, and the
    // unattended settle loop, whose whole job is to fold a SECOND batch of practice-level findings,
    // would park on the batch it had just answered.
    if (reviewed.status === 'ready' && autoRecommendEnabled) {
      if (await this.maybeAutoRecommend(kind, workspaceId, blockId)) {
        return this.currentReview(kind, workspaceId, blockId)
      }
    }
    return reviewed
  }

  /**
   * Run the auto-recommendation automation for a block's review when the kind supports it
   * (requirements only). Best-effort: the recommendations are a convenience, so a Writer
   * failure must never wedge the parked run — it just leaves those findings blank for the
   * human. The service already emits live progress per chunk. Returns `true` when the kind
   * supports the automation (so the caller knows the persisted review may have changed after
   * the passed-in snapshot was taken), `false` when it is a no-op (unsupported kind).
   */
  private async maybeAutoRecommend<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
  ): Promise<boolean> {
    if (!kind.autoRecommend) return false
    try {
      await kind.autoRecommend(workspaceId, blockId)
    } catch {
      // Best-effort: the review + its findings are already persisted and returned.
    }
    return true
  }

  /** Finish a review gate step and advance to the next step (or finish the run). */
  private async completeStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    this.deps.stateMachine.finishHumanGateStep(step)
    return this.deps.stateMachine.settleStepAndAdvance(workspaceId, instance, isFinalStep)
  }

  /** Resolve a block's current review or throw. */
  private async currentReview<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
  ): Promise<TReview> {
    return assertFound(await kind.getForBlock(workspaceId, blockId), kind.entityName, blockId)
  }

  /**
   * Run a fresh reviewer pass over a block, snapshotting the task's merge-preset knobs
   * (iteration budget + tolerated severity) onto the review. Shared by the pipeline gate
   * ({@link evaluate}) and the off-path inspector "Run review" surface, so both honour the
   * task's preset identically.
   */
  async review<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
    run?: RunPolicyScope,
  ): Promise<TReview> {
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const preset = await this.deps.resolveRiskPolicy(
      workspaceId,
      block,
      await this.runScope(workspaceId, blockId, run),
    )
    return kind.review(workspaceId, block, preset)
  }

  /**
   * Incorporate the human's settled answers ASYNCHRONOUSLY. Validates that every finding is
   * answered/dismissed (so the user gets immediate feedback if not), flags the review
   * `incorporating`, records the intent on the parked gate step, and signals the durable
   * driver to wake — which folds the answers and re-reviews in the background (see
   * {@link evaluate} re-entry). Returns at once with the `incorporating` review so the SPA
   * can return the user to the board; they are summoned again only if the re-review yields
   * findings (`ready`) or hits the cap (`exceeded`).
   *
   * No parked run (an off-path inspector review with no active pipeline) → there is no driver
   * to offload to, so the fold + re-review run inline here. That path never had the
   * pipeline-gate freeze this method exists to remove.
   */
  async incorporate<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
    feedback?: string,
  ): Promise<TReview> {
    const review = await this.currentReview(kind, workspaceId, blockId)
    const open = review.items.filter((i) => i.status === 'open')
    if (open.length > 0) {
      throw new ValidationError(
        `Answer or dismiss all ${open.length} remaining item(s) before incorporating`,
      )
    }

    const parked = await this.findParkedStep(kind, workspaceId, blockId)
    if (!parked) {
      // Off-path: no pipeline parked on this review. Do the work inline (it cannot be
      // offloaded to a driver that isn't running) and return the re-reviewed result.
      return this.runIncorporationCycle(kind, workspaceId, blockId, feedback)
    }

    // Record the intent + re-arm the run under OPTIMISTIC CONCURRENCY (race-audit 2.2
    // controller-half): a blind full-row upsert here would clobber a concurrent driver poll
    // (or a second human action) that moved the row. Re-arm BEFORE signalling the driver: the
    // park left it `blocked`, but `advanceInstance` no-ops unless the run is `running`/`paused`,
    // so a woken driver would otherwise return `noop` WITHOUT running the re-entrant incorporate
    // + re-review cycle — leaving the review stuck `incorporating`. The signal + emit run once
    // after, on the winning snapshot.
    let approvalId = ''
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      parked.instance.id,
      (inst) => {
        const step = inst.steps.find(
          (s) =>
            s.agentKind === kind.agentKind &&
            s.state === 'waiting_decision' &&
            s.approval?.status === 'pending',
        )
        if (!step?.approval) {
          throw new ConflictError('The review is no longer awaiting incorporation')
        }
        step.pendingIncorporation = feedback ? { feedback } : {}
        if (inst.status === 'blocked') inst.status = 'running'
        approvalId = step.approval.id
      },
    )
    // Flag the review `incorporating` only AFTER the CAS has won — a review-row write done ONCE,
    // after the retry loop, so a re-applied `mutateInstance` callback can't double-write it AND a
    // contended give-up (the gate advanced away → the `ConflictError` above) never leaves the
    // review orphaned in `incorporating` with no driver left to progress it.
    const updated = await kind.markIncorporating(workspaceId, review.id)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await kind.emit(workspaceId, updated)
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'incorporate')
    return updated
  }

  /**
   * Request a batch of Requirement-Writer recommendations ASYNCHRONOUSLY. Appends `pending`
   * placeholder recommendations at once (so the SPA shows "generating…" and the human is handed
   * back to the board), then signals the durable driver to run the Writer per finding in the
   * background (see {@link evaluate} re-entry) — filling the placeholders and notifying when done.
   * Off-path (no parked run) the Writer runs inline. Returns the review with the placeholders.
   */
  async requestRecommendations<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
    items: RequestRecommendationItem[],
  ): Promise<TReview> {
    if (!kind.prepareRecommendations || !kind.fillRecommendations) {
      throw new ConflictError('Recommendations are not supported for this review')
    }
    const current = await this.currentReview(kind, workspaceId, blockId)
    const prepared = await kind.prepareRecommendations(workspaceId, current.id, items)
    await kind.emit(workspaceId, prepared)
    return this.scheduleRecommendation(
      kind,
      workspaceId,
      blockId,
      items.map((i) => i.itemId),
      undefined,
      prepared,
    )
  }

  /**
   * Re-request a single recommendation with a "do it differently" note: resets it to `pending`
   * and drives the Writer through the SAME async path as a fresh batch. Review-scoped (the
   * re-request endpoint addresses the recommendation by review + id).
   */
  async reRequestRecommendation<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    reviewId: string,
    recId: string,
    note: string,
  ): Promise<TReview> {
    if (!kind.markRecommendationPending || !kind.fillRecommendations) {
      throw new ConflictError('Recommendations are not supported for this review')
    }
    const prepared = await kind.markRecommendationPending(workspaceId, reviewId, recId, note)
    await kind.emit(workspaceId, prepared)
    return this.scheduleRecommendation(kind, workspaceId, prepared.blockId, [], note, prepared)
  }

  /**
   * Offload a prepared recommendation batch to the durable driver (parked run) or run it inline
   * (off-path). Mirrors {@link incorporate}'s signal-or-inline split. Returns the prepared review
   * (parked) or the filled review (inline).
   */
  private async scheduleRecommendation<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
    itemIds: string[],
    note: string | undefined,
    prepared: TReview,
  ): Promise<TReview> {
    const parked = await this.findParkedStep(kind, workspaceId, blockId)
    if (!parked) {
      // Off-path: no pipeline parked on this review (an inspector "Run review" with no active
      // pipeline). There is no durable driver to offload to, so run the Writer inline and return
      // the filled review. `fillRecommendations` degrades gracefully when the reviewer model is
      // unavailable (it drops the placeholders and reopens the findings), so this stays a 200 on
      // every runtime instead of faulting — the divergence the cross-runtime suite guards.
      return (await kind.fillRecommendations!(workspaceId, blockId)) ?? prepared
    }
    return this.offloadRecommendation(workspaceId, parked, itemIds, note, prepared)
  }

  /** Hand a prepared recommendation batch to the durable driver that owns the parked run. */
  private async offloadRecommendation<TReview extends ReviewCommon>(
    workspaceId: string,
    parked: { instance: ExecutionInstance; step: PipelineStep },
    itemIds: string[],
    note: string | undefined,
    prepared: TReview,
  ): Promise<TReview> {
    // Record the intent + re-arm the run under OPTIMISTIC CONCURRENCY (race-audit 2.2
    // controller-half), mirroring {@link incorporate}: a blind full-row upsert here would
    // clobber a concurrent driver poll that moved the row. Re-arm BEFORE signalling (the park
    // left it `blocked`; `advanceInstance` no-ops unless `running`/`paused`) so the woken driver
    // actually re-enters the gate. The signal + emit run once after, on the winning snapshot.
    const agentKind = parked.step.agentKind
    let approvalId = ''
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      parked.instance.id,
      (inst) => {
        const step = inst.steps.find(
          (s) =>
            s.agentKind === agentKind &&
            s.state === 'waiting_decision' &&
            s.approval?.status === 'pending',
        )
        if (!step?.approval) {
          throw new ConflictError('The review is no longer awaiting a recommendation')
        }
        step.pendingRecommendation = { itemIds, ...(note ? { note } : {}) }
        if (inst.status === 'blocked') inst.status = 'running'
        approvalId = step.approval.id
      },
    )
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'recommend')
    return prepared
  }

  /** Locate the run + gate step a block's review is parked on (or null). */
  private async findParkedStep<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
  ): Promise<{ instance: ExecutionInstance; step: PipelineStep } | null> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block?.executionId) return null
    const instance = await this.deps.executionRepository.get(workspaceId, block.executionId)
    if (!instance) return null
    const step = instance.steps.find(
      (s) =>
        s.agentKind === kind.agentKind &&
        s.state === 'waiting_decision' &&
        s.approval?.status === 'pending',
    )
    return step ? { instance, step } : null
  }

  /**
   * Re-review the incorporated document (one more reviewer pass). On convergence
   * (`incorporated`) the parked run advances; otherwise the window shows the next cycle
   * (`ready`) or the iteration-cap choices (`exceeded`). Only valid once an incorporation
   * has produced a document to re-review (status `merged`).
   */
  async reReview<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
  ): Promise<TReview> {
    const review = await this.currentReview(kind, workspaceId, blockId)
    if (review.status !== 'merged') {
      throw new ConflictError('Incorporate the answers before re-reviewing')
    }
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const preset = await this.deps.resolveRiskPolicy(
      workspaceId,
      block,
      await this.runScope(workspaceId, blockId),
    )
    const updated = await kind.reReview(workspaceId, review.id, preset)
    if (updated.status === 'incorporated') {
      await this.resumeRun(kind, workspaceId, blockId)
      return updated
    }
    if (updated.status === 'ready') {
      // A re-review can surface fresh findings; pre-answer the auto-answerable ones just like the
      // pipeline-driven cycle (see {@link runIncorporationCycle}), so auto-recommendation happens
      // on EVERY iteration round that introduces new questions — not only the first. Off-path
      // (no parked run) there is no step to opt out via `stepOptions.autoRecommend`, so it is on.
      const ran = await this.maybeAutoRecommend(kind, workspaceId, blockId)
      // Auto-recommendation mutates + persists the review (answering findings, accepting `auto`
      // recs) AFTER `updated` was captured, and pushes the result over the live stream. Return the
      // FRESH persisted review so this HTTP response matches the stream — otherwise the SPA's
      // unguarded `store()` on the response clobbers the auto-answered state with this stale
      // snapshot, and the pre-answered findings vanish from the window until the next event.
      if (ran) return this.currentReview(kind, workspaceId, blockId)
    }
    return updated
  }

  /**
   * Proceed: settle the review (the last incorporated doc, if any, becomes what downstream
   * agents consume) and advance the parked run. Used when every finding is dismissed, or the
   * human proceeds past the iteration cap.
   */
  async proceed<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
  ): Promise<TReview> {
    const review = await this.currentReview(kind, workspaceId, blockId)
    const updated = await kind.markIncorporated(workspaceId, review.id)
    await this.resumeRun(kind, workspaceId, blockId)
    return updated
  }

  /**
   * Resolve a review that hit its iteration cap: grant one more round, proceed with the last
   * incorporated doc, or stop the task and reset it to phase zero (the run is cancelled, the
   * block returns to `planned` and is editable again; the review — with its last incorporated
   * doc — survives as a base for the next attempt).
   */
  async resolveExceeded<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
    choice: ResolveRequirementsExceededChoice,
  ): Promise<TReview> {
    const review = await this.currentReview(kind, workspaceId, blockId)
    await this.deps.dispatchIterationCap(workspaceId, blockId, choice, {
      extraRound: () => kind.grantExtraRound(workspaceId, review.id),
      proceed: () => this.proceed(kind, workspaceId, blockId),
    })
    // Re-read so the caller sees the post-resolution state (the doc survives stop-reset).
    return this.currentReview(kind, workspaceId, blockId)
  }

  /**
   * Resume a run parked on its review gate: finish the gate step, advance to the next step
   * and wake the durable driver. A no-op when the block has no run parked on a review gate of
   * this kind (e.g. an off-path inspector review with no active pipeline).
   */
  private async resumeRun<TReview extends ReviewCommon>(
    kind: ReviewKind<TReview>,
    workspaceId: string,
    blockId: string,
  ): Promise<void> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block?.executionId) return
    const executionId = block.executionId
    const isGate = (s: PipelineStep) =>
      s.agentKind === kind.agentKind &&
      s.state === 'waiting_decision' &&
      s.approval?.status === 'pending'
    // Off-path (an inspector review with no live pipeline) / already-advanced: nothing to
    // resume. Pre-read so this stays a best-effort no-op rather than entering the CAS loop (or
    // faulting on a gone run) when there is no parked gate — matching the prior resume.
    const current = await this.deps.executionRepository.get(workspaceId, executionId)
    if (!current || !current.steps.some(isGate)) return
    // Advance past the resolved gate under OPTIMISTIC CONCURRENCY (race-audit 2.2 controller-half):
    // the pure in-memory advance (`advanceRunPastGate`) runs inside the CAS; its non-idempotent
    // side effects (`settleAdvancedGate`: block writes + driver signal + emit) run once after, on
    // the winning snapshot — the same split the engine's `approveStep` / follow-up resolvers use.
    let stepIndex = -1
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        stepIndex = inst.steps.findIndex(isGate)
        // The gate advanced out from under us between the pre-read and this CAS attempt: no-op
        // (a harmless rev bump); `settleAdvancedGate` is skipped below.
        if (stepIndex === -1) return
        inst.steps[stepIndex]!.approval!.status = 'approved'
        this.deps.stateMachine.advanceRunPastGate(inst, stepIndex)
      },
    )
    if (stepIndex !== -1) {
      await this.deps.stateMachine.settleAdvancedGate(workspaceId, instance, stepIndex)
    }
  }
}
