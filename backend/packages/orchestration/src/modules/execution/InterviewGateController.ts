import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  ExecutionRepository,
  PipelineStep,
  WorkRunner,
} from '@cat-factory/kernel'
import { assertFound } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

// ---------------------------------------------------------------------------
// The shared interactive-INTERVIEWER gate spine. An interview gate PARKS its run on a durable
// decision-wait while a human answers the interviewer's clarifying questions through a dedicated
// window, then RESUMES it — running the (slow) interviewer LLM in the durable driver on resume,
// not the HTTP request. Two gates ride this spine today: the interactive-planning interviewer
// (entity-native, on the `initiatives` row) and the document interviewer (WS5, its own
// `doc_interview_sessions` table). Everything they share — the park/answer/resume/advance
// orchestration and the durable-driver contract — lives here; a gate supplies only its
// differentiators through an {@link InterviewGateKind} strategy (which agent-kind it runs as, how
// it decides + persists one pass, how it reads/answers its entity, and whether a re-run resets it).
// ---------------------------------------------------------------------------

/** The durable-driver collaborators every interview gate needs (shared with every other gate). */
export interface InterviewGateDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  stateMachine: RunStateMachine
  stepGraph: StepGraph
}

/**
 * The per-feature differences an interview gate varies over. Everything else (the
 * park/answer/resume/advance spine) lives in {@link InterviewGateController}.
 *
 * @typeParam TEntity the interview entity the window renders and the actions return (a
 *   `DocInterviewSession` for the doc interviewer, an `Initiative` for the planning interviewer).
 */
export interface InterviewGateKind<TEntity> {
  /** The pipeline-step `agentKind` this gate runs as (e.g. `doc-interviewer`). */
  readonly agentKind: string
  /** Label for `assertFound` when a block has no live interview entity (e.g. `Initiative`). */
  readonly entityName: string
  /** Whether the inline interviewer LLM is wired; false → the gate passes through unchanged. */
  enabled(): boolean
  /**
   * Drop any prior run's interview state for the block so a RE-RUN starts a clean interview
   * (mirrors `IterativeReviewService.review` clearing the block before iteration 1). Optional — an
   * entity-native gate whose entity lifecycle already isolates runs leaves it unset (no-op).
   */
  resetForFreshRun?(workspaceId: string, blockId: string): Promise<void>
  /**
   * Run ONE interviewer pass and persist its result (owning its own load / model resolution /
   * entity writes / live-event emit): return `park` when it asked the human a fresh batch of
   * questions (the gate then parks on the decision-wait), or `advance` when it converged — or
   * there was nothing to interview into.
   */
  runPass(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    opts: { proceed: boolean },
  ): Promise<'park' | 'advance'>
  /** Record the human's answer to one pending question (and emit); null when there is no entity. */
  recordAnswer(
    workspaceId: string,
    blockId: string,
    questionId: string,
    answer: string,
  ): Promise<TEntity | null>
  /** The block's current interview entity, or null (the window load path). */
  current(workspaceId: string, blockId: string): Promise<TEntity | null>
}

export class InterviewGateController<TEntity> {
  constructor(
    private readonly deps: InterviewGateDeps,
    private readonly kind: InterviewGateKind<TEntity>,
  ) {}

  /**
   * The pipeline-step `agentKind` this gate runs as. Exposed so the engine's step dispatch can
   * build its interview-gate routing table from the wired controllers (keyed by this) rather than
   * hard-coding each interviewer kind — matching the trait-based re-park / approval guards.
   */
  get agentKind(): string {
    return this.kind.agentKind
  }

