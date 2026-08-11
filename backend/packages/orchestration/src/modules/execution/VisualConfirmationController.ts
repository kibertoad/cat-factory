import type {
  AgentExecutor,
  AgentRunContext,
  BinaryArtifactStore,
  ResolveBinaryArtifactStore,
  Block,
  BlockRepository,
  DocumentRepository,
  ExecutionInstance,
  ExecutionRepository,
  PipelineStep,
  VisualConfirmPair,
  VisualConfirmStepState,
  WorkRunner,
} from '@cat-factory/kernel'
import { ConflictError, isAsyncAgentExecutor } from '@cat-factory/kernel'
import { countCapturedViews } from '@cat-factory/contracts'
import { resolveBlockReferences } from './block-reference-set.js'
import { FIXER_AGENT_KIND, UI_TESTER_AGENT_KIND, VISUAL_CONFIRM_AGENT_KIND } from './ci.logic.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { RunPolicyScope } from './policy-types.js'
import type { StepGraph } from './StepGraph.js'
import { recordDispatchedJob } from './step-fold.logic.js'

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
  /**
   * Resolves the binary-artifact store (per-account backend) the gate reads screenshots +
   * reference designs from, for the run's workspace. Absent / resolving to null → manual mode.
   */
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /**
   * The imported-document corpus, read to find the DESIGNS a task links so their retained frames
   * join the gallery beside the hand-uploaded references. Absent (documents unwired) ⇒ the gate
   * behaves exactly as it did before: uploads only.
   */
  documentRepository?: DocumentRepository
  /** The task's helper attempt budget (from the resolved merge preset). */
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
    run: RunPolicyScope,
  ) => Promise<{ ciMaxAttempts: number }>
  /** The async instance/block spine (park/advance/finalize/persist/emit/progress/stop). */
  stateMachine: RunStateMachine
  /** The pure step mutators (start/finish a step). */
  stepGraph: StepGraph
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
      // Driver-path write ⇒ `casPersist`: a concurrent `stopRun`/`cancel` loses the CAS and
      // re-drives on fresh state rather than resurrecting the row (race-audit 2.2 controller-half).
      await this.deps.stateMachine.casPersist(workspaceId, instance)
      return this.handleAction(workspaceId, instance, step, block, isFinalStep, action)
    }
    if (!vc) return this.begin(workspaceId, instance, step, block, isFinalStep)
    // A fixer is in flight: re-attach to its job rather than re-parking.
    if (vc.phase === 'fixing' && step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step, this.proposal(vc))
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
    await this.deps.stateMachine.stopRunContainer(workspaceId, instance)
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const gathered = await this.gatherPairs(
      workspaceId,
      instance,
      block,
      await this.store(workspaceId),
    )
    vc.pairs = gathered.pairs
    vc.designReferences = gathered.design
    // The pairs come from the LAST UI-tester report, which predates this fix — the gate does
    // not auto re-run the UI tester yet (see the handover doc). Flag the staleness so the human
    // knows to recapture (or re-run the UI tester) before judging the screenshots as final,
    // unless the fix itself failed (then the existing pre-fix shots are still the right ones).
    vc.degradedReason =
      update.state === 'failed'
        ? 'The requested fix did not complete — review the change manually, then approve or retry.'
        : 'A fix was applied. These screenshots were captured BEFORE it — recapture (or re-run the UI tester) to refresh them before approving.'
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

  /**
   * Re-pair actual-vs-reference from the current store state: the latest UI-tester report's
   * screenshots PLUS any reference design images uploaded since the gate parked. This is the
   * action a human takes after uploading (or replacing) reference images mid-review, or after an
   * out-of-band UI-tester re-run. NOTE: it does not itself re-run the UI tester — auto re-capture
   * after a fix is a deferred enhancement (see the visual-confirmation handover doc) — so with no
   * new references/run it is a harmless refresh that re-reads the same pairs.
   */
  async recapture(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.signalAction(workspaceId, blockId, { type: 'recapture' })
  }

  // ---- internals -----------------------------------------------------------

  /** Resolve the workspace's per-account binary-artifact store (null = none configured). */
  private async store(workspaceId: string): Promise<BinaryArtifactStore | null> {
    return this.deps.resolveBinaryArtifactStore
      ? this.deps.resolveBinaryArtifactStore(workspaceId)
      : null
  }

  /** Fresh entry: gather screenshots and park (or pass through when no store is wired). */
  private async begin(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    // No store ⇒ nowhere to read screenshots from: pass through so a pipeline that includes
    // the gate still completes (tests / an account without content storage configured).
    const store = await this.store(workspaceId)
    if (!store) {
      return this.completeStep(workspaceId, instance, step, isFinalStep)
    }
    const maxAttempts = (await this.deps.resolveRiskPolicy(workspaceId, block, instance))
      .ciMaxAttempts
    const { pairs, design } = await this.gatherPairs(workspaceId, instance, block, store)
    step.visualConfirm = {
      phase: 'awaiting_human',
      pairs,
      designReferences: design,
      attempts: 0,
      maxAttempts,
      rounds: [],
      // Gated on what was CAPTURED, never on how many rows the gallery has: a reference-only row
      // (a linked design's frame, an uploaded mock) makes a pair too, so counting rows would drop
      // this warning — and the approve-button acknowledgement it drives — for exactly the run that
      // needs it, one showing a reviewer nothing but the mocks they already had.
      ...(countCapturedViews(pairs) === 0
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
        if (vc) {
          const refreshed = await this.gatherPairs(
            workspaceId,
            instance,
            block,
            await this.store(workspaceId),
          )
          vc.pairs = refreshed.pairs
          vc.designReferences = refreshed.design
        }
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
    // The fixer pushes onto the PR branch, so it needs one to exist + an async executor. If
    // it can't run, DON'T silently swallow the human's findings: surface why on the gate (a
    // degraded reason + a recorded failed round) and re-park, so the human sees the request
    // didn't dispatch rather than the window quietly resetting.
    if (!isAsyncAgentExecutor(executor) || !block.pullRequest?.branch) {
      vc.degradedReason = !block.pullRequest?.branch
        ? 'Could not request a fix: this task has no open pull-request branch for the fixer to push to. Review the change manually, then approve.'
        : 'Could not request a fix: no async agent executor is wired in this runtime. Review the change manually, then approve.'
      vc.rounds = [
        ...(vc.rounds ?? []),
        {
          findings,
          helperKind: FIXER_AGENT_KIND,
          jobId: null,
          outcome: 'failed',
          at: this.deps.clockNow(),
        },
      ]
      return this.toAwaitingHuman(workspaceId, instance, step, block)
    }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    // Build the context AS the fixer, so trait-driven context (the `code-aware`
    // service-fragment fold) keys off the fixer's kind, not the hosting step's.
    const base = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
      { agentKind: FIXER_AGENT_KIND },
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
    recordDispatchedJob(step, handle, context.agentKind)
    step.subtasks = undefined
    // Leave the parked decision state: while the helper runs the step is `working` with a
    // live job, NOT parked on a stale approval (a re-drive would otherwise abandon the job).
    this.deps.stepGraph.startStep(step)
    step.approval = null
    vc.phase = 'fixing'
    // A fix is now in flight: clear any prior degraded note (e.g. a previous failed dispatch).
    vc.degradedReason = null
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
    await this.deps.stateMachine.persistAndEmit(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: handle.jobId, stepIndex: instance.currentStep }
  }

  /**
   * Gather actual-vs-reference pairs: the latest UI-tester report's screenshots, the frames the
   * task's linked DESIGNS retained, and the block's hand-uploaded references. The caller passes
   * the already-resolved per-account store (or null) so the gate's entry path doesn't resolve it
   * twice; the design summary comes back beside the pairs because "a design is linked and gave
   * nothing" is a fact only this read knows and only the gate state can carry.
   */
  private async gatherPairs(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    store: BinaryArtifactStore | null,
  ): Promise<{ pairs: VisualConfirmPair[]; design: VisualConfirmStepState['designReferences'] }> {
    const byView = new Map<string, VisualConfirmPair>()
    // The artifact ids the run ACTUALLY uploaded — so a screenshot id the agent reported but
    // that was never stored (a fabricated/typo'd id), or one since removed by the retention
    // sweep, is treated as "not captured" rather than rendered as a dangling/404 gallery image.
    const validActualIds = store
      ? new Set(
          (await store.listByExecution(workspaceId, instance.id))
            .filter((r) => r.kind === 'screenshot')
            .map((r) => r.id),
        )
      : null
    // Actual: the most recent `tester-ui` step's captured screenshots.
    const uiStep = [...instance.steps]
      .reverse()
      .find((s) => s.agentKind === UI_TESTER_AGENT_KIND && s.test?.lastReport)
    for (const shot of uiStep?.test?.lastReport?.screenshots ?? []) {
      const actualArtifactId =
        validActualIds === null || validActualIds.has(shot.artifactId) ? shot.artifactId : null
      byView.set(shot.view, {
        view: shot.view,
        actualArtifactId,
        // No `referenceOrigin`: a reference the CAPTURE named is one the gate did not source, so
        // it can say where it came from only by guessing. An absent origin is "unknown", which is
        // the honest answer and a different one from "a person uploaded this".
        referenceArtifactId: shot.referenceArtifactId ?? null,
      })
    }
    // Reference: the task's own reference set, the frames its linked DESIGNS retained plus the
    // images a person uploaded against it, already merged (an upload outranks a design frame for
    // the same view) by the one module both this gate and a capturing dispatch read it through.
    const { references, design } = await resolveBlockReferences(
      this.deps.documentRepository,
      store,
      workspaceId,
      block.id,
    )
    for (const ref of references) {
      const existing = byView.get(ref.view)
      if (!existing) {
        byView.set(ref.view, {
          view: ref.view,
          actualArtifactId: null,
          referenceArtifactId: ref.artifactId,
          referenceOrigin: ref.origin,
        })
        continue
      }
      // A reference the CAPTURE named for this view outranks a DESIGN frame: an explicitly chosen
      // reference beats a projection of whatever the linked file says today, and the design fold
      // cannot tell which of the two it would be replacing. It does NOT outrank an UPLOAD, which
      // is the more deliberate act of the two and the one a person takes to correct a pairing.
      if (ref.origin === 'design' && existing.referenceArtifactId) continue
      existing.referenceArtifactId = ref.artifactId
      existing.referenceOrigin = ref.origin
    }
    return { pairs: [...byView.values()], design }
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
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step, this.proposal(vc))
  }

  /** Finish the gate step and advance to the next step (or finish the run). */
  private async completeStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    this.deps.stateMachine.finishHumanGateStep(step)
    return this.deps.stateMachine.settleStepAndAdvance(workspaceId, instance, isFinalStep)
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
    const found = this.requireParked(await this.findParked(workspaceId, blockId))
    // Optimistic-concurrency human-action write (race-audit 2.2 controller-half): record the
    // intent under `mutateInstance` (load fresh → re-find the parked gate → mutate → CAS) so a
    // concurrent driver poll / a second human action can't be clobbered by a blind full-row
    // upsert. The signal + emit run once after, on the winning snapshot; the cap/parked guards
    // throw a domain error that propagates unretried.
    let approvalId = ''
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      found.instance.id,
      (inst) => {
        const step = inst.steps.find(
          (s) =>
            s.agentKind === VISUAL_CONFIRM_AGENT_KIND &&
            s.state === 'waiting_decision' &&
            s.approval?.status === 'pending',
        )
        if (!step?.visualConfirm || !step.approval) {
          throw new ConflictError('No visual-confirmation gate is currently awaiting input')
        }
        const vc = step.visualConfirm
        if (action.type === 'request-fix' && vc.attempts >= vc.maxAttempts) {
          throw new ConflictError(
            `This task has reached its fix-attempt limit (${vc.maxAttempts}); approve the change or review it manually.`,
          )
        }
        vc.pendingAction = action
        if (inst.status === 'blocked') inst.status = 'running'
        approvalId = step.approval.id
      },
    )
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(
      workspaceId,
      instance.id,
      approvalId,
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

  /**
   * How many screenshots this gate is asking a human to look at.
   *
   * The captured count, not the row count: a design frame or an uploaded mock makes a pair with
   * nothing captured against it, so summoning a reviewer to "5 captured screenshots" that are all
   * blank is the same misreading the degraded note above exists to prevent.
   */
  private capturedCount(vc: VisualConfirmStepState): number {
    return countCapturedViews(vc.pairs ?? [])
  }

  private proposal(vc: VisualConfirmStepState): string {
    const n = this.capturedCount(vc)
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
    const n = this.capturedCount(vc)
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
