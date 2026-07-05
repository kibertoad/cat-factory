import type {
  Block,
  BlockRepository,
  DocInterviewSession,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  PipelineStep,
  WorkRunner,
} from '@cat-factory/kernel'
import { assertFound, DOC_INTERVIEWER_AGENT_KIND } from '@cat-factory/kernel'
import type {
  DocInterviewPriorOutput,
  DocInterviewService,
} from '../docInterview/DocInterviewService.js'
import { docInterviewAtCap } from '../docInterview/doc-interview.logic.js'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

// ---------------------------------------------------------------------------
// The interactive document-review INTERVIEWER gate (WS5). Structurally a sibling
// of the initiative interviewer (InitiativeInterviewController) — it PARKS the
// document run on a durable decision-wait while a human answers the interviewer's
// clarifying questions through the interview window, then RESUMES it. The
// interviewer LLM + the session persistence both live in DocInterviewService
// (self-contained, its own `doc_interview_sessions` table, since a document task
// has no owning entity); this class owns only the park/answer/resume
// orchestration and reuses the shared RunStateMachine + StepGraph spine so the
// durable-driver contract matches every other gate.
// ---------------------------------------------------------------------------

export interface DocInterviewControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  stateMachine: RunStateMachine
  stepGraph: StepGraph
  events: ExecutionEventPublisher
  /** The interviewer LLM + session store. Absent (or model-less) → the gate passes through. */
  docInterviewService?: DocInterviewService
}

export class DocInterviewController {
  constructor(private readonly deps: DocInterviewControllerDeps) {}

  /**
   * Run the interviewer gate step. When no interviewer model is wired the step passes through
   * (pipelines — and the conformance suite — run unchanged). Otherwise it runs an interviewer
   * pass: questions → persist them and PARK for the interview window; converged → fold the
   * synthesized brief onto the session and advance. Re-entrant: after the human `continue`s (or
   * `proceed`s), the durable driver wakes and re-enters here, running the (slow) interviewer LLM
   * in the driver rather than the HTTP request.
   */
  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    if (!this.deps.docInterviewService?.enabled) {
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
    const service = this.deps.docInterviewService
    if (!service) return this.completeStep(workspaceId, instance, step, isFinalStep)
    const session = await service.getByBlock(workspaceId, block.id)
    const finalize = opts.proceed || (session ? docInterviewAtCap(session) : false)
    const { output, model } = await service.runInterview(
      workspaceId,
      block,
      session ?? this.emptySession(block.id),
      { finalize, priorOutputs: this.priorOutputs(instance) },
    )
    if (output.kind === 'questions') {
      const updated = await service.recordQuestions(workspaceId, block.id, output.questions, model)
      await this.emit(workspaceId, updated)
      // Surface a decision-required notification so the parked interview gate is discoverable.
      await this.deps.stateMachine.raiseDecisionRequired(workspaceId, instance)
      return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
    }
    // Converged: fold the synthesized brief onto the session and advance to the writer.
    const done = await service.recordOutcome(workspaceId, block.id, output.brief, model)
    if (done) await this.emit(workspaceId, done)
    return this.completeStep(workspaceId, instance, step, isFinalStep)
  }

  // ---- window actions (driven by the server DocInterviewController) --------------------

  /** Record the human's answer to one pending question. Does NOT resume the run. */
  async answer(
    workspaceId: string,
    blockId: string,
    questionId: string,
    answer: string,
  ): Promise<DocInterviewSession> {
    const service = this.requireService()
    const updated = assertFound(
      await service.recordAnswer(workspaceId, blockId, questionId, answer),
      'DocInterviewSession',
      blockId,
    )
    await this.emit(workspaceId, updated)
    return updated
  }

  /** Submit the answers and resume the interview (the interviewer re-runs, may ask more). */
  continue(workspaceId: string, blockId: string): Promise<DocInterviewSession> {
    return this.resume(workspaceId, blockId, { proceed: false }, 'continue')
  }

  /** Skip remaining questions: force the interviewer to converge, then advance. */
  proceed(workspaceId: string, blockId: string): Promise<DocInterviewSession> {
    return this.resume(workspaceId, blockId, { proceed: true }, 'proceed')
  }

  /** The current session for a block (window load path). */
  getByBlock(workspaceId: string, blockId: string): Promise<DocInterviewSession | null> {
    return this.requireService().getByBlock(workspaceId, blockId)
  }

  /**
   * Record the continue/proceed intent on the parked interviewer step and signal the durable
   * driver to wake — which re-enters {@link evaluate} and runs the (slow) interviewer LLM off
   * the HTTP request. Off-path (no parked run) it is a no-op read: the interview is not live,
   * so there is no driver to wake.
   */
  private async resume(
    workspaceId: string,
    blockId: string,
    intent: { proceed: boolean },
    choice: 'continue' | 'proceed',
  ): Promise<DocInterviewSession> {
    const parked = await this.findParkedStep(workspaceId, blockId)
    if (parked) {
      const { instance, step } = parked
      step.pendingInterview = intent.proceed ? { proceed: true } : {}
      // Re-arm BEFORE signalling: the park left the run `blocked`, and `advanceInstance`
      // no-ops unless it is `running`/`paused`, so a woken driver would otherwise return
      // without re-entering the gate (mirrors InitiativeInterviewController.resume).
      if (instance.status === 'blocked') instance.status = 'running'
      await this.deps.stateMachine.persistInstance(workspaceId, instance)
      await this.deps.stateMachine.emitInstance(workspaceId, instance)
      await this.deps.workRunner.signalDecision(workspaceId, instance.id, step.approval!.id, choice)
    }
    return this.currentSession(workspaceId, blockId)
  }

  private async currentSession(workspaceId: string, blockId: string): Promise<DocInterviewSession> {
    return assertFound(
      await this.requireService().getByBlock(workspaceId, blockId),
      'DocInterviewSession',
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
        s.agentKind === DOC_INTERVIEWER_AGENT_KIND &&
        s.state === 'waiting_decision' &&
        s.approval?.status === 'pending',
    )
    return step ? { instance, step } : null
  }

  /** The completed prior steps' outputs, so the interviewer can read the outline / research. */
  private priorOutputs(instance: ExecutionInstance): DocInterviewPriorOutput[] {
    return instance.steps
      .slice(0, instance.currentStep)
      .filter((s) => s.output)
      .map((s) => ({ agentKind: s.agentKind, output: s.output! }))
  }

  private emptySession(blockId: string): DocInterviewSession {
    return {
      id: '',
      blockId,
      status: 'awaiting',
      round: 0,
      maxRounds: 0,
      qa: [],
      brief: null,
      model: null,
      createdAt: 0,
      updatedAt: 0,
    }
  }

  private requireService(): DocInterviewService {
    const service = this.deps.docInterviewService
    if (!service) throw new Error('The document interviewer is not configured')
    return service
  }

  private async emit(workspaceId: string, session: DocInterviewSession): Promise<void> {
    await this.deps.events.docInterviewChanged?.(workspaceId, session)
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
