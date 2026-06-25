import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  ExecutionRepository,
  PipelineStep,
  RequirementConcernLevel,
  ResolveRequirementsExceededChoice,
  WorkRunner,
} from '@cat-factory/kernel'
import { assertFound, ConflictError, ValidationError } from '@cat-factory/kernel'
import { hasNotesToIncorporate } from '../requirements/requirements.logic.js'
import type { ReviewCommon } from '../review/IterativeReviewService.js'
import type { AdvanceResult } from './advance.js'

/**
 * The merge-preset knobs an iterative review consults: how many reviewer passes it
 * may run and the severity it tolerates before it must raise a finding for a human.
 * A structural subset of the full merge preset, so {@link ReviewGateControllerDeps.resolveMergePreset}
 * can return the whole preset unchanged.
 */
export interface ReviewPreset {
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
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
   * for a batch of findings so the SPA shows "generating…" at once. The slow Writer runs later
   * via {@link fillRecommendations}. Optional — absent on the clarity kind (no Writer).
   */
  prepareRecommendations?(
    workspaceId: string,
    reviewId: string,
    itemIds: string[],
    note?: string,
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
  /** Push a live review-changed event so an open window/inspector reflects the new status. */
  emit(workspaceId: string, review: TReview): Promise<void>
}

/**
 * The engine flow-control operations the review gates drive. These stay on
 * `ExecutionService` — they are the shared state-machine primitives reused by the generic
 * approval path and the companion iteration-cap gate (`parkStepOnDecision`,
 * `advancePastResolvedGate`, `dispatchIterationCap`) — and are injected here so the
 * requirements + clarity gate flow can live in its own unit without duplicating them.
 */
export interface ReviewGateControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  resolveMergePreset: (workspaceId: string, block: Block) => Promise<ReviewPreset>
  parkStepOnDecision: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    proposal?: string,
  ) => Promise<AdvanceResult>
  advancePastResolvedGate: (
    workspaceId: string,
    instance: ExecutionInstance,
    stepIndex: number,
  ) => Promise<void>
  dispatchIterationCap: (
    workspaceId: string,
    blockId: string,
    choice: ResolveRequirementsExceededChoice,
    handlers: { extraRound: () => Promise<unknown>; proceed: () => Promise<unknown> },
  ) => Promise<void>
  /**
   * Raise a `decision_required` notification when the gate parks at its iteration cap, so
   * the three-choice decision is discoverable instead of the run looking silently stuck.
   */
  raiseDecisionRequired: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
  finishStep: (step: PipelineStep) => void
  startStep: (step: PipelineStep) => void
  updateBlockProgress: (
    workspaceId: string,
    instance: ExecutionInstance,
    status: 'in_progress' | 'blocked',
  ) => Promise<void>
  finalizeBlock: (
    workspaceId: string,
    instance: ExecutionInstance,
    confidence: number | undefined,
  ) => Promise<void>
  stopRunContainer: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
  persistInstance: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
  emitInstance: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
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

    // Re-entry: the human asked the Requirement Writer to recommend answers for a batch of
    // findings (or re-requested one). Run the Writer here in the durable driver — filling the
    // `pending` placeholders one by one (progress streams to the window) and notifying when the
    // batch finishes — then re-park. Recommendations NEVER advance the run: the human still has
    // to accept/reject them and then incorporate, so this always returns to the decision wait.
    const pendingRec = step.pendingRecommendation
    if (pendingRec && kind.fillRecommendations) {
      step.pendingRecommendation = null
      await kind.fillRecommendations(workspaceId, block.id)
      return this.deps.parkStepOnDecision(workspaceId, instance, step)
    }

    // Re-entry: the human answered the findings and asked to incorporate. Do the (slow)
    // LLM work here in the durable driver — fold the answers into a document, then
    // re-review it — instead of in the HTTP request that the user is no longer waiting on.
    // `reReview` raises the re-summon notification itself when it finds findings.
    const pending = step.pendingIncorporation
    if (pending) {
      step.pendingIncorporation = null
      const review = await this.runIncorporationCycle(kind, workspaceId, block.id, pending.feedback)
      if (review.status === 'incorporated') {
        return this.completeStep(workspaceId, instance, step, isFinalStep)
      }
      // `ready`/`exceeded`: re-park (a fresh decision id) and wait for the human again.
      // At the cap, raise a notification so the three-choice decision is discoverable.
      if (review.status === 'exceeded') await this.deps.raiseDecisionRequired(workspaceId, instance)
      return this.deps.parkStepOnDecision(workspaceId, instance, step)
    }

    // Fresh entry: run the initial reviewer pass with the task's preset knobs (shared with
    // the off-path inspector surface). Auto-pass (status `incorporated`) → advance; the
    // findings stay recorded on the review for transparency. `ready`/`exceeded` → park for
    // the dedicated window.
    const review = await this.review(kind, workspaceId, block.id)
    if (review.status === 'incorporated') {
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }
    if (review.status === 'exceeded') await this.deps.raiseDecisionRequired(workspaceId, instance)
    return this.deps.parkStepOnDecision(workspaceId, instance, step)
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
    const preset = await this.deps.resolveMergePreset(workspaceId, block)
    await kind.incorporate(workspaceId, blockId, review.id, feedback)
    // The fold is done; flag the SECOND stage (`reviewing`) so the board/window can show
    // "re-reviewing" distinctly from "incorporating" — either of the two LLM calls can be
    // the slow one, so the human needs to know which is currently running.
    const reReviewing = await kind.markReReviewing(workspaceId, review.id)
    await kind.emit(workspaceId, reReviewing)
    const reviewed = await kind.reReview(workspaceId, review.id, preset)
    await kind.emit(workspaceId, reviewed)
    return reviewed
  }

  /** Finish a review gate step and advance to the next step (or finish the run). */
  private async completeStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    this.deps.finishStep(step)
    step.progress = 1
    step.subtasks = undefined
    step.approval = null
    if (isFinalStep) {
      instance.status = 'done'
      await this.deps.finalizeBlock(workspaceId, instance, undefined)
      await this.deps.persistInstance(workspaceId, instance)
      await this.deps.emitInstance(workspaceId, instance)
      await this.deps.stopRunContainer(workspaceId, instance)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.deps.startStep(next)
    await this.deps.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.deps.persistInstance(workspaceId, instance)
    await this.deps.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
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
  ): Promise<TReview> {
    const block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const preset = await this.deps.resolveMergePreset(workspaceId, block)
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

    const { instance, step } = parked
    step.pendingIncorporation = feedback ? { feedback } : {}
    // Re-arm the run BEFORE signalling the driver: the park left it `blocked`, but
    // `advanceInstance` no-ops unless the run is `running`/`paused`, so a woken driver
    // would otherwise return `noop` (and the workflow would end) WITHOUT running the
    // re-entrant incorporate + re-review cycle — leaving the review stuck `incorporating`
    // forever. Mirrors every other resume path (e.g. `advancePastResolvedGate`).
    if (instance.status === 'blocked') instance.status = 'running'
    const updated = await kind.markIncorporating(workspaceId, review.id)
    await this.deps.persistInstance(workspaceId, instance)
    await this.deps.emitInstance(workspaceId, instance)
    await kind.emit(workspaceId, updated)
    await this.deps.workRunner.signalDecision(
      workspaceId,
      instance.id,
      step.approval!.id,
      'incorporate',
    )
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
    itemIds: string[],
    note?: string,
  ): Promise<TReview> {
    if (!kind.prepareRecommendations || !kind.fillRecommendations) {
      throw new ConflictError('Recommendations are not supported for this review')
    }
    const current = await this.currentReview(kind, workspaceId, blockId)
    const prepared = await kind.prepareRecommendations(workspaceId, current.id, itemIds, note)
    await kind.emit(workspaceId, prepared)
    return this.scheduleRecommendation(kind, workspaceId, blockId, itemIds, note, prepared)
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
      // Off-path: no pipeline parked on this review. Run the Writer inline (it cannot be offloaded
      // to a driver that isn't running) and return the filled review.
      return (await kind.fillRecommendations!(workspaceId, blockId)) ?? prepared
    }
    const { instance, step } = parked
    step.pendingRecommendation = { itemIds, ...(note ? { note } : {}) }
    // Re-arm the run BEFORE signalling (the park left it `blocked`; `advanceInstance` no-ops
    // unless `running`/`paused`) so the woken driver actually re-enters the gate. Mirrors
    // {@link incorporate}.
    if (instance.status === 'blocked') instance.status = 'running'
    await this.deps.persistInstance(workspaceId, instance)
    await this.deps.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(
      workspaceId,
      instance.id,
      step.approval!.id,
      'recommend',
    )
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
    const preset = await this.deps.resolveMergePreset(workspaceId, block)
    const updated = await kind.reReview(workspaceId, review.id, preset)
    if (updated.status === 'incorporated') await this.resumeRun(kind, workspaceId, blockId)
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
    const instance = await this.deps.executionRepository.get(workspaceId, block.executionId)
    if (!instance) return
    const idx = instance.steps.findIndex(
      (s) =>
        s.agentKind === kind.agentKind &&
        s.state === 'waiting_decision' &&
        s.approval?.status === 'pending',
    )
    if (idx === -1) return
    instance.steps[idx]!.approval!.status = 'approved'
    await this.deps.advancePastResolvedGate(workspaceId, instance, idx)
  }
}