  /**
   * Run the interviewer gate step. When no interviewer model is wired the step passes through
   * (pipelines — and the conformance suite — run unchanged). Otherwise it runs an interviewer
   * pass: questions → PARK for the window; converged → advance. Re-entrant: after the human
   * `continue`s (or `proceed`s), the durable driver wakes and re-enters here, running the (slow)
   * interviewer LLM in the driver rather than the HTTP request.
   */
  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    // Re-entry: the human answered and asked to continue/proceed. `proceed` forces the
    // interviewer to converge (no more questions); `continue` lets it ask follow-ups. A parked
    // run is never re-entered here without a decision (a blocked run no-ops in `advanceInstance`),
    // so this branch is the ONLY resume path and the one below is the genuine first dispatch.
    const pending = step.pendingInterview
    if (pending) {
      step.pendingInterview = null
      if (!this.kind.enabled()) return this.completeStep(workspaceId, instance, step, isFinalStep)
      return this.dispatchPass(workspaceId, instance, step, block, isFinalStep, {
        proceed: pending.proceed === true,
      })
    }
    // Fresh entry for this run: drop any prior run's interview state so a re-run starts a clean
    // interview instead of reusing a stale (often converged / at-cap) session. Runs even when the
    // interviewer is unwired, so a stale brief from an earlier wired run can't bleed downstream.
    await this.kind.resetForFreshRun?.(workspaceId, block.id)
    if (!this.kind.enabled()) return this.completeStep(workspaceId, instance, step, isFinalStep)
    return this.dispatchPass(workspaceId, instance, step, block, isFinalStep, { proceed: false })
  }

  /** One interviewer pass: the strategy decides + persists, we park or advance. */
  private async dispatchPass(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    opts: { proceed: boolean },
  ): Promise<AdvanceResult> {
    const decision = await this.kind.runPass(workspaceId, instance, block, opts)
    if (decision === 'park') {
      // Surface a decision-required notification so the parked interview gate is discoverable.
      await this.deps.stateMachine.raiseDecisionRequired(workspaceId, instance)
      return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
    }
    return this.completeStep(workspaceId, instance, step, isFinalStep)
  }

  // ---- window actions (driven by the per-feature server controller) --------------------------

  /** Record the human's answer to one pending question. Does NOT resume the run. */
  answer(
    workspaceId: string,
    blockId: string,
    questionId: string,
    answer: string,
  ): Promise<TEntity> {
    return this.requireCurrent(
      this.kind.recordAnswer(workspaceId, blockId, questionId, answer),
      blockId,
    )
  }

  /** Submit the answers and resume the interview (the interviewer re-runs, may ask more). */
  continue(workspaceId: string, blockId: string): Promise<TEntity> {
    return this.resume(workspaceId, blockId, { proceed: false }, 'continue')
  }

  /** Skip remaining questions: force the interviewer to converge, then advance. */
  proceed(workspaceId: string, blockId: string): Promise<TEntity> {
    return this.resume(workspaceId, blockId, { proceed: true }, 'proceed')
  }

  /** The current interview entity for a block (window load path). */
  getByBlock(workspaceId: string, blockId: string): Promise<TEntity | null> {
    return this.kind.current(workspaceId, blockId)
  }

  /**
   * Record the continue/proceed intent on the parked interviewer step and signal the durable
   * driver to wake — which re-enters {@link evaluate} and runs the (slow) interviewer LLM off the
   * HTTP request. Off-path (no parked run) it is a no-op read: the interview is not live, so there
   * is no driver to wake.
   */
  private async resume(
    workspaceId: string,
    blockId: string,
    intent: { proceed: boolean },
    choice: 'continue' | 'proceed',
  ): Promise<TEntity> {
    const parked = await this.findParkedStep(workspaceId, blockId)
    if (parked) {
      const { instance, step } = parked
      step.pendingInterview = intent.proceed ? { proceed: true } : {}
      // Re-arm BEFORE signalling: the park left the run `blocked`, and `advanceInstance`
      // no-ops unless it is `running`/`paused`, so a woken driver would otherwise return
      // without re-entering the gate.
      if (instance.status === 'blocked') instance.status = 'running'
      await this.deps.stateMachine.persistInstance(workspaceId, instance)
      await this.deps.stateMachine.emitInstance(workspaceId, instance)
      await this.deps.workRunner.signalDecision(workspaceId, instance.id, step.approval!.id, choice)
    }
    return this.requireCurrent(this.kind.current(workspaceId, blockId), blockId)
  }

  private async requireCurrent(entity: Promise<TEntity | null>, blockId: string): Promise<TEntity> {
    return assertFound(await entity, this.kind.entityName, blockId)
  }

  /** Locate the run + interviewer step a block's interview is parked on (or null). */
  private async findParkedStep(
    workspaceId: string,
    blockId: string,
  ): Promise<{ instance: ExecutionInstance; step: PipelineStep } | null> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block?.executionId) return null
    const instance = await this.deps.executionRepository.get(workspaceId, block.executionId)
    if (!instance) return null
    const step = instance.steps.find(
      (s) =>
        s.agentKind === this.kind.agentKind &&
        s.state === 'waiting_decision' &&
        s.approval?.status === 'pending',
    )
    return step ? { instance, step } : null
  }

  /** Finish the interviewer step and advance to the next step (or finish the run). */
  private async completeStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    this.deps.stepGraph.finishStep(step)
    step.progress = 1
    step.subtasks = undefined
    step.approval = null
    step.pendingInterview = null
    if (isFinalStep) {
      instance.status = 'done'
      await this.deps.stateMachine.finalizeBlock(workspaceId, instance, undefined)
      await this.deps.stateMachine.persistInstance(workspaceId, instance)
      await this.deps.stateMachine.emitInstance(workspaceId, instance)
      await this.deps.stateMachine.stopRunContainer(workspaceId, instance)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.deps.stepGraph.startStep(next)
    await this.deps.stateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }
}
