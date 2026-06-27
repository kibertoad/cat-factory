import type {
  AgentExecutor,
  AgentRunContext,
  BinaryArtifactStore,
  Block,
  BlockRepository,
  ExecutionInstance,
  ExecutionRepository,
  PipelineStep,
  VisualConfirmPair,
  VisualConfirmStepState,
  WorkRunner,
} from '@cat-factory/kernel'
import { ConflictError, isAsyncAgentExecutor } from '@cat-factory/kernel'
import { FIXER_AGENT_KIND, UI_TESTER_AGENT_KIND, VISUAL_CONFIRM_AGENT_KIND } from './ci.logic.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'

/** Render the human's findings as the resolved-context block handed to the fixer. */
function renderFindingsForFixer(findings: string): string {
  return [
    'A human reviewed the UI screenshots against the reference designs and asked for the',
    'changes below. Fix them and push to the PR branch; the UI will be reviewed again.',
    '',
    findings.trim(),
  ]
    .join('\n')
    .trim()
}

/**
 * The engine collaborators the visual-confirmation gate drives (kept on the engine, injected
 * here). The binary-artifact store + notification channel are optional — absent ones put the
 * gate into a degraded "manual" mode rather than failing.
 */
export interface VisualConfirmationControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  agentExecutor: AgentExecutor
  contextBuilder: AgentContextBuilder
  notificationService?: NotificationService
  /** The binary-artifact store the gate reads screenshots + reference designs from. */
  binaryArtifactStore?: BinaryArtifactStore
  /** The task's helper attempt budget (from the resolved merge preset). */
  resolveMergePreset: (workspaceId: string, block: Block) => Promise<{ ciMaxAttempts: number }>
  // Shared engine step-graph primitives (stay on ExecutionService, injected here).
  parkStepOnDecision: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    proposal?: string,
  ) => Promise<AdvanceResult>
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
  clockNow: () => number
}

/** The settle outcome of a helper (fixer) job, as seen by the gate. */
type HelperUpdate = { state: 'done' } | { state: 'failed' }

/**
 * Drives the `visual-confirmation` gate: a non-LLM engine step where a HUMAN is the verdict.
 * When reached it gathers the UI tester's captured screenshots + the human-uploaded reference
 * designs (paired by view) and PARKS; a person reviews actual-vs-reference and drives one of:
 * approve (advance), request a fix from findings (dispatch the Tester's `fixer`, then re-park),
 * or recapture (refresh the pairs from the latest UI-tester report). Modelled like the
 * `human-test` gate (the slow/awaiting work runs in the durable driver; the human actions just
 * record intent + signal). Passes through (auto-advances) when no binary-artifact store is wired.
 */
export class VisualConfirmationController {
  constructor(private readonly deps: VisualConfirmationControllerDeps) {}

  // ---- driver-entry paths --------------------------------------------------

