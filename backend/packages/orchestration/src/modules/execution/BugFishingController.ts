import type {
  AddressBugFishingFindingsInput,
  Block,
  BlockRepository,
  BugFishingAgentOutput,
  BugFishingSpawn,
  BugFishingStepState,
  Clock,
  ExecutionInstance,
  ExecutionEventPublisher,
  ExecutionRepository,
  IdGenerator,
  Logger,
  PipelineRepository,
  PipelineStep,
  ServiceRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import {
  BUGFIX_PIPELINE_ID,
  ConflictError,
  NotFoundError,
  ValidationError,
  getErrorMessage,
  noopLogger,
  runBestEffort,
} from '@cat-factory/kernel'
import { BUG_FISHER_KIND } from '@cat-factory/agents'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import {
  coerceBugFishingFindings,
  dismissBugFishingFinding,
  failBugFishingPhase,
  planBugFishingPhases,
  recordBugFishingPhase,
  recordBugFishingSpawn,
  untriagedBugFishingFindings,
} from './bugFishing.logic.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

/** The step kind the bug-fishing phase loop runs on (the read-only expedition agent). */
export const BUG_FISHING_STEP_KIND = BUG_FISHER_KIND

/** What the bug-fishing controller needs beyond the shared run state-machine spine. */
export interface BugFishingControllerDeps {
  executionRepository: ExecutionRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  /**
   * Where a board's default fix pipeline lives. Optional for the same reason the verification
   * report's read of it is: a deployment that wires no settings store has no configured default,
   * which is a different fact from a store that cannot be read (see
   * {@link BugFishingController.resolveDefaultFixPipelineId}).
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /** The async instance/block spine (park/advance/persist/emit/progress). */
  stateMachine: RunStateMachine
  /** The pure step mutators (start/finish/pause a step). */
  stepGraph: StepGraph
  idGenerator: IdGenerator
  clock: Clock
  /** Resolves the frame block's service row, so a spawned task lands in the right service. */
  serviceRepository?: ServiceRepository
  /** Bound `ExecutionService.start` — a spawned fix starts through the real entry point. */
  start: (
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    opts: { initiatedBy: string | null },
  ) => Promise<{ id: string } | unknown>
  /** Board fan-out, so a spawned task appears on open boards without a refresh. */
  events?: ExecutionEventPublisher
  /** Optional inbox channel; when unwired the `bug_fishing_triage` card is skipped. */
  notificationService?: NotificationService
  logger?: Logger
}

/**
 * Drives the BUG-FISHING EXPEDITION: the read-only `bug-fisher` agent's phase loop, the human
 * triage that follows it, and the bug-fix tasks that triage spawns.
 *
 * The shape is the Ralph loop's (one step, dispatched repeatedly) joined to the PR review's
 * (park, then let a human act on findings). {@link recordPhaseResult} runs as the completion
 * interceptor's body: it stamps the finished pass's findings onto `step.bugFishing` and either
 * RE-ARMS the same step for the next angle or, once every angle has settled, parks the run for
 * triage. {@link address} spawns a bug-fix task per marked finding, and {@link resolve} finishes
 * the parked expedition.
 *
 * Two properties are worth stating because they are what the design is FOR:
 *
 * - **Marking does not wait for the expedition.** {@link address} accepts findings while later
 *   angles are still fishing. That is the whole reason the angles run as separate dispatches
 *   rather than as one prompt: a human who reads the concurrency pass at minute six should be
 *   able to start its fix then, not after the requirements pass finishes at minute forty.
 * - **A failed angle costs only that angle.** The passes share nothing but the checkout, so
 *   {@link recordPhaseFailure} settles the one that died with its reason on the record and moves
 *   to the next, rather than failing a run that has already caught something.
 *
 * All expedition state rides the run's `bug-fisher` step (`step.bugFishing`) — no side table —
 * so it is runtime-symmetric by construction, exactly like `prReview` / `forkDecision`.
 */
export class BugFishingController {
  private readonly log: Logger

  constructor(private readonly deps: BugFishingControllerDeps) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * The expedition state a `bug-fisher` step should carry on THIS dispatch, seeded on first
   * entry from the task's angle selection and the workspace's fix-pipeline default.
   *
   * Called by the step handler before dispatching, and idempotent: a step that already carries
   * an expedition (every dispatch after the first, and every durable replay of the first) keeps
   * it, because re-planning would discard the phases already fished.
   *
   * Returns null when the block plans no angles at all, which the handler renders as a
   * `skipped` pass-through rather than a run that parks with nothing to triage.
   */
  async ensurePlanned(
    workspaceId: string,
    step: PipelineStep,
    block: Block,
  ): Promise<BugFishingStepState | null> {
    if (step.bugFishing) return step.bugFishing
    const { phases, unknown } = planBugFishingPhases(block.taskTypeFields?.fishingPhaseIds)
    if (unknown.length > 0) {
      // Named, never silently dropped: the person picked angles this build no longer ships, and
      // an expedition that quietly fished fewer than they asked for reads as one that found
      // nothing under those angles.
      this.log.warn('bugFishing.unknownAnglesDropped', {
        workspaceId,
        blockId: block.id,
        unknown,
      })
    }
    if (phases.length === 0) return null
    return {
      status: 'fishing',
      phases,
      currentPhaseIndex: 0,
      findings: [],
      model: null,
      defaultFixPipelineId: await this.resolveDefaultFixPipelineId(workspaceId),
    }
  }

  /**
   * Record a COMPLETED pass and decide the flow. Runs as the completion interceptor's body
   * (short-circuiting `recordStepResult` when it parks or loops).
   *
   * With angles left: stamp the findings, re-arm the SAME step and return `continue`, so the
   * durable driver re-enters and dispatches the next angle (the dispatch epoch gives it a job id
   * of its own — see `dispatchEpochFor`). With the last angle settled: park on a durable
   * decision-wait and raise the triage card. An expedition that caught nothing at all still
   * parks: "we looked from eight angles and found nothing" is the answer a human asked for, and
   * advancing silently past it would present that as no answer.
   *
   * Idempotent against a durable replay: a step whose expedition is no longer `fishing` has
   * already been recorded, so it falls through to whatever its status says.
   */
  async recordPhaseResult(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    output: BugFishingAgentOutput | undefined,
    model: string | null | undefined,
    block: Block | null | undefined,
  ): Promise<AdvanceResult | null> {
    const state = step.bugFishing
    if (!state) return null
    if (state.status !== 'fishing') {
      // Already settled by an earlier pass of this interceptor (a durable retry / replay). Keep a
      // parked expedition parked rather than re-recording, which would re-mint finding ids a
      // human may be mid-triage on.
      if (state.status === 'awaiting_triage') {
        return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
      }
      return null
    }
    const phaseIndex = state.currentPhaseIndex ?? 0
    const phase = (state.phases ?? [])[phaseIndex]
    if (!phase) {
      // The cursor is past the plan: nothing left to record. Park so the catch is triaged rather
      // than advancing past findings nobody has seen.
      step.bugFishing = { ...state, status: 'awaiting_triage' }
      return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
    }
    const { findings, dropped } = coerceBugFishingFindings(output, phase.id, () =>
      this.deps.idGenerator.next('bff'),
    )
    const next = recordBugFishingPhase(state, phaseIndex, {
      summary: output?.summary ?? null,
      findings,
      dropped,
      at: this.deps.clock.now(),
    })
    step.bugFishing = { ...next, model: model ?? next.model ?? null }
    // The pass's own findings are already on the step; the raw structured blob would render a
    // second, unstamped copy in the generic viewer.
    step.custom = undefined
    if (step.bugFishing.status === 'fishing')
      return this.rearmForNextPhase(workspaceId, instance, step)
    await this.raiseTriageReady(workspaceId, instance, block, step.bugFishing)
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
  }

  /**
   * Settle a pass whose container job FAILED, then carry on with the next angle.
   *
   * Run from the driver's failed-job path (the analogue of the PR-review challenge failure
   * branch). The angles are independent by construction, so one crashing must not cost the
   * expedition the passes that already landed nor the ones still to come; the failure is NAMED
   * on the phase, because a phase that silently reported nothing is indistinguishable from a
   * phase that honestly found nothing. Returns null when the step carries no live expedition, so
   * an ordinary failure still fails the run.
   */
  async recordPhaseFailure(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    reason: string | null,
    block: Block | null | undefined,
  ): Promise<AdvanceResult | null> {
    const state = step.bugFishing
    if (!state || state.status !== 'fishing') return null
    const next = failBugFishingPhase(
      state,
      state.currentPhaseIndex ?? 0,
      reason,
      this.deps.clock.now(),
    )
    step.bugFishing = next
    step.custom = undefined
    if (next.status === 'fishing') return this.rearmForNextPhase(workspaceId, instance, step)
    await this.raiseTriageReady(workspaceId, instance, block, next)
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
  }

  /**
   * Re-arm the `bug-fisher` step for the NEXT angle and let the driver re-enter.
   *
   * `resetStepForRerun` clears the job handle (which is what makes the driver dispatch again on
   * re-entry) while deliberately leaving `bugFishing` alone — the state is the accumulated catch,
   * and clearing it would throw away every pass before this one. The container is reclaimed
   * first so the next angle boots a fresh context: a container-reusing transport would otherwise
   * re-attach to the finished job and replay its result, which reads as an angle that found
   * exactly what the previous one did.
   */
  private async rearmForNextPhase(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<AdvanceResult> {
    await this.deps.stateMachine.stopRunContainer(workspaceId, instance)
    this.deps.stepGraph.resetStepForRerun(step)
    this.deps.stepGraph.startStep(step)
    await this.deps.stateMachine.persistAndEmit(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * MARK findings to be addressed: spawn a bug-fix task per finding, linked to the expedition.
   *
   * Accepted while the expedition is still fishing later angles as well as once it has parked —
   * see the class doc for why that is the point rather than a convenience.
   *
   * Order of operations per finding, and why: the block is inserted, its run started, and only
   * then is the spawn recorded onto the expedition. So a failure mid-way leaves a task a human
   * can see and start by hand, never a finding that CLAIMS a task that does not exist. The
   * spawn record is the finding's own "this is being fixed" state, so writing it before the work
   * existed would be the platform reporting work it had not done.
   *
   * The pipeline is resolved ONCE for the whole batch and validated against the workspace's
   * catalog before anything is created: a caller naming a pipeline that does not exist gets a
   * refusal naming it, rather than N tasks pinned to a pipeline nothing can run.
   */
  async address(
    workspaceId: string,
    executionId: string,
    input: AddressBugFishingFindingsInput,
    initiatedBy: string | null,
  ): Promise<BugFishingStepState> {
    const instance = await this.deps.executionRepository.get(workspaceId, executionId)
    if (!instance) throw new NotFoundError('Run', executionId)
    const step = this.activeExpeditionStep(instance)
    const state = step?.bugFishing
    if (!step || !state) {
      throw new ConflictError('This run has no bug-fishing expedition to triage.', 'no_expedition')
    }
    const requested = new Set(input.findingIds)
    const targets = (state.findings ?? []).filter((f) => requested.has(f.id))
    const missing = [...requested].filter((id) => !targets.some((f) => f.id === id))
    if (missing.length > 0) {
      throw new ValidationError('Some findings are no longer part of this expedition.', {
        reason: 'unknown_finding',
        findingIds: missing,
      })
    }
    const already = targets.filter((f) => f.spawn)
    if (already.length > 0) {
      throw new ConflictError(
        'Some of those findings already have a fix task.',
        'already_addressed',
        { findingIds: already.map((f) => f.id) },
      )
    }
    const pipelineId = await this.resolveSpawnPipelineId(workspaceId, input.pipelineId, state)
    const { frame, serviceId } = await this.resolveSpawnHost(workspaceId, instance.blockId)

    let latest = state
    for (const finding of targets) {
      const spawned = await this.spawnFixTask(workspaceId, {
        expeditionBlockId: instance.blockId,
        frame,
        serviceId,
        finding,
        pipelineId,
        initiatedBy,
      })
      // Persist the spawn on the run under CAS, one finding at a time: a batch that fails
      // half-way has still recorded the tasks it did create, which is what stops a retry of the
      // same request from spawning them twice.
      const persisted = await this.deps.stateMachine.mutateInstance(
        workspaceId,
        executionId,
        (inst) => {
          const live = this.activeExpeditionStep(inst)
          if (!live?.bugFishing) return
          live.bugFishing = recordBugFishingSpawn(live.bugFishing, finding.id, spawned)
        },
      )
      latest = this.activeExpeditionStep(persisted)?.bugFishing ?? latest
    }
    const emitted = await this.deps.executionRepository.get(workspaceId, executionId)
    if (emitted) await this.deps.stateMachine.emitInstance(workspaceId, emitted)
    return latest
  }

  /**
   * Dismiss a finding: it stays on the expedition's record, struck through, and can no longer be
   * marked. A curation action, not a resolution — the run stays exactly where it is, whether it
   * is still fishing or already parked.
   */
  async dismissFinding(
    workspaceId: string,
    executionId: string,
    findingId: string,
  ): Promise<BugFishingStepState> {
    let state: BugFishingStepState | undefined
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const step = this.activeExpeditionStep(inst)
        if (!step?.bugFishing) {
          throw new ConflictError(
            'This run has no bug-fishing expedition to triage.',
            'no_expedition',
          )
        }
        step.bugFishing = dismissBugFishingFinding(step.bugFishing, findingId)
        state = step.bugFishing
      },
    )
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return state!
  }

  /**
   * Finish a parked expedition: mark it `done` and advance the run past the step.
   *
   * Mirrors the review gate's resolved-gate advance — the pure in-memory advance runs inside the
   * CAS, its side effects (settle / emit) once after, on the winning snapshot. Findings left
   * untriaged are left as they are: they stay on the run's record, and the expedition's own
   * state is the honest account of what was decided and what was not.
   */
  async resolve(workspaceId: string, executionId: string): Promise<BugFishingStepState> {
    let stepIndex = -1
    let state: BugFishingStepState | undefined
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const index = inst.steps.findIndex(
          (s) =>
            s.agentKind === BUG_FISHING_STEP_KIND &&
            s.state === 'waiting_decision' &&
            s.approval?.status === 'pending' &&
            s.bugFishing?.status === 'awaiting_triage',
        )
        const step = index === -1 ? undefined : inst.steps[index]
        if (!step?.approval || !step.bugFishing) {
          throw new ConflictError(
            'The run is no longer awaiting a bug-fishing triage.',
            'not_awaiting_triage',
          )
        }
        stepIndex = index
        step.bugFishing = { ...step.bugFishing, status: 'done' }
        step.approval.status = 'approved'
        this.deps.stateMachine.advanceRunPastGate(inst, index)
        state = step.bugFishing
      },
    )
    await this.deps.stateMachine.clearWaitingNotification(workspaceId, instance)
    if (stepIndex !== -1) {
      await this.deps.stateMachine.settleAdvancedGate(workspaceId, instance, stepIndex)
    }
    return state!
  }

  /** The active expedition state for a run's GET, or null when no step carries one. */
  async getActive(workspaceId: string, executionId: string): Promise<BugFishingStepState | null> {
    const instance = await this.deps.executionRepository.get(workspaceId, executionId)
    if (!instance) return null
    return this.activeExpeditionStep(instance)?.bugFishing ?? null
  }

  /**
   * The run's "active" expedition step: prefer the step the run is currently on, else the latest
   * `bug-fisher` step carrying expedition state. Mirrors `PrReviewController.activePrReviewStep`.
   */
  private activeExpeditionStep(instance: ExecutionInstance): PipelineStep | undefined {
    const current = instance.steps[instance.currentStep]
    if (current?.agentKind === BUG_FISHING_STEP_KIND && current.bugFishing) return current
    for (let i = instance.steps.length - 1; i >= 0; i--) {
      const s = instance.steps[i]!
      if (s.agentKind === BUG_FISHING_STEP_KIND && s.bugFishing) return s
    }
    return undefined
  }

  // ---- Spawning the fix tasks ---------------------------------------------

  /**
   * The pipeline a marked finding's task runs: the caller's override, else the expedition's
   * recorded default, else the workspace setting as it stands now, else the built-in bug-fix
   * preset — and in every case validated against the workspace's own catalog.
   *
   * Validated rather than trusted because both the override and the workspace setting are bare
   * ids a human typed or picked, and a workspace can delete the pipeline it named. Spawning onto
   * a missing pipeline would create tasks that cannot start, so the refusal NAMES the pipeline
   * instead: which one is missing is the whole content of the fix.
   */
  private async resolveSpawnPipelineId(
    workspaceId: string,
    override: string | undefined,
    state: BugFishingStepState,
  ): Promise<string> {
    const wanted =
      override?.trim() ||
      state.defaultFixPipelineId ||
      (await this.resolveDefaultFixPipelineId(workspaceId))
    const pipeline = await this.deps.pipelineRepository.get(workspaceId, wanted)
    if (!pipeline) {
      throw new ValidationError(
        `Pipeline "${wanted}" no longer exists — pick another for the spawned fix tasks.`,
        { reason: 'pipeline_not_found', pipelineId: wanted },
      )
    }
    return pipeline.id
  }

  /**
   * The workspace's configured fix pipeline, else the built-in bug-fix preset.
   *
   * A settings read that THROWS is deliberately NOT swallowed into the built-in default: an
   * unreachable settings store and a workspace that configured nothing are opposite facts, and
   * silently spawning onto the platform preset would put a team's bug work on a pipeline they
   * moved off. An UNWIRED store is the third case and genuinely does mean "no configured
   * default", so that one answers the built-in.
   */
  private async resolveDefaultFixPipelineId(workspaceId: string): Promise<string> {
    if (!this.deps.workspaceSettingsRepository) return BUGFIX_PIPELINE_ID
    const settings = await this.deps.workspaceSettingsRepository.get(workspaceId)
    return settings?.bugFishingFixPipelineId?.trim() || BUGFIX_PIPELINE_ID
  }

  /**
   * The frame a spawned fix task lives under, and its service row.
   *
   * The expedition's OWN parent frame, so the fix runs against the same repository the
   * expedition fished. A task whose frame cannot be resolved has nothing to host the work and no
   * repo to fix, so this refuses rather than dropping the task somewhere plausible.
   */
  private async resolveSpawnHost(
    workspaceId: string,
    expeditionBlockId: string,
  ): Promise<{ frame: Block; serviceId: string | null }> {
    const anchor = await this.deps.blockRepository.get(workspaceId, expeditionBlockId)
    const frame = anchor?.parentId
      ? await this.deps.blockRepository.get(workspaceId, anchor.parentId)
      : null
    if (!frame) {
      throw new ConflictError(
        'This expedition is not under a service, so there is nowhere to put a fix task.',
        'no_host_frame',
      )
    }
    const serviceId = this.deps.serviceRepository
      ? ((await this.deps.serviceRepository.getByFrameBlock(frame.id))?.id ?? null)
      : null
    return { frame, serviceId }
  }

  /**
   * Create ONE bug-fix task for a finding and start its run, returning the spawn record.
   *
   * The task is a `bug`-typed block carrying the finding as its description and its evidence as
   * the reproduction field, so the bug-fix pipeline's investigator starts from what the
   * expedition actually found rather than from a title. On a start failure the block is rolled
   * back, exactly as the initiative loop does: a task on the board with no run and no record on
   * either side is the one outcome nothing later reconciles.
   *
   * A failure PROPAGATES rather than being swallowed into "this finding stays untriaged". The
   * marking is the caller's own request, not a best-effort background pass, and the failures that
   * reach here are exactly the ones they can act on: a pipeline that refuses a one-off task
   * start, a per-service task limit, a board write that was denied. Answering 200 with an
   * unchanged finding would report the request as done and leave somebody waiting for a fix task
   * that is never going to appear. Findings spawned EARLIER in the batch are already persisted,
   * so the error names what is left rather than undoing what worked.
   */
  private async spawnFixTask(
    workspaceId: string,
    input: {
      expeditionBlockId: string
      frame: Block
      serviceId: string | null
      finding: BugFishingStepState['findings'][number]
      pipelineId: string
      initiatedBy: string | null
    },
  ): Promise<BugFishingSpawn> {
    const { finding, frame } = input
    const blockId = this.deps.idGenerator.next('blk')
    const block: Block = {
      id: blockId,
      title: finding.title || 'Bug-fishing finding',
      // Inherit the host frame's behavioural repo type, like `BoardService.addTask`.
      type: frame.type,
      description: renderFindingBrief(finding),
      position: { x: 24, y: 96 },
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: frame.id,
      expeditionId: input.expeditionBlockId,
      taskType: 'bug',
      taskTypeFields: {
        severity: finding.severity,
        ...(finding.failureScenario ? { stepsToReproduce: finding.failureScenario } : {}),
      },
      pipelineId: input.pipelineId,
    }
    await this.deps.blockRepository.insert(workspaceId, block, input.serviceId)
    let executionId: string | null = null
    try {
      const started = await this.deps.start(workspaceId, blockId, input.pipelineId, {
        initiatedBy: input.initiatedBy,
      })
      executionId = readExecutionId(started)
    } catch (error) {
      await runBestEffort(
        this.log,
        'bugFishing.rollbackSpawnedBlock',
        () => this.deps.blockRepository.deleteMany(workspaceId, [blockId]),
        { workspaceId, blockId, findingId: finding.id },
      )
      this.log.warn('bugFishing.spawnStartFailed', {
        workspaceId,
        findingId: finding.id,
        pipelineId: input.pipelineId,
        error: getErrorMessage(error),
      })
      throw error
    }
    // Announced only once the run has started, for the reason the initiative loop's spawn states:
    // past the start there is nothing left to roll back, so a failing fan-out must not delete a
    // block whose run is live. Best-effort; the board reconciles a missed push on its next
    // snapshot.
    await runBestEffort(
      this.log,
      'bugFishing.announceSpawnedBlock',
      () =>
        this.deps.events?.boardChanged(workspaceId, { reason: 'block-added', block }) ??
        Promise.resolve(),
      { workspaceId, blockId, findingId: finding.id },
    )
    return {
      taskId: blockId,
      executionId,
      pipelineId: input.pipelineId,
      requestedBy: input.initiatedBy,
      requestedAt: this.deps.clock.now(),
    }
  }

  /** Raise the "finish triaging the catch" inbox card when the expedition parks. */
  private async raiseTriageReady(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block | null | undefined,
    state: BugFishingStepState,
  ): Promise<void> {
    if (!this.deps.notificationService || !block) return
    const untriaged = untriagedBugFishingFindings(state).length
    const phases = (state.phases ?? []).length
    await this.deps.notificationService.raise(workspaceId, {
      type: 'bug_fishing_triage',
      blockId: block.id,
      executionId: instance.id,
      title:
        untriaged === 0
          ? `"${block.title}" — the expedition finished with nothing left to triage`
          : `"${block.title}" — ${untriaged} bug-fishing finding${untriaged === 1 ? '' : 's'} to triage`,
      body:
        `The expedition fished ${phases} angle${phases === 1 ? '' : 's'} of this codebase. Open ` +
        'the task to review what it caught and mark the findings worth fixing — each one you ' +
        'mark becomes its own bug-fix task.',
      payload: {
        pipelineName: instance.pipelineName,
        phaseCount: phases,
        untriagedFindingCount: untriaged,
      },
    })
  }
}

