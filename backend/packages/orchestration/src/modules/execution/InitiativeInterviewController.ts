import type {
  Block,
  BlockRepository,
  ExecutionInstance,
  ExecutionRepository,
  Initiative,
  PipelineStep,
  WorkRunner,
} from '@cat-factory/kernel'
import { assertFound, INITIATIVE_INTERVIEWER_AGENT_KIND } from '@cat-factory/kernel'
import type { InitiativeService } from '../initiative/InitiativeService.js'
import type { InitiativeInterviewService } from '../initiative/InitiativeInterviewService.js'
import { interviewAtCap } from '../initiative/initiative.logic.js'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

// ---------------------------------------------------------------------------
// The interactive-planning INTERVIEWER gate. Structurally a sibling of the review gate
// (ReviewGateController) — it PARKS the planning run on a durable decision-wait while a human
// answers the interviewer's clarifying questions through the planning window, then RESUMES it
// — but it is ENTITY-NATIVE: the questions / answers / synthesized brief live directly on the
// `initiatives` entity (its `qa` + `interview` + goal/constraints/nonGoals fields) via
// InitiativeService's CAS `mutate`, not in a parallel review table. The interviewer LLM lives
// in InitiativeInterviewService; this class owns only the park/answer/resume orchestration and
// reuses the shared RunStateMachine + StepGraph spine so the durable-driver contract matches
// every other gate.
// ---------------------------------------------------------------------------

export interface InitiativeInterviewControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  stateMachine: RunStateMachine
  stepGraph: StepGraph
  /** The interviewer LLM. Absent (or model-less) → the gate passes through (no interview). */
  interviewService?: InitiativeInterviewService
  initiativeService: InitiativeService
}

export class InitiativeInterviewController {
  constructor(private readonly deps: InitiativeInterviewControllerDeps) {}

  /**
   * Run the interviewer gate step. When no interviewer model is wired the step passes
   * through (pipelines — and the conformance suite — run unchanged). Otherwise it runs an
   * interviewer pass: questions → persist them and PARK for the planning window; converged →
   * fold the synthesized brief onto the entity and advance. Re-entrant: after the human
   * `continue`s (or `proceed`s), the durable driver wakes and re-enters here, running the
   * (slow) interviewer LLM in the driver rather than the HTTP request.
   */
  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    if (!this.deps.interviewService?.enabled) {
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }
    // Re-entry: the human answered and asked to continue/proceed. `proceed` forces the
    // interviewer to converge (no more questions); `continue` lets it ask follow-ups.
    const pending = step.pendingInterview
    if (pending) {
      step.pendingInterview = null
      return this.runPass(workspaceId, instance, step, block, isFinalStep, {
        proceed: pending.proceed === true,
      })
    }
    // Fresh entry: the interviewer's first pass.
    return this.runPass(workspaceId, instance, step, block, isFinalStep, { proceed: false })
  }

  /** One interviewer pass: ask (park) or converge (advance). */
  private async runPass(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    opts: { proceed: boolean },
  ): Promise<AdvanceResult> {
    const interviewService = this.deps.interviewService
    const initiative = interviewService
      ? await this.deps.initiativeService.getByBlock(workspaceId, block.id)
      : null
    if (!interviewService || !initiative) {
      // No interviewer wired, or no initiative entity to interview into — don't wedge the
      // run; just advance (the fresh-entry `enabled` guard normally handles the former).
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }
    const finalize = opts.proceed || interviewAtCap(initiative)
    const output = await interviewService.runInterview(workspaceId, block, initiative, {
      finalize,
    })
    if (output.kind === 'questions') {
      await this.deps.initiativeService.recordInterviewQuestions(
        workspaceId,
        block.id,
        output.questions,
      )
      // Surface a decision-required notification so the parked planning gate is discoverable.
      await this.deps.stateMachine.raiseDecisionRequired(workspaceId, instance)
      return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
    }
    // Converged: fold the synthesized brief onto the entity and advance to the analyst.
    await this.deps.initiativeService.recordInterviewOutcome(workspaceId, block.id, {
      goal: output.goal,
      constraints: output.constraints,
      nonGoals: output.nonGoals,
    })
    return this.completeStep(workspaceId, instance, step, isFinalStep)
  }

  // ---- window actions (driven by the server InitiativePlanningController) --------------

  /** Record the human's answer to one pending question. Does NOT resume the run. */
  async answer(
    workspaceId: string,
    blockId: string,
    questionId: string,
    answer: string,
  ): Promise<Initiative> {
    return assertFound(
      await this.deps.initiativeService.recordInterviewAnswer(
        workspaceId,
        blockId,
        questionId,
        answer,
      ),
      'Initiative',
      blockId,
    )
  }

  /** Submit the answers and resume the interview (the interviewer re-runs, may ask more). */
  continue(workspaceId: string, blockId: string): Promise<Initiative> {
    return this.resume(workspaceId, blockId, { proceed: false }, 'continue')
  }

  /** Skip remaining questions: force the interviewer to converge, then advance. */
  proceed(workspaceId: string, blockId: string): Promise<Initiative> {
    return this.resume(workspaceId, blockId, { proceed: true }, 'proceed')
  }

  /**
   * Record the continue/proceed intent on the parked interviewer step and signal the durable
   * driver to wake — which re-enters {@link evaluate} and runs the (slow) interviewer LLM
   * off the HTTP request. Off-path (no parked run) it is a no-op read: the interview is not
   * live, so there is no driver to wake.
   */
  private async resume(
    workspaceId: string,
    blockId: string,
    intent: { proceed: boolean },
    choice: 'continue' | 'proceed',
  ): Promise<Initiative> {
    const parked = await this.findParkedStep(workspaceId, blockId)
    if (parked) {
      const { instance, step } = parked
      step.pendingInterview = intent.proceed ? { proceed: true } : {}
      // Re-arm BEFORE signalling: the park left the run `blocked`, and `advanceInstance`
      // no-ops unless it is `running`/`paused`, so a woken driver would otherwise return
      // without re-entering the gate (mirrors ReviewGateController.incorporate).
      if (instance.status === 'blocked') instance.status = 'running'
      await this.deps.stateMachine.persistInstance(workspaceId, instance)
      await this.deps.stateMachine.emitInstance(workspaceId, instance)
      await this.deps.workRunner.signalDecision(workspaceId, instance.id, step.approval!.id, choice)
    }
    return this.currentInitiative(workspaceId, blockId)
  }

  private async currentInitiative(workspaceId: string, blockId: string): Promise<Initiative> {
    return assertFound(
      await this.deps.initiativeService.getByBlock(workspaceId, blockId),
      'Initiative',
      blockId,
    )
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
        s.agentKind === INITIATIVE_INTERVIEWER_AGENT_KIND &&
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