  /**
   * Run the gate from `step`. FRESH entry gathers screenshots and parks (or passes through
   * when no store is wired). RE-ENTRY after a human action consumes the pending action.
   */
  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    const vc = step.visualConfirm
    if (vc?.pendingAction) {
      const action = vc.pendingAction
      vc.pendingAction = null
      // Checkpoint the consumed action BEFORE any slow/side-effecting work (a fixer dispatch
      // is a real container), so a retry can't re-consume it and dispatch a second helper.
      await this.deps.persistInstance(workspaceId, instance)
      return this.handleAction(workspaceId, instance, step, block, isFinalStep, action)
    }
    if (!vc) return this.begin(workspaceId, instance, step, block, isFinalStep)
    // A fixer is in flight: re-attach to its job rather than re-parking.
    if (vc.phase === 'fixing' && step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }
    return this.deps.parkStepOnDecision(workspaceId, instance, step, this.proposal(vc))
  }

  /**
   * A fixer job the gate dispatched has settled (delegated from `pollAgentJob`). Record the
   * round's outcome, refresh the pairs from the latest UI-tester report, and re-park the human.
   * We never fail the run here — the human is in control.
   */
  async onHelperComplete(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    update: HelperUpdate,
  ): Promise<AdvanceResult> {
    const vc = step.visualConfirm
    if (!vc) return { kind: 'continue' }
    const rounds = vc.rounds ?? []
    const last = rounds[rounds.length - 1]
    if (last && !last.outcome) last.outcome = update.state === 'failed' ? 'failed' : 'completed'
    step.jobId = undefined
    step.subtasks = undefined
    // Reclaim the finished helper container before re-parking.
    await this.deps.stopRunContainer(workspaceId, instance)
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    vc.pairs = await this.gatherPairs(workspaceId, instance, block)
    return this.toAwaitingHuman(workspaceId, instance, step, block)
  }

  // ---- human actions (called from ExecutionService, driven server-side) ----

  /** The human approved the screenshots: advance the run. */
  async approve(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.signalAction(workspaceId, blockId, { type: 'approve' })
  }

  /** The human wrote findings and asked for a fix: dispatch the Tester's `fixer`. */
  async requestFix(
    workspaceId: string,
    blockId: string,
    findings: string,
  ): Promise<ExecutionInstance> {
    return this.signalAction(workspaceId, blockId, { type: 'request-fix', findings })
  }

  /** Refresh the pairs from the latest UI-tester report (e.g. after an out-of-band re-run). */
  async recapture(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.signalAction(workspaceId, blockId, { type: 'recapture' })
  }

  // ---- internals -----------------------------------------------------------

  /** Fresh entry: gather screenshots and park (or pass through when no store is wired). */
  private async begin(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    // No store ⇒ nowhere to read screenshots from: pass through so a pipeline that includes
    // the gate still completes (tests / a deployment without blob storage).
    if (!this.deps.binaryArtifactStore) {
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }
    const maxAttempts = (await this.deps.resolveMergePreset(workspaceId, block)).ciMaxAttempts
    const pairs = await this.gatherPairs(workspaceId, instance, block)
    step.visualConfirm = {
      phase: 'awaiting_human',
      pairs,
      attempts: 0,
      maxAttempts,
      headSha: block.pullRequest?.branch ? null : undefined,
      rounds: [],
      ...(pairs.length === 0
        ? {
            degradedReason:
              'No UI screenshots were captured for this task — review the change manually, then approve or request a fix.',
          }
        : {}),
    }
    return this.toAwaitingHuman(workspaceId, instance, step, block)
  }

  /** Consume a human-requested action on re-entry. */
  private async handleAction(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    action: NonNullable<VisualConfirmStepState['pendingAction']>,
  ): Promise<AdvanceResult> {
    switch (action.type) {
      case 'approve': {
        const vc = step.visualConfirm
        if (vc) vc.phase = 'approved'
        await this.clearReadyNotification(workspaceId, instance.blockId)
        return this.completeStep(workspaceId, instance, step, isFinalStep)
      }
      case 'request-fix':
        return this.dispatchFixer(workspaceId, instance, step, block, action.findings ?? '')
      case 'recapture': {
        const vc = step.visualConfirm
        if (vc) vc.pairs = await this.gatherPairs(workspaceId, instance, block)
        return this.toAwaitingHuman(workspaceId, instance, step, block)
      }
    }
  }

  /** Dispatch the Tester's `fixer` from the human's findings and park on its job. */
  private async dispatchFixer(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    findings: string,
  ): Promise<AdvanceResult> {
    const vc = step.visualConfirm!
    const executor = this.deps.agentExecutor
    // The fixer pushes onto the PR branch, so it needs one to exist + an async executor.
    if (!isAsyncAgentExecutor(executor) || !block.pullRequest?.branch) {
      return this.toAwaitingHuman(workspaceId, instance, step, block)
    }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    const base = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
    )
    const context: AgentRunContext = {
      ...base,
      agentKind: FIXER_AGENT_KIND,
      priorOutputs: [
        ...base.priorOutputs,
        { agentKind: VISUAL_CONFIRM_AGENT_KIND, output: renderFindingsForFixer(findings) },
      ],
    }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    step.startingContainer = true
    step.subtasks = undefined
    // Leave the parked decision state: while the helper runs the step is `working` with a
    // live job, NOT parked on a stale approval (a re-drive would otherwise abandon the job).
    this.deps.startStep(step)
    step.approval = null
    vc.phase = 'fixing'
    vc.attempts += 1
    vc.rounds = [
      ...(vc.rounds ?? []),
      {
        findings,
        helperKind: FIXER_AGENT_KIND,
        jobId: handle.jobId,
        outcome: null,
        at: this.deps.clockNow(),
      },
    ]
    await this.deps.persistInstance(workspaceId, instance)
    await this.deps.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /** Gather actual-vs-reference pairs: the latest UI-tester report's screenshots + block references. */
  private async gatherPairs(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ): Promise<VisualConfirmPair[]> {
    const byView = new Map<string, VisualConfirmPair>()
    // Actual: the most recent `tester-ui` step's captured screenshots.
    const uiStep = [...instance.steps]
      .reverse()
      .find((s) => s.agentKind === UI_TESTER_AGENT_KIND && s.test?.lastReport)
    for (const shot of uiStep?.test?.lastReport?.screenshots ?? []) {
      byView.set(shot.view, {
        view: shot.view,
        actualArtifactId: shot.artifactId,
        referenceArtifactId: shot.referenceArtifactId ?? null,
      })
    }
    // Reference: the block's uploaded reference design images (carry no executionId).
    if (this.deps.binaryArtifactStore) {
      const refs = (await this.deps.binaryArtifactStore.listByBlock(workspaceId, block.id)).filter(
        (r) => r.kind === 'reference',
      )
      for (const ref of refs) {
        const view = ref.view ?? '(reference)'
        const existing = byView.get(view)
        if (existing) existing.referenceArtifactId = existing.referenceArtifactId ?? ref.id
        else byView.set(view, { view, actualArtifactId: null, referenceArtifactId: ref.id })
      }
    }
    return [...byView.values()]
  }

  /** Flip to awaiting-human, summon the human (idempotent notification), and park. */
  private async toAwaitingHuman(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult> {
    const vc = step.visualConfirm!
    vc.phase = 'awaiting_human'
    await this.raiseReadyNotification(workspaceId, instance, block, vc)
    return this.deps.parkStepOnDecision(workspaceId, instance, step, this.proposal(vc))
  }

  /** Finish the gate step and advance to the next step (or finish the run). */
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

  /**
   * Record the human's action on the parked gate step and wake the durable driver, which
   * re-enters {@link evaluate} and acts on it. Re-arms the run to `running` first.
   */
  private async signalAction(
    workspaceId: string,
    blockId: string,
    action: NonNullable<VisualConfirmStepState['pendingAction']>,
  ): Promise<ExecutionInstance> {
    const { instance, step } = this.requireParked(await this.findParked(workspaceId, blockId))
    const vc = step.visualConfirm!
    if (action.type === 'request-fix' && vc.attempts >= vc.maxAttempts) {
      throw new ConflictError(
        `This task has reached its fix-attempt limit (${vc.maxAttempts}); approve the change or review it manually.`,
      )
    }
    vc.pendingAction = action
    if (instance.status === 'blocked') instance.status = 'running'
    await this.deps.persistInstance(workspaceId, instance)
    await this.deps.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(
      workspaceId,
      instance.id,
      step.approval!.id,
      'visual-confirmation',
    )
    return instance
  }

  /** Locate the run + gate step a block's visual-confirmation gate is parked on (or null). */
  private async findParked(
    workspaceId: string,
    blockId: string,
  ): Promise<{ instance: ExecutionInstance; step: PipelineStep } | null> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block?.executionId) return null
    const instance = await this.deps.executionRepository.get(workspaceId, block.executionId)
    if (!instance) return null
    const step = instance.steps.find(
      (s) =>
        s.agentKind === VISUAL_CONFIRM_AGENT_KIND &&
        s.state === 'waiting_decision' &&
        s.approval?.status === 'pending',
    )
    return step ? { instance, step } : null
  }

  private requireParked(found: { instance: ExecutionInstance; step: PipelineStep } | null): {
    instance: ExecutionInstance
    step: PipelineStep
  } {
    if (!found) throw new ConflictError('No visual-confirmation gate is currently awaiting input')
    return found
  }

  private proposal(vc: VisualConfirmStepState): string {
    const n = vc.pairs?.length ?? 0
    return n > 0
      ? `Review ${n} screenshot${n === 1 ? '' : 's'} against the reference designs, then approve or request a fix.`
      : 'Review the UI change, then approve or request a fix.'
  }

  /** Summon the human to review (idempotent per block+type). Best-effort. */
  private async raiseReadyNotification(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    vc: VisualConfirmStepState,
  ): Promise<void> {
    if (!this.deps.notificationService) return
    const n = vc.pairs?.length ?? 0
    await this.deps.notificationService.raise(workspaceId, {
      type: 'visual_confirmation_ready',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" is ready for visual confirmation`,
      body:
        n > 0
          ? `Review ${n} captured screenshot${n === 1 ? '' : 's'} against the reference designs, then approve or request a fix.`
          : 'Review the UI change, then approve or request a fix.',
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /** Dismiss the "ready for review" card once the gate passes. Best-effort. */
  private async clearReadyNotification(workspaceId: string, blockId: string): Promise<void> {
    const svc = this.deps.notificationService
    if (!svc) return
    const open = await svc.listOpen(workspaceId)
    for (const card of open) {
      if (card.type === 'visual_confirmation_ready' && card.blockId === blockId) {
        await svc.resolve(workspaceId, card.id, 'act')
      }
    }
  }
}