/**
 * The description a spawned fix task carries: the finding, in the shape the bug-fix pipeline's
 * investigator reads a bug report in.
 *
 * The evidence and the suggested fix are labelled as the EXPEDITION's, not asserted as fact: they
 * are one agent's reading of the code, and the investigator that picks the task up is supposed to
 * confirm or reject them rather than treat them as the brief.
 */
function renderFindingBrief(finding: BugFishingStepState['findings'][number]): string {
  const lines = [finding.detail]
  if (finding.path) {
    lines.push('', `Where: \`${finding.path}\`${finding.line ? ` line ${finding.line}` : ''}`)
  }
  if (finding.failureScenario) lines.push('', `How it fires: ${finding.failureScenario}`)
  if (finding.evidence) {
    lines.push('', 'Evidence the bug-fishing expedition cited (verify it before relying on it):')
    lines.push(finding.evidence)
  }
  if (finding.suggestedFix) {
    lines.push('', `The expedition suggested: ${finding.suggestedFix}`)
  }
  lines.push(
    '',
    `Found by a bug-fishing expedition (${finding.kind}, ${finding.confidence} confidence).`,
  )
  return lines.join('\n')
}

/**
 * The execution id of a started run, when the start entry point reported one.
 *
 * `start` is bound from `ExecutionService` through a callback so the controller does not depend
 * on the engine service that owns it, which costs the return type its shape. Null is a legitimate
 * answer rather than a failure: the task exists and is running either way, and the id is only
 * used to deep-link the spawned run from the expedition window.
 */
function readExecutionId(started: unknown): string | null {
  if (started && typeof started === 'object' && 'id' in started) {
    const id = (started as { id: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}
