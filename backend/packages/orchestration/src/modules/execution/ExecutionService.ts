import type {
  AgentFailure,
  AgentFailureKind,
  Block,
  BlueprintService,
  CiStatusProvider,
  ExecutionInstance,
  MergeAssessment,
  MergePresetRepository,
  PipelineStep,
  PullRequestMerger,
  PullRequestMergeabilityProvider,
} from '@cat-factory/kernel'
import { parseBlueprintService, parseMergeAssessment } from '@cat-factory/contracts'
import {
  assertFound,
  ConflictError,
  getErrorMessage,
  NotFoundError,
  sameSubtasks,
} from '@cat-factory/kernel'
import { DEFAULT_MERGE_PRESET } from '@cat-factory/kernel'
import {
  aggregateCi,
  CI_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  describeFailingChecks,
  isCiGreen,
  MERGER_AGENT_KIND,
} from './ci.logic.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { LlmObservabilityService } from '../observability/LlmObservabilityService.js'
import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { AgentExecutor, AgentRunContext, AgentRunResult } from '@cat-factory/kernel'
import { isAsyncAgentExecutor } from '@cat-factory/kernel'
import type { WorkRunner } from '@cat-factory/kernel'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import type { DocumentRepository } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import type { FragmentResolver } from '@cat-factory/kernel'
import type { EnvironmentProvisioningService } from '@cat-factory/integrations'
import { isDeployStep } from '@cat-factory/integrations'
import { descendantIds, serviceOf } from '../board/board.logic.js'
import type { BoardService } from '../board/BoardService.js'
import type { SpendService } from '@cat-factory/spend'
import { requireWorkspace } from '@cat-factory/kernel'
import type { AdvanceOptions, AdvanceResult } from './advance.js'
import { planResumedSteps } from './retry.logic.js'
import { isContainerEvictionError, MAX_EVICTION_RECOVERIES } from './job.logic.js'

/**
 * "What to do next" guidance per failure kind a pipeline run can produce, shown
 * under the failure banner on the board (mirrors bootstrap's FAILURE_HINTS). Only
 * the execution-relevant subset of {@link AgentFailureKind} is keyed.
 */
const EXECUTION_FAILURE_HINTS: Partial<Record<AgentFailureKind, string>> = {
  agent:
    'An agent step failed after its automatic retries. Review the run, then retry to re-run the pipeline.',
  job_failed:
    'The implementation container reported a failure. Inspect its logs (Cloudflare Workers Observability, filtered by the run id), then retry to spin a fresh container.',
  evicted:
    'The implementation container was evicted or crashed repeatedly (it kept vanishing mid-run even after an automatic fresh-container restart). This is often a memory/crash issue on the run — inspect its logs (Cloudflare Workers Observability, filtered by the run id); a heavier container instance type may be needed. Retry to try again.',
  timeout:
    'The run exceeded its time budget — a step or the implementation job did not finish in time. Retry to start it again.',
  decision_timeout:
    'A required decision was not answered in time, so the run was stopped. Retry to re-run the pipeline.',
  cancelled: 'You stopped this run; its container was killed. Retry to start it again.',
  unknown: 'The run failed for an unclassified reason. Review the run, then retry.',
}

/** Format a 0..1 score as a rounded percentage for notification copy. */
function pct(score: number): string {
  return `${Math.round(score * 100)}%`
}

export interface ExecutionServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  idGenerator: IdGenerator
  clock: Clock
  agentExecutor: AgentExecutor
  workRunner: WorkRunner
  executionEventPublisher: ExecutionEventPublisher
  boardService: BoardService
  spendService: SpendService
  /**
   * Optional: when the document-source integration is configured, documents
   * linked to a block are resolved here and fed to the agent as extra context.
   */
  documentRepository?: DocumentRepository
  /**
   * Optional: when the task-source integration is configured, tracker issues
   * linked to a block are resolved here and fed to the agent as extra context.
   */
  taskRepository?: TaskRepository
  /**
   * Optional: when the environment integration is configured, a `deployer` step
   * provisions an ephemeral environment deterministically through this service
   * (no LLM), and downstream steps discover the resulting env via it.
   */
  environmentProvisioning?: EnvironmentProvisioningService
  /**
   * Optional: when the prompt-fragment library is configured, this resolves the
   * relevant best-practice fragments to fold into each agent's system prompt —
   * the merged tenant catalog selected per run (ADR 0006). Applies to every agent
   * kind. Absent → the engine uses the block's manual `fragmentIds` unchanged.
   */
  fragmentResolver?: FragmentResolver
  /**
   * Optional: when the board-scan module is configured, a `blueprints` step's
   * decomposition tree is reconciled onto the board through this (BoardScanService).
   * Absent → a blueprint step still runs and commits its in-repo files, but the
   * board isn't auto-updated from it.
   */
  blueprintReconciler?: BlueprintReconciler
  /**
   * Optional: raises human-actionable notifications (a PR needs a merge decision,
   * a no-merger pipeline finished, CI fixing gave up). Absent → those events still
   * transition the block but no notification surfaces (tests).
   */
  notificationService?: NotificationService
  /**
   * Optional: reads a block's CI check runs so the `ci` step can gate the PR on
   * green CI. Absent → the `ci` step is a pass-through (nothing to gate), so the
   * engine works unchanged when GitHub CI isn't wired.
   */
  ciStatusProvider?: CiStatusProvider
  /**
   * Optional: reads a block's PR mergeability so the `conflicts` step can gate the
   * PR on being mergeable. Absent → the `conflicts` step is a pass-through (nothing
   * to gate), so the engine works unchanged when GitHub isn't wired.
   */
  mergeabilityProvider?: PullRequestMergeabilityProvider
  /**
   * Optional: performs the real GitHub merge when a task should become `done`.
   * Absent → `done` is a board-only flip (tests); when wired, `done` provably
   * means the PR was merged on the remote.
   */
  pullRequestMerger?: PullRequestMerger
  /**
   * Optional: resolves a task's merge threshold preset (auto-merge ceilings + the
   * CI-fixer attempt budget). Absent → the built-in {@link DEFAULT_MERGE_PRESET}.
   */
  mergePresetRepository?: MergePresetRepository
  /**
   * Optional: the LLM observability sink. When wired, each emit rolls the per-run
   * model-call aggregates onto the matching pipeline steps (`step.metrics`) so the
   * board shows tokens / output-limit headroom / transport-vs-execution latency
   * live. Absent (tests / unconfigured) → steps carry no `metrics`.
   */
  llmObservability?: LlmObservabilityService
}

/** Reconciles a Blueprinter step's tree onto the board in place (BoardScanService). */
export interface BlueprintReconciler {
  reconcileBlueprint(
    workspaceId: string,
    frameId: string | null,
    service: BlueprintService,
  ): Promise<unknown>
}

/**
 * The execution engine. It orchestrates a pipeline of agent-performed steps and
 * is fully deterministic: `advanceInstance` moves one run forward by exactly one
 * step, delegating the actual work — and the choice of whether to pause for a
 * human decision — to the injected {@link AgentExecutor}. The durable workflow
 * driver calls it in a loop. All LLM behaviour lives behind that port, so the
 * engine here can be tested with a
 * deterministic fake and no timing/delays.
 */
export class ExecutionService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly executionRepository: ExecutionRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly agentExecutor: AgentExecutor
  private readonly workRunner: WorkRunner
  private readonly events: ExecutionEventPublisher
  private readonly board: BoardService
  private readonly spend: SpendService
  private readonly documents?: DocumentRepository
  private readonly tasks?: TaskRepository
  private readonly environmentProvisioning?: EnvironmentProvisioningService
  private readonly fragmentResolver?: FragmentResolver
  private readonly blueprintReconciler?: BlueprintReconciler
  private readonly notificationService?: NotificationService
  private readonly llmObservability?: LlmObservabilityService
  private readonly ciStatusProvider?: CiStatusProvider
  private readonly mergeabilityProvider?: PullRequestMergeabilityProvider
  private readonly prMerger?: PullRequestMerger
  private readonly mergePresetRepository?: MergePresetRepository

  constructor({
    workspaceRepository,
    blockRepository,
    pipelineRepository,
    executionRepository,
    idGenerator,
    clock,
    agentExecutor,
    workRunner,
    executionEventPublisher,
    boardService,
    spendService,
    documentRepository,
    taskRepository,
    environmentProvisioning,
    fragmentResolver,
    blueprintReconciler,
    notificationService,
    llmObservability,
    ciStatusProvider,
    mergeabilityProvider,
    pullRequestMerger,
    mergePresetRepository,
  }: ExecutionServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.pipelineRepository = pipelineRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.agentExecutor = agentExecutor
    this.workRunner = workRunner
    this.events = executionEventPublisher
    this.board = boardService
    this.spend = spendService
    this.documents = documentRepository
    this.tasks = taskRepository
    this.environmentProvisioning = environmentProvisioning
    this.fragmentResolver = fragmentResolver
    this.blueprintReconciler = blueprintReconciler
    this.notificationService = notificationService
    this.llmObservability = llmObservability
    this.ciStatusProvider = ciStatusProvider
    this.mergeabilityProvider = mergeabilityProvider
    this.prMerger = pullRequestMerger
    this.mergePresetRepository = mergePresetRepository
  }

  private requireWorkspace(workspaceId: string) {
    return requireWorkspace(this.workspaceRepository, workspaceId)
  }

  private async requireBlock(workspaceId: string, id: string): Promise<Block> {
    return assertFound(await this.blockRepository.get(workspaceId, id), 'Block', id)
  }

  /** Start a pipeline against a block, replacing any prior run on it. */
  async start(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    await this.requireBlock(workspaceId, blockId)
    const pipeline = assertFound(
      await this.pipelineRepository.get(workspaceId, pipelineId),
      'Pipeline',
      pipelineId,
    )

    await this.executionRepository.deleteByBlock(workspaceId, blockId)

    const steps: PipelineStep[] = pipeline.agentKinds.map((kind, i) => ({
      agentKind: kind,
      state: i === 0 ? 'working' : 'pending',
      progress: 0,
      decision: null,
      // A gated step pauses for human approval once its proposal is ready (see
      // recordStepResult). Copied from the pipeline definition at run start.
      requiresApproval: pipeline.gates?.[i] ?? false,
      approval: null,
    }))
    const instance: ExecutionInstance = {
      id: this.idGenerator.next('exec'),
      blockId,
      pipelineId: pipeline.id,
      pipelineName: pipeline.name,
      steps,
      currentStep: 0,
      status: 'running',
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.blockRepository.update(workspaceId, blockId, {
      status: 'in_progress',
      progress: 0,
      executionId: instance.id,
    })
    // Hand the run off to the durable runner so it progresses server-side without
    // a browser open. With the no-op runner (tests) this does nothing and the run
    // is advanced directly via advanceInstance.
    await this.workRunner.startRun(workspaceId, instance.id)
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Advance a single run by exactly one step and report what happened. This is
   * the durable driver's entry point: it reloads the run from storage (so it is
   * safe under replay/retry), no-ops unless the run is actively running, and
   * otherwise performs one agent step via the shared {@link stepInstance} logic.
   */
  async advanceInstance(
    workspaceId: string,
    executionId: string,
    options: AdvanceOptions = {},
  ): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    // A paused run is still drivable: the spend gate in stepInstance resumes it
    // once the budget frees up (or re-pauses it otherwise).
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    return this.stepInstance(workspaceId, instance, options)
  }

  /** Advance a single running instance by one step, persisting the result. */
  private async stepInstance(
    workspaceId: string,
    instance: ExecutionInstance,
    options: AdvanceOptions = {},
  ): Promise<AdvanceResult> {
    const step = instance.steps[instance.currentStep]
    if (!step) return { kind: 'noop' }

    // Spend gate: don't incur LLM cost once the budget is exhausted. Pause the
    // run (so the frontend can flag it) and stop here. A previously-paused run
    // that finds the budget has freed up resumes and proceeds.
    if (await this.spend.isOverBudget()) {
      if (instance.status !== 'paused') {
        instance.status = 'paused'
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
      }
      return { kind: 'paused' }
    }
    if (instance.status === 'paused') instance.status = 'running'

    if (step.state === 'waiting_decision') {
      // Parked on either an agent-raised decision or a human approval gate; both
      // are addressed by the same durable event id.
      const pendingId = step.decision?.id ?? step.approval?.id
      if (pendingId) {
        instance.status = 'blocked'
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
        return { kind: 'awaiting_decision', decisionId: pendingId }
      }
    }
    this.startStep(step)

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1

    // A `deployer` step provisions an ephemeral environment deterministically via
    // the provider — no LLM, no token usage — when the integration is wired.
    // Otherwise it falls through to the normal agent path.
    if (this.environmentProvisioning && isDeployStep(step.agentKind)) {
      const result = await this.runDeployer(workspaceId, instance, block, options)
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
    }

    // A `ci` step gates the PR on green CI: it polls GitHub check runs and, on
    // failure, dispatches the `ci-fixer` container agent — no LLM of its own. It
    // is a pass-through when no CI status provider is wired (the engine works
    // unchanged without GitHub CI). See {@link evaluateCi}.
    if (step.agentKind === CI_AGENT_KIND) {
      return this.evaluateCi(workspaceId, instance, step, block, isFinalStep)
    }

    // A `conflicts` step gates the PR on being mergeable: it checks the PR's
    // mergeability and, on a conflict, dispatches the `conflict-resolver` container
    // agent — no LLM of its own. Pass-through when no mergeability provider is wired.
    // See {@link evaluateConflicts}.
    if (step.agentKind === CONFLICTS_AGENT_KIND) {
      return this.evaluateConflicts(workspaceId, instance, step, block, isFinalStep)
    }

    // Async (container) steps don't block: dispatch the job and park. The durable
    // driver polls `pollAgentJob` between sleeps so the run can span far longer
    // than a single durable step's timeout, while each step stays short. A set
    // `jobId` means a prior (possibly replayed) dispatch already started the job,
    // so we re-attach instead of starting a duplicate.
    const context = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
    const executor = this.agentExecutor
    if (isAsyncAgentExecutor(executor) && executor.runsAsync(context)) {
      if (!step.jobId) {
        // Surface an explicit "spinning up container" phase for the cold-boot
        // window: dispatch blocks until the per-run container is up and has
        // accepted the job, so emitting before it lets the board show the boot
        // instead of a blank "working" state.
        step.startingContainer = true
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)

        const handle = await executor.startJob(context)
        step.jobId = handle.jobId
        // Record the model at dispatch — the poll site can't resolve it later.
        if (handle.model) step.model = handle.model
        // The dispatch returned, so the container is up and execution has begun.
        step.startingContainer = false
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
      }
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    const result = await this.runAgent(context, options)
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, result)
  }

  /**
   * Poll the asynchronous job a parked step dispatched. Returns `awaiting_job`
   * while it runs (the driver keeps polling), records the result and advances on
   * success, or reports `job_failed` so the driver can fail the run. Reading run
   * state from storage on every call keeps it safe under Workflows replay/retry:
   * once a job's result is recorded the step's `jobId` is cleared, so a re-poll
   * simply lets the driver advance the now-current step.
   */
  async pollAgentJob(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    if (!step) return { kind: 'noop' }
    // No job in flight: a prior poll already recorded it (and advanced). Let the
    // driver loop and advance whatever step is now current.
    if (!step.jobId) return { kind: 'continue' }

    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) return { kind: 'noop' }

    const update = await executor.pollJob({ jobId: step.jobId, workspaceId })
    if (update.state === 'running') {
      // A successful poll proves the container is up, so the cold-boot phase is
      // over (defensive: a replay may have left the flag set). Surface live subtask
      // progress (e.g. 3/8 todos done) without advancing the step. Only persist +
      // emit when something actually changed so an idle poll doesn't churn storage
      // or the event stream.
      let changed = false
      if (step.startingContainer) {
        step.startingContainer = false
        changed = true
      }
      if (update.subtasks && !sameSubtasks(step.subtasks, update.subtasks)) {
        step.subtasks = update.subtasks
        step.progress =
          update.subtasks.total > 0 ? update.subtasks.completed / update.subtasks.total : 0
        changed = true
      }
      if (changed) {
        await this.executionRepository.upsert(workspaceId, instance)
        await this.emitInstance(workspaceId, instance)
      }
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // A `ci` step's in-flight job is a CI-fixer run, NOT the step's own work: when
    // it finishes (or fails) we don't record a result or advance — we drop the
    // handle, return the gate to `checking`, and re-poll CI (the fixer's push
    // triggers a fresh run). A fixer that failed without pushing leaves CI red, so
    // the next CI check re-dispatches (until the attempt budget is spent).
    if (step.agentKind === CI_AGENT_KIND) {
      step.jobId = undefined
      step.subtasks = undefined
      if (step.ci) step.ci.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_ci', stepIndex: instance.currentStep }
    }

    // A `conflicts` step's in-flight job is a conflict-resolver run, NOT the step's
    // own work: when it finishes (or fails) we drop the handle, return the gate to
    // `checking` and re-check mergeability (the resolver's push updates it). A
    // resolver that failed without pushing leaves the PR conflicted, so the next
    // check re-dispatches (until the attempt budget is spent).
    if (step.agentKind === CONFLICTS_AGENT_KIND) {
      step.jobId = undefined
      step.subtasks = undefined
      if (step.conflicts) step.conflicts.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_conflicts', stepIndex: instance.currentStep }
    }

    if (update.state === 'failed') {
      // A container eviction/crash (the per-run container vanished, its in-memory
      // job is gone) is usually transient. Recover it once by dropping the dead
      // handle and returning `continue`: the driver loops back into `advanceInstance`,
      // which re-dispatches the SAME step to a fresh container (a new instance boots
      // under the same id). A second eviction of the same step is treated as
      // deterministic and fails the run as `evicted`. A genuine agent/job failure is
      // never recovered — it fails immediately.
      if (isContainerEvictionError(update.error)) {
        const recoveries = step.evictionRecoveries ?? 0
        if (recoveries < MAX_EVICTION_RECOVERIES) {
          step.evictionRecoveries = recoveries + 1
          step.jobId = undefined
          step.subtasks = undefined
          step.progress = 0
          await this.executionRepository.upsert(workspaceId, instance)
          await this.emitInstance(workspaceId, instance)
          return { kind: 'continue' }
        }
        return {
          kind: 'job_evicted',
          error: `${update.error ?? 'Container evicted'} (still evicting after ${recoveries} automatic container restart${recoveries === 1 ? '' : 's'} — treating as deterministic)`,
        }
      }
      return { kind: 'job_failed', error: update.error }
    }

    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    // Clear the handle before recording so a replay re-attaches to nothing.
    step.jobId = undefined
    return this.recordStepResult(workspaceId, instance, step, isFinalStep, update.result)
  }

  /**
   * Re-check a `ci` step's gate from the durable driver's `awaiting_ci` loop:
   * re-reads CI check runs and returns the same outcomes as the initial evaluation
   * (green → advance, still running → keep polling, failure → dispatch a fixer or
   * give up). Safe under replay: reading run state fresh each call. A no-op unless
   * the current step is a `ci` step actively in its `checking` phase.
   */
  async pollCi(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    if (!step || step.agentKind !== CI_AGENT_KIND) return { kind: 'continue' }
    // A fixer job is in flight — the driver should be polling it, not CI; let the
    // job-poll loop drive (defensive; a replay could route here).
    if (step.jobId)
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    return this.evaluateCi(workspaceId, instance, step, block, isFinalStep)
  }

  /**
   * Re-check a `conflicts` step's gate from the durable driver's `awaiting_conflicts`
   * loop: re-reads the PR's mergeability and returns the same outcomes as the initial
   * evaluation (mergeable → advance, still computing → keep polling, conflicted →
   * dispatch a resolver or give up). Safe under replay; a no-op unless the current
   * step is a `conflicts` step actively in its `checking` phase.
   */
  async pollConflicts(workspaceId: string, executionId: string): Promise<AdvanceResult> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || (instance.status !== 'running' && instance.status !== 'paused')) {
      return { kind: 'noop' }
    }
    const step = instance.steps[instance.currentStep]
    if (!step || step.agentKind !== CONFLICTS_AGENT_KIND) return { kind: 'continue' }
    // A resolver job is in flight — the driver should be polling it, not mergeability.
    if (step.jobId)
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    return this.evaluateConflicts(workspaceId, instance, step, block, isFinalStep)
  }

  /**
   * Transition a step into `working`, stamping its start time the first time it
   * actually begins. Set-once so a Workflows replay (which re-runs `advance`)
   * preserves the original start rather than resetting it on every replay. An
   * explicit re-run clears `startedAt` first (see {@link requestStepChanges}) so
   * the fresh attempt is timed from scratch.
   */
  private startStep(step: PipelineStep): void {
    step.state = 'working'
    if (step.startedAt == null) step.startedAt = this.clock.now()
  }

  /**
   * Transition a step into `done`, stamping its finish time once. Set-once so the
   * approval-gate flow (which re-asserts `done` after a human approves, long after
   * the agent actually finished) keeps the agent's true completion time, and so a
   * replay doesn't move it. With {@link startStep}'s `startedAt` this yields the
   * step's execution duration.
   */
  private finishStep(step: PipelineStep): void {
    step.state = 'done'
    if (step.finishedAt == null) step.finishedAt = this.clock.now()
  }

  /**
   * Record a completed agent step's result and report what the driver should do
   * next: meter token usage, park on a raised decision, or persist the output
   * (and any opened PR) and either finish the run or advance to the next step.
   * Shared by the inline path and the async-job poll path.
   */
  private async recordStepResult(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ): Promise<AdvanceResult> {
    // Meter the LLM call against the spend budget. Recorded whether the step
    // completed or raised a decision — both consumed tokens.
    if (result.usage) {
      await this.spend.record({
        workspaceId,
        executionId: instance.id,
        agentKind: step.agentKind,
        model: result.model ?? 'unknown',
        usage: result.usage,
      })
    }

    // The agent asked for a human decision and this step hasn't resolved one yet.
    if (result.decision && !step.decision?.chosen) {
      step.decision = {
        id: this.idGenerator.next('dec'),
        question: result.decision.question,
        options: [...result.decision.options],
        chosen: null,
      }
      step.state = 'waiting_decision'
      instance.status = 'blocked'
      await this.updateBlockProgress(workspaceId, instance, 'blocked')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_decision', decisionId: step.decision.id }
    }

    // The step completed.
    step.output = result.output ?? ''
    if (result.model) step.model = result.model
    step.progress = 1
    this.finishStep(step)
    // Live subtask counts only describe an in-flight run; drop them now the step
    // is done so the board doesn't show a stale "3/8" against a finished step.
    step.subtasks = undefined

    // A repo-operating step (the container "implementer" agent) opened a PR for
    // its work. Record it on the block so the board can surface and link to it,
    // regardless of whether this is the final step.
    if (result.pullRequest) {
      await this.blockRepository.update(workspaceId, instance.blockId, {
        pullRequest: result.pullRequest,
      })
    }

    // A Blueprinter step produced a fresh service decomposition. Validate it with
    // the authoritative schema (a bad payload must never touch the board), then
    // reconcile it in place onto the run's service frame.
    if (result.blueprintService !== undefined) {
      await this.ingestBlueprint(workspaceId, instance.blockId, result.blueprintService)
    }

    // Human approval gate: a step the pipeline marked `requiresApproval` pauses
    // here once its proposal is ready, so a human can review (and edit) it before
    // the next step runs. We reuse the durable decision wait — returning
    // `awaiting_decision` keyed by the approval id parks the run on the same named
    // event the workflow already listens for; `approveStep` / `requestStepChanges`
    // wake it. Never gates the final step (nothing downstream to feed) and is
    // idempotent: an already-approved step falls through to advance/finish.
    if (step.requiresApproval && !isFinalStep && step.approval?.status !== 'approved') {
      step.approval = {
        id: this.idGenerator.next('appr'),
        status: 'pending',
        proposal: step.output,
      }
      step.state = 'waiting_decision'
      instance.status = 'blocked'
      await this.updateBlockProgress(workspaceId, instance, 'blocked')
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_decision', decisionId: step.approval.id }
    }

    if (isFinalStep) {
      instance.status = 'done'
      // Record the reported confidence for transparency BEFORE any merge — once a
      // task auto-merges it is `done` and `finalizeBlock` early-returns, so this is
      // the single place confidence is persisted across both the merge and review paths.
      if (result.confidence !== undefined) {
        await this.blockRepository.update(workspaceId, instance.blockId, {
          confidence: result.confidence,
        })
      }
      // A `merger` step produced a PR assessment: compare it against the task's
      // thresholds and either merge for real or raise a review notification. This
      // owns the block's terminal status, so `finalizeBlock` then leaves it alone.
      if (result.mergeAssessment !== undefined) {
        await this.resolveMergerStep(workspaceId, instance, result.mergeAssessment)
      }
      await this.finalizeBlock(workspaceId, instance, result.confidence)
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      // The run is finished: reclaim its per-run container now instead of letting it
      // idle out its sleepAfter window (~10 min of billed-but-useless compute). All
      // pipeline steps share the one container keyed by the execution id, so this is
      // only safe on the FINAL step — never between steps. Best-effort/idempotent.
      await this.stopRunContainer(workspaceId, instance.id)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.startStep(next)
    await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * Deterministically provision an ephemeral environment for a deployer step.
   * Produces a human-readable summary as the step output and reports no token
   * usage (it incurs no LLM cost). Errors are swallowed into the output unless
   * the durable driver wants them surfaced for its per-step retry.
   */
  private async runDeployer(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    options: AdvanceOptions = {},
  ): Promise<AgentRunResult> {
    try {
      const handle = await this.environmentProvisioning!.provision({
        workspaceId,
        blockId: block.id,
        executionId: instance.id,
        inputs: this.deployInputs(block),
      })
      const lines = [
        `Provisioned ephemeral environment via '${handle.providerId}'.`,
        `Status: ${handle.status}`,
        `URL: ${handle.url ?? '(pending)'}`,
      ]
      if (handle.expiresAt) lines.push(`Expires: ${new Date(handle.expiresAt).toISOString()}`)
      return { output: lines.join('\n'), model: `environment:${handle.providerId}` }
    } catch (error) {
      if (options.rethrowAgentErrors) throw error
      return {
        output: `Deployer error: ${getErrorMessage(error)}`,
      }
    }
  }

  /**
   * Evaluate a `ci` step's gate once: read the PR's CI check runs and decide.
   *   - no provider wired → pass-through (advance; nothing to gate);
   *   - green / no checks → advance to the next step;
   *   - still running     → `awaiting_ci` (the driver sleeps then calls {@link pollCi});
   *   - failing, budget left → dispatch a `ci-fixer` container job (`awaiting_job`);
   *   - failing, budget spent → raise a `ci_failed` notification + fail the run.
   * Shared by the initial advance and the durable `awaiting_ci` re-poll.
   */
  private async evaluateCi(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    // Re-attach after a replay: a fixer is already in flight for this gate.
    if (step.ci?.phase === 'fixing' && step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // No CI status wired: the gate is a pass-through so the engine works without
    // GitHub CI. Advance via the normal result path.
    if (!this.ciStatusProvider) {
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: 'CI gate skipped (no CI status provider configured).',
      })
    }

    // Initialise the gate's state on first entry, resolving the attempt budget from
    // the task's merge preset (stable across polls once set).
    if (!step.ci) {
      const preset = await this.resolveMergePreset(workspaceId, block)
      step.ci = { phase: 'checking', attempts: 0, maxAttempts: preset.ciMaxAttempts, headSha: null }
    }

    const report = await this.ciStatusProvider.getStatus(workspaceId, block.id)
    step.ci.headSha = report.headSha
    const verdict = aggregateCi(report.checks)

    if (isCiGreen(verdict)) {
      // Stop polling the moment CI is green — finish the step and advance.
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output:
          verdict === 'none'
            ? 'CI gate passed: no checks configured for the PR head.'
            : `CI gate passed: ${report.checks.length} check(s) green.`,
      })
    }

    if (verdict === 'pending') {
      // Keep polling. Persist the head sha + phase so the board can reflect it.
      step.ci.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_ci', stepIndex: instance.currentStep }
    }

    // verdict === 'failure'.
    const summary = describeFailingChecks(report.checks)
    const executor = this.agentExecutor
    const canFix = isAsyncAgentExecutor(executor)
    if (canFix && step.ci.attempts < step.ci.maxAttempts) {
      return this.dispatchCiFixer(workspaceId, instance, step, block, isFinalStep, summary)
    }

    // Budget spent (or no async executor to fix with): give up and notify a human.
    await this.raiseCiFailed(workspaceId, instance, block, summary, step.ci.attempts)
    return {
      kind: 'job_failed',
      error: `CI did not pass after ${step.ci.attempts} CI-fixer attempt(s). ${summary}`.trim(),
    }
  }

  /**
   * Dispatch a `ci-fixer` container job for a failing `ci` gate: build the agent
   * context with the kind overridden to `ci-fixer` (it clones the PR head branch
   * and pushes a fix — no new PR), park on the job, and flip the gate to `fixing`.
   * Idempotent under replay via the step's `jobId` (re-attach handled in {@link evaluateCi}).
   */
  private async dispatchCiFixer(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    failureSummary: string,
  ): Promise<AdvanceResult> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      // Defensive: evaluateCi only calls this when async-capable.
      return { kind: 'job_failed', error: 'No async executor available to fix CI.' }
    }
    const base = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
    const context: AgentRunContext = {
      ...base,
      agentKind: CI_FIXER_AGENT_KIND,
      // Surface the failing-check summary to the fixer as resolved context.
      priorOutputs: [...base.priorOutputs, { agentKind: CI_AGENT_KIND, output: failureSummary }],
    }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    step.ci = {
      phase: 'fixing',
      attempts: (step.ci?.attempts ?? 0) + 1,
      maxAttempts: step.ci?.maxAttempts ?? DEFAULT_MERGE_PRESET.ciMaxAttempts,
      headSha: step.ci?.headSha ?? null,
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /** Raise a `ci_failed` notification when the CI gate exhausts its fixer budget. */
  private async raiseCiFailed(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    summary: string,
    attempts: number,
  ): Promise<void> {
    if (!this.notificationService) return
    await this.notificationService.raise(workspaceId, {
      type: 'ci_failed',
      blockId: block.id,
      executionId: instance.id,
      title: `CI is still failing for "${block.title}"`,
      body:
        `The CI-fixer agent tried ${attempts} time(s) but CI is still red. ${summary} ` +
        `Take a look and retry the run once fixed.`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /**
   * Evaluate a `conflicts` step's gate once: read the PR's mergeability and decide.
   *   - no provider wired → pass-through (advance; nothing to gate);
   *   - mergeable / no PR  → advance to the next step;
   *   - still computing    → `awaiting_conflicts` (the driver sleeps then re-polls);
   *   - conflicted, budget left → dispatch a `conflict-resolver` container job;
   *   - conflicted, budget spent → fail the run (a human resolves + retries).
   * Shared by the initial advance and the durable `awaiting_conflicts` re-poll.
   */
  private async evaluateConflicts(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    // Re-attach after a replay: a resolver is already in flight for this gate.
    if (step.conflicts?.phase === 'resolving' && step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // No mergeability provider wired: the gate is a pass-through so the engine works
    // without GitHub. Advance via the normal result path.
    if (!this.mergeabilityProvider) {
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: 'Conflict gate skipped (no mergeability provider configured).',
      })
    }

    // Initialise the gate's state on first entry, resolving the attempt budget from
    // the task's merge preset (shares the CI-fixer budget; stable across polls).
    if (!step.conflicts) {
      const preset = await this.resolveMergePreset(workspaceId, block)
      step.conflicts = {
        phase: 'checking',
        attempts: 0,
        maxAttempts: preset.ciMaxAttempts,
        headSha: null,
      }
    }

    const report = await this.mergeabilityProvider.getMergeability(workspaceId, block.id)
    step.conflicts.headSha = report.headSha

    // No PR resolved, or it merges cleanly → nothing to do; advance.
    if (report.headSha === null || report.verdict === 'mergeable') {
      return this.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output:
          report.headSha === null
            ? 'Conflict gate passed: no open PR to gate.'
            : 'Conflict gate passed: the PR merges cleanly with its base.',
      })
    }

    if (report.verdict === 'unknown') {
      // GitHub is still computing mergeability — keep polling.
      step.conflicts.phase = 'checking'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_conflicts', stepIndex: instance.currentStep }
    }

    // verdict === 'conflicted'.
    const executor = this.agentExecutor
    const canResolve = isAsyncAgentExecutor(executor)
    if (canResolve && step.conflicts.attempts < step.conflicts.maxAttempts) {
      return this.dispatchConflictResolver(workspaceId, instance, step, block, isFinalStep)
    }

    // Budget spent (or no async executor to resolve with): give up and fail the run
    // so a human resolves the conflict manually and retries.
    return {
      kind: 'job_failed',
      error:
        `The pull request still conflicts with its base after ` +
        `${step.conflicts.attempts} conflict-resolver attempt(s). Resolve the conflict ` +
        `manually, then retry the run.`,
    }
  }

  /**
   * Dispatch a `conflict-resolver` container job for a conflicted `conflicts` gate:
   * build the agent context with the kind overridden to `conflict-resolver` (it
   * clones the PR head branch, merges the base in, resolves the conflicts and pushes
   * — no new PR), park on the job, and flip the gate to `resolving`. Idempotent under
   * replay via the step's `jobId` (re-attach handled in {@link evaluateConflicts}).
   */
  private async dispatchConflictResolver(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      // Defensive: evaluateConflicts only calls this when async-capable.
      return { kind: 'job_failed', error: 'No async executor available to resolve conflicts.' }
    }
    const base = await this.buildAgentContext(workspaceId, instance, step, isFinalStep, block)
    const context: AgentRunContext = { ...base, agentKind: CONFLICT_RESOLVER_AGENT_KIND }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    step.conflicts = {
      phase: 'resolving',
      attempts: (step.conflicts?.attempts ?? 0) + 1,
      maxAttempts: step.conflicts?.maxAttempts ?? DEFAULT_MERGE_PRESET.ciMaxAttempts,
      headSha: step.conflicts?.headSha ?? null,
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /** Provision inputs (`{{input.*}}`) derived from the block under deployment. */
  private deployInputs(block: Block): Record<string, string> {
    const inputs: Record<string, string> = {
      blockId: block.id,
      title: block.title,
      type: block.type,
      description: block.description,
    }
    return inputs
  }

  /**
   * Invoke the agent for an already-built context. Failures are swallowed into the
   * step output so a run never wedges — unless `rethrowAgentErrors` is set (the
   * durable path), in which case the error propagates so the driver's per-step
   * retry can take over.
   */
  private async runAgent(
    context: AgentRunContext,
    options: AdvanceOptions = {},
  ): Promise<AgentRunResult> {
    try {
      return await this.agentExecutor.run(context)
    } catch (error) {
      // The durable driver wants real failures to surface so its per-step retry
      // can kick in (and the error gets persisted after retries are exhausted).
      if (options.rethrowAgentErrors) throw error
      // Otherwise a failed agent must not wedge the run; record and complete.
      return {
        output: `Agent error: ${getErrorMessage(error)}`,
      }
    }
  }

  /**
   * Strictly parse a Blueprinter step's tree and reconcile it onto the board. The
   * blueprint maps the whole repository, so it is reconciled onto the run block's
   * **service frame** (walked up from the block), not the task the run targeted.
   * Best-effort and reconciler-gated: a parse/reconcile failure is logged-by-throw
   * upstream only when the reconciler is wired; with no reconciler it is a no-op so
   * the blueprint's in-repo files still land.
   */
  private async ingestBlueprint(
    workspaceId: string,
    blockId: string,
    rawService: unknown,
  ): Promise<void> {
    if (!this.blueprintReconciler) return
    let service: BlueprintService
    try {
      service = parseBlueprintService(rawService)
    } catch {
      // A malformed tree must not fail the step (the in-repo files are already
      // committed); skip the board reconcile.
      return
    }
    const frameId = await this.resolveServiceFrameId(workspaceId, blockId)
    await this.blueprintReconciler.reconcileBlueprint(workspaceId, frameId, service)
    // The reconcile may have created/updated module + task blocks that aren't
    // individually pushed; nudge clients to refresh the board so they appear.
    await this.events.boardChanged(workspaceId, 'blueprint-reconciled')
  }

  /** Walk up `parentId` from a block to its top-level service frame id (or itself). */
  private async resolveServiceFrameId(
    workspaceId: string,
    blockId: string,
  ): Promise<string | null> {
    let current = await this.blockRepository.get(workspaceId, blockId)
    // Bounded walk (the tree is at most frame → module → task) guarded against cycles.
    for (let i = 0; current && i < 8; i++) {
      if (current.level === 'frame' || !current.parentId) return current.id
      current = await this.blockRepository.get(workspaceId, current.parentId)
    }
    return current?.id ?? null
  }

  /** Assemble the {@link AgentRunContext} for a step from the run + block state. */
  private async buildAgentContext(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    block: Block,
  ): Promise<AgentRunContext> {
    const contextDocs = await this.resolveContextDocs(workspaceId, block.id)
    const contextTasks = await this.resolveContextTasks(workspaceId, block.id)
    const environment = await this.resolveEnvironment(workspaceId, block.id)
    const priorOutputs = instance.steps
      .slice(0, instance.currentStep)
      .filter((s) => s.output)
      .map((s) => ({ agentKind: s.agentKind, output: s.output! }))
    // Resolve the best-practice fragments to inject for this step from the tenant
    // library (when configured): the merged catalog selected for this block/agent,
    // unioned with the block's manual pins. Recorded on the step for observability.
    const resolved = await this.resolveFragments(workspaceId, step, block, priorOutputs)
    return {
      agentKind: step.agentKind,
      pipelineName: instance.pipelineName,
      workspaceId,
      executionId: instance.id,
      stepIndex: instance.currentStep,
      isFinalStep,
      block: {
        id: block.id,
        title: block.title,
        type: block.type,
        description: block.description,
        fragmentIds: block.fragmentIds,
        ...(resolved ? { resolvedFragments: resolved.fragments } : {}),
        modelId: block.modelId,
        ...(block.testTarget ? { testTarget: block.testTarget } : {}),
        ...(block.pullRequest ? { pullRequest: block.pullRequest } : {}),
        ...(contextDocs.length ? { contextDocs } : {}),
        ...(contextTasks.length ? { contextTasks } : {}),
      },
      ...(environment ? { environment } : {}),
      priorOutputs,
      decisions: instance.steps
        .filter((s, i) => i < instance.currentStep && s.decision?.chosen)
        .map((s) => ({ question: s.decision!.question, chosen: s.decision!.chosen! })),
      resolvedDecision: step.decision?.chosen
        ? { question: step.decision.question, chosen: step.decision.chosen }
        : null,
      // A re-run triggered by "Request changes" on this step's approval gate:
      // hand the agent its previous proposal plus the human's feedback so it
      // revises rather than starting over.
      ...(step.approval?.status === 'changes_requested'
        ? {
            revision: {
              previousProposal: step.approval.proposal,
              feedback: step.approval.feedback ?? '',
            },
          }
        : {}),
    }
  }

  /**
   * Resolve the prompt-fragment library selection for a step. A no-op (returns
   * null) unless the library module is wired, so the engine — and every executor
   * — falls back to the block's manual `fragmentIds` when it is off. Records the
   * selected ids on the step for observability; never throws (a selector failure
   * degrades to the manual pins inside the resolver).
   */
  private async resolveFragments(
    workspaceId: string,
    step: PipelineStep,
    block: Block,
    priorOutputs: { agentKind: string; output: string }[],
  ): Promise<{ fragments: { id: string; body: string }[] } | null> {
    if (!this.fragmentResolver) return null
    try {
      const selection = await this.fragmentResolver.resolveForRun({
        workspaceId,
        agentKind: step.agentKind,
        blockType: block.type,
        blockTitle: block.title,
        blockDescription: block.description,
        manualIds: block.fragmentIds ?? [],
        // The prior step's output (e.g. a coder's summary) is the cheapest signal
        // available without fetching a diff; the selector reasons over it.
        signals: priorOutputs.map((p) => p.output).slice(-2),
      })
      step.selectedFragmentIds = selection.selectedIds
      return { fragments: selection.fragments }
    } catch {
      // Resolution must never wedge a run; fall back to manual id resolution.
      return null
    }
  }

  /**
   * Resolve documents (from any source) linked to the running block into compact
   * agent context. A no-op unless the document-source integration is wired (the
   * repository is an optional dependency), so the engine stays unchanged when it
   * is off.
   */
  private async resolveContextDocs(
    workspaceId: string,
    blockId: string,
  ): Promise<{ title: string; url: string; excerpt: string }[]> {
    if (!this.documents) return []
    const docs = await this.documents.listByBlock(workspaceId, blockId)
    return docs.map((d) => ({ title: d.title, url: d.url, excerpt: d.excerpt }))
  }

  /**
   * Resolve tracker issues (from any source) linked to the running block into
   * structured agent context. A no-op unless the task-source integration is
   * wired (the repository is an optional dependency), so the engine stays
   * unchanged when it is off.
   */
  private async resolveContextTasks(workspaceId: string, blockId: string) {
    if (!this.tasks) return []
    const tasks = await this.tasks.listByBlock(workspaceId, blockId)
    return tasks.map((t) => ({
      key: t.externalId,
      url: t.url,
      title: t.title,
      status: t.status,
      type: t.type,
      assignee: t.assignee,
      priority: t.priority,
      labels: t.labels,
      description: t.description,
      comments: t.comments,
    }))
  }

  /**
   * Resolve the live ephemeral environment provisioned for the running block
   * into compact agent context. A no-op unless the environment integration is
   * wired (the provisioning service is an optional dependency), so the engine
   * stays unchanged when it is off.
   */
  private async resolveEnvironment(workspaceId: string, blockId: string) {
    if (!this.environmentProvisioning) return null
    return this.environmentProvisioning.resolveForBlock(workspaceId, blockId)
  }

  /**
   * Push the run's latest state to subscribed clients, alongside its rolled-up
   * block so the board updates without a refetch. Best-effort: the publisher
   * swallows its own errors, and the persisted run remains the source of truth.
   */
  private async emitInstance(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    // The metrics rollup and the block fetch are independent, so run them concurrently
    // — the rollup adds no serial latency to the (frequent) emit path.
    const [, block] = await Promise.all([
      this.attachStepMetrics(workspaceId, instance),
      this.blockRepository.get(workspaceId, instance.blockId),
    ])
    await this.events.executionChanged(workspaceId, instance, block)
  }

  /**
   * Roll the run's recorded LLM calls into per-step `metrics` for the board, in
   * place on the emitted instance. The proxy keys calls by execution + agentKind
   * (not step index), so the aggregate is per-agent-kind within the run; steps
   * sharing a kind get the same rollup. Best-effort and a no-op when the sink is
   * not wired, so it never blocks an emit.
   */
  private async attachStepMetrics(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    if (!this.llmObservability) return
    try {
      const summaries = await this.llmObservability.summarizeByExecution(workspaceId, instance.id)
      if (summaries.length === 0) return
      const byKind = new Map(summaries.map((s) => [s.agentKind, s]))
      for (const step of instance.steps) {
        const s = byKind.get(step.agentKind)
        if (!s) continue
        step.metrics = {
          calls: s.calls,
          promptTokens: s.promptTokens,
          completionTokens: s.completionTokens,
          peakCompletionTokens: s.peakCompletionTokens,
          maxOutputTokens: s.maxOutputTokens,
          truncatedCalls: s.truncatedCalls,
          upstreamMs: s.upstreamMs,
          overheadMs: s.overheadMs,
          errors: s.errors,
          warnings: s.warnings,
        }
      }
    } catch (error) {
      // Observability is best-effort; never block an emit on a metrics read.
      void error
    }
  }

  /** Set the block's in-progress/blocked status and step-completion progress. */
  private async updateBlockProgress(
    workspaceId: string,
    instance: ExecutionInstance,
    status: 'in_progress' | 'blocked',
  ): Promise<void> {
    const total = instance.steps.length || 1
    const done = instance.steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, instance.blockId, {
      status,
      progress: Math.min(1, done / total),
    })
  }

  /**
   * A pipeline finished. A frame becomes `done` (a mapping-only run leaves it
   * `ready`). A *task* never auto-`done`s from a confidence score any more — that
   * looked merged when the PR was still open with red CI. Instead:
   *   - if the pipeline has a `merger` step, it already owned the merge/notify
   *     decision (see {@link resolveMergerStep}); we only backstop a missing one;
   *   - otherwise the work is complete but unmerged: leave the PR open (`pr_ready`)
   *     and raise a `pipeline_complete` notification for a human to confirm + merge.
   * `done` now strictly means the PR was merged (see {@link finalizeMerge}).
   */
  private async finalizeBlock(
    workspaceId: string,
    instance: ExecutionInstance,
    confidence: number | undefined,
  ): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block || block.status === 'done') return

    if ((block.level ?? 'frame') !== 'task') {
      // A mapping-only run (just the `blueprints` step, e.g. kicked off after a
      // bootstrap) leaves the service frame `ready` and droppable rather than
      // marking the whole service "done".
      const mappingOnly = instance.steps.every((s) => s.agentKind === 'blueprints')
      await this.blockRepository.update(workspaceId, block.id, {
        status: mappingOnly ? 'ready' : 'done',
        progress: 1,
      })
      return
    }

    // Confidence is recorded by the caller (recordStepResult) before any merge, so
    // it persists on both the merge and review paths; `confidence` is unused here.
    void confidence

    const hasMerger = instance.steps.some((s) => s.agentKind === MERGER_AGENT_KIND)
    if (hasMerger) {
      // The `merger` step already merged (→ `done`) or raised a review (→ `pr_ready`).
      // Only backstop the case where it produced no decision at all.
      const fresh = await this.blockRepository.get(workspaceId, block.id)
      if (fresh && fresh.status !== 'done' && fresh.status !== 'pr_ready') {
        await this.blockRepository.update(workspaceId, block.id, {
          status: 'pr_ready',
          progress: 1,
        })
      }
      return
    }

    // No merger in this pipeline: complete but unmerged — ask a human to confirm.
    await this.blockRepository.update(workspaceId, block.id, { status: 'pr_ready', progress: 1 })
    await this.raisePipelineComplete(workspaceId, instance, block)
  }

  /**
   * Merge a block's PR for real, then mark it `done`. The remote merge happens
   * FIRST (via the {@link PullRequestMerger} port) and only on its success does the
   * block flip to `done` — so `done` provably means "merged", not a board-only
   * status. When no merger is wired (tests) this degrades to the old board-only
   * flip. Throws if the remote merge fails so callers can fall back to a manual
   * merge / review notification.
   */
  private async finalizeMerge(workspaceId: string, blockId: string): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, blockId)
    if (!block) return
    if (this.prMerger && block.pullRequest) {
      // Throws on a blocked/failed merge — the caller decides what to do next.
      await this.prMerger.mergeForBlock(workspaceId, blockId)
    }
    await this.blockRepository.update(workspaceId, blockId, { status: 'done', progress: 1 })
    if ((block.level ?? 'frame') === 'task') {
      await this.applyModuleAssignment(workspaceId, blockId)
    }
  }

  /**
   * Resolve a `merger` step's assessment: parse + validate it, compare each axis
   * against the task's resolved merge preset, and either merge the PR for real
   * (all within threshold) or raise a `merge_review` notification leaving the
   * block `pr_ready`. A malformed assessment or a failed auto-merge also falls back
   * to a review notification — never a silent merge.
   */
  private async resolveMergerStep(
    workspaceId: string,
    instance: ExecutionInstance,
    rawAssessment: unknown,
  ): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return

    let assessment: MergeAssessment | null = null
    try {
      assessment = parseMergeAssessment(rawAssessment)
    } catch {
      assessment = null
    }

    const preset = await this.resolveMergePreset(workspaceId, block)
    const within =
      assessment !== null &&
      assessment.complexity <= preset.maxComplexity &&
      assessment.risk <= preset.maxRisk &&
      assessment.impact <= preset.maxImpact

    if (within) {
      try {
        await this.finalizeMerge(workspaceId, block.id)
        return
      } catch {
        // Auto-merge failed (e.g. branch protection / conflict): fall through to a
        // review notification so a human can sort it out.
      }
    }

    await this.blockRepository.update(workspaceId, block.id, { status: 'pr_ready', progress: 1 })
    await this.raiseMergeReview(workspaceId, instance, block, assessment)
  }

  /**
   * Resolve the merge threshold preset that governs a task: its explicitly-picked
   * preset, else the workspace default, else the built-in {@link DEFAULT_MERGE_PRESET}.
   * Returns just the thresholds the engine compares against (+ the CI attempt budget).
   */
  private async resolveMergePreset(
    workspaceId: string,
    block: Block,
  ): Promise<{
    maxComplexity: number
    maxRisk: number
    maxImpact: number
    ciMaxAttempts: number
  }> {
    if (this.mergePresetRepository) {
      if (block.mergePresetId) {
        const picked = await this.mergePresetRepository.get(workspaceId, block.mergePresetId)
        if (picked) return picked
      }
      const fallback = await this.mergePresetRepository.getDefault(workspaceId)
      if (fallback) return fallback
    }
    return DEFAULT_MERGE_PRESET
  }

  /** Raise a `merge_review` notification carrying the agent's assessment + the PR. */
  private async raiseMergeReview(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    assessment: MergeAssessment | null,
  ): Promise<void> {
    if (!this.notificationService) return
    const body = assessment
      ? `The merger scored this PR outside the task's auto-merge thresholds ` +
        `(complexity ${pct(assessment.complexity)}, risk ${pct(assessment.risk)}, ` +
        `impact ${pct(assessment.impact)}). ${assessment.rationale}`
      : `The merger could not produce a valid assessment for this PR. Review and merge manually.`
    await this.notificationService.raise(workspaceId, {
      type: 'merge_review',
      blockId: block.id,
      executionId: instance.id,
      title: `Review PR for "${block.title}"`,
      body,
      payload: {
        ...(assessment ? { assessment } : {}),
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /** Raise a `pipeline_complete` notification for a no-merger run awaiting confirmation. */
  private async raisePipelineComplete(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
  ): Promise<void> {
    if (!this.notificationService) return
    await this.notificationService.raise(workspaceId, {
      type: 'pipeline_complete',
      blockId: block.id,
      executionId: instance.id,
      title: `Confirm "${block.title}" is complete`,
      body:
        `The "${instance.pipelineName}" pipeline finished and opened a PR, but it has no ` +
        `merger step. Review the work and confirm it as complete (this merges the PR).`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /**
   * Implementing a task assigned to a module materialises that module: create it
   * in the service if missing, then move the task inside it.
   */
  private async applyModuleAssignment(workspaceId: string, taskId: string): Promise<void> {
    const task = await this.blockRepository.get(workspaceId, taskId)
    if (!task || !task.moduleName) return
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const service = serviceOf(blocks, task)
    if (!service) return

    let module = blocks.find(
      (b) => b.parentId === service.id && b.level === 'module' && b.title === task.moduleName,
    )
    if (!module) {
      module = await this.board.addModule(workspaceId, service.id, {
        name: task.moduleName,
      })
    }
    if (module.id !== task.parentId) {
      const n = blocks.filter((b) => b.parentId === module!.id && b.level === 'task').length
      await this.board.reparent(workspaceId, taskId, {
        parentId: module.id,
        position: { x: 16 + (n % 2) * 190, y: 40 + Math.floor(n / 2) * 130 },
      })
    }
    // A module node appeared and/or a task changed parent — the per-block event
    // can't express that hierarchy change, so signal a coarse board refresh.
    await this.events.boardChanged(workspaceId, 'module')
  }

  /** Resolve a pending decision; the run's next step lets the agent finish it. */
  async resolveDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
    choice: string,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const step = instance.steps.find((s) => s.decision?.id === decisionId)
    if (!step || !step.decision) throw new NotFoundError('Decision', decisionId)

    step.decision.chosen = choice
    this.startStep(step)
    if (instance.status === 'blocked') instance.status = 'running'
    await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.executionRepository.upsert(workspaceId, instance)
    // Wake the parked durable run, if any. The DB write above remains the source
    // of truth (so the backstop sweeper can still re-drive it); the signal is an
    // optimisation that lets the workflow continue immediately.
    await this.workRunner.signalDecision(workspaceId, instance.id, decisionId, choice)
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Expire a decision no human resolved within the timeout. Safe + idempotent: a no-op
   * unless the run is still parked (`blocked`) on EXACTLY this decision/approval id, so a
   * decision already resolved (the run advanced past it) or an already-terminal run is left
   * untouched. The Node durable driver schedules this `decisionTimeout` after parking on a
   * decision; the Cloudflare driver instead relies on `waitForEvent`'s own timeout firing
   * its failRun. Keeping the check here (not in the runtime) means both facades reason about
   * decision state identically.
   */
  async expireDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
  ): Promise<void> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance || instance.status !== 'blocked') return
    const step = instance.steps[instance.currentStep]
    const pendingId = step?.decision?.id ?? step?.approval?.id
    if (step?.state !== 'waiting_decision' || pendingId !== decisionId) return
    await this.failRun(
      workspaceId,
      executionId,
      'Decision timed out awaiting a human response',
      'decision_timeout',
    )
  }

  /**
   * Approve a step's gated proposal: the run advances to the next step, carrying
   * the (optionally human-edited) proposal forward as context. Mirrors
   * {@link resolveDecision}'s durable-wake but *advances* the pipeline instead of
   * re-running the step (the step is already done). Idempotent — re-approving an
   * already-approved gate is a no-op.
   */
  async approveStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    opts: { proposal?: string } = {},
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const stepIndex = instance.steps.findIndex((s) => s.approval?.id === approvalId)
    const step = instance.steps[stepIndex]
    if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
    if (step.approval.status === 'approved') return instance

    // A human edit to the proposal replaces the agent's text, so the revised
    // proposal is what downstream steps read (via priorOutputs).
    if (opts.proposal !== undefined) {
      step.output = opts.proposal
      step.approval.proposal = opts.proposal
    }
    step.approval.status = 'approved'
    this.finishStep(step)
    step.progress = 1

    const isFinalStep = stepIndex === instance.steps.length - 1
    if (isFinalStep) {
      // A gate is never raised on the final step, but stay defensive: just finish.
      instance.status = 'done'
      await this.finalizeBlock(workspaceId, instance, undefined)
      await this.stopRunContainer(workspaceId, instance.id)
    } else {
      instance.currentStep = stepIndex + 1
      const next = instance.steps[instance.currentStep]
      if (next) this.startStep(next)
      if (instance.status === 'blocked') instance.status = 'running'
      await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    }
    await this.executionRepository.upsert(workspaceId, instance)
    // Wake the parked durable run (the DB write above is the source of truth).
    await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'approved')
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Request changes on a step's gated proposal: the same step re-runs with the
   * human's feedback (and its prior proposal) folded into the agent's context (see
   * `buildAgentContext`). The run is left `running` on the same step; on the
   * re-run's completion the gate is raised afresh.
   */
  async requestStepChanges(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    feedback: string,
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    const step = instance.steps.find((s) => s.approval?.id === approvalId)
    if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
    if (step.approval.status === 'approved') {
      throw new ConflictError(`Approval '${approvalId}' is already approved`)
    }

    step.approval.status = 'changes_requested'
    step.approval.feedback = feedback
    // Drop the live job handle so the re-run dispatches fresh work rather than
    // re-attaching to the finished job (async steps); inline steps ignore this.
    step.jobId = undefined
    // A requested re-run is a fresh execution: clear the prior timing so the next
    // start/finish times this attempt rather than spanning the human gate wait.
    step.startedAt = null
    step.finishedAt = null
    this.startStep(step)
    if (instance.status === 'blocked') instance.status = 'running'
    await this.executionRepository.upsert(workspaceId, instance)
    await this.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'changes_requested')
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /** Merge an open PR: a block moves from `pr_ready` to `done`. */
  async mergePr(workspaceId: string, blockId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const block = await this.requireBlock(workspaceId, blockId)
    if (block.status !== 'pr_ready') {
      throw new ConflictError(`Block '${blockId}' has no PR awaiting merge`)
    }
    await this.finalizeMerge(workspaceId, blockId)
    return this.requireBlock(workspaceId, blockId)
  }

  /**
   * Record a terminal agent failure: persist a structured {@link AgentFailure},
   * flip the run to `failed`, and mark the block `blocked` (needs attention) — NOT
   * `pr_ready`, which looked like success and hid the failure. The board then
   * renders the same failure banner + retry as a failed bootstrap. Called by the
   * durable driver once a step has exhausted its retries (or a job/decision
   * faulted); `kind` classifies the cause so the right hint is shown.
   */
  async failRun(
    workspaceId: string,
    executionId: string,
    message: string,
    kind: AgentFailureKind = 'agent',
  ): Promise<void> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) return
    // Reclaim the per-run container on the failure path too: a failed run otherwise
    // leaves its container to idle out sleepAfter. This is the single funnel for
    // every failure kind (job_failed from the driver, the spend/decision timeouts,
    // and the user-facing stopRun, which already reclaimed — the call is idempotent).
    await this.stopRunContainer(workspaceId, executionId)
    const failure: AgentFailure = {
      kind,
      message,
      detail: null,
      hint: EXECUTION_FAILURE_HINTS[kind] ?? null,
      occurredAt: this.clock.now(),
      lastSubtasks: instance.steps[instance.currentStep]?.subtasks ?? null,
    }
    await this.executionRepository.markFailed(workspaceId, executionId, failure)
    // Progress reflects how far the pipeline got before failing.
    const done = instance.steps.filter((s) => s.state === 'done').length
    const progress = instance.steps.length > 0 ? done / instance.steps.length : 0
    await this.blockRepository.update(workspaceId, instance.blockId, {
      status: 'blocked',
      progress,
    })
    const failed = await this.executionRepository.get(workspaceId, executionId)
    if (failed) await this.emitInstance(workspaceId, failed)
  }

  /**
   * Retry a failed run: re-drive the same pipeline on the same block, **resuming
   * from the step that actually failed** rather than restarting from step 0. The
   * steps that already completed are preserved (so a `coder` failure in `pl_full`
   * doesn't re-run the human-gated `requirements`/`architect` steps before it);
   * the failed step and everything after it are reset to a clean, re-runnable
   * state. Only a `failed` run can be retried.
   *
   * A fresh instance id is minted because the durable runner addresses one
   * Workflows instance per execution id and the failed one is terminal — the new
   * instance simply starts with `currentStep` pointed at the failed step, so the
   * driver advances forward from there and never re-issues the completed steps'
   * work. Mirrors {@link BootstrapService.retry}; both are reached via the unified
   * `POST /agent-runs/:id/retry` endpoint.
   */
  async retry(workspaceId: string, executionId: string): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const previous = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (previous.status !== 'failed') {
      throw new ConflictError(`Only a failed run can be retried (run is '${previous.status}').`)
    }
    await this.requireBlock(workspaceId, previous.blockId)

    const { steps, currentStep } = planResumedSteps(previous)
    // Replace the terminal failed run for this block with the resumed one (single
    // run per block, matching the board's by-block projection).
    await this.executionRepository.deleteByBlock(workspaceId, previous.blockId)
    const instance: ExecutionInstance = {
      id: this.idGenerator.next('exec'),
      blockId: previous.blockId,
      pipelineId: previous.pipelineId,
      pipelineName: previous.pipelineName,
      steps,
      currentStep,
      status: 'running',
    }
    await this.executionRepository.upsert(workspaceId, instance)
    const done = steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, previous.blockId, {
      status: 'in_progress',
      progress: steps.length > 0 ? done / steps.length : 0,
      executionId: instance.id,
    })
    await this.workRunner.startRun(workspaceId, instance.id)
    await this.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Resume every run paused by the spend safeguard in this workspace. Flips them
   * back to `running` and re-drives the durable runner. If the budget is still
   * exhausted the spend gate will simply pause them again on their next step.
   */
  async resumePaused(workspaceId: string): Promise<ExecutionInstance[]> {
    await this.requireWorkspace(workspaceId)
    const instances = await this.executionRepository.listByWorkspace(workspaceId)
    const paused = instances.filter((e) => e.status === 'paused')
    for (const instance of paused) {
      instance.status = 'running'
      await this.executionRepository.upsert(workspaceId, instance)
      await this.workRunner.startRun(workspaceId, instance.id)
      await this.emitInstance(workspaceId, instance)
    }
    return this.executionRepository.listByWorkspace(workspaceId)
  }

  /** Cancel the run on a block, returning it to `planned`. */
  async cancel(workspaceId: string, blockId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    await this.requireBlock(workspaceId, blockId)
    // Tear down the durable run (if any) AND its per-run container before removing
    // the record, so a cancel never leaves a container running until its watchdog.
    const existing = await this.executionRepository.getByBlock(workspaceId, blockId)
    if (existing) {
      await this.stopRunContainer(workspaceId, existing.id)
      await this.workRunner.cancelRun(workspaceId, existing.id)
    }
    await this.executionRepository.deleteByBlock(workspaceId, blockId)
    await this.blockRepository.update(workspaceId, blockId, {
      status: 'planned',
      progress: 0,
      executionId: null,
    })
    // The run record is gone and the block is back to planned; the client can't
    // reconstruct that from a per-instance event, so signal a coarse refresh.
    await this.events.boardChanged(workspaceId, 'cancel')
    return this.requireBlock(workspaceId, blockId)
  }

  /**
   * Explicitly stop a *running* run by id (the unified `POST /agent-runs/:id/stop`
   * surface): kill its per-run container, tear down the durable driver, then record
   * a terminal `cancelled` failure so the board shows the run stopped (with retry)
   * rather than spinning forever. Idempotent — a run already terminal is returned
   * as-is. `opts.reason`/`opts.kind` let the orphan sweep reuse this with its own
   * wording instead of the user-facing default.
   */
  async stopRun(
    workspaceId: string,
    executionId: string,
    opts: { reason?: string; kind?: AgentFailureKind } = {},
  ): Promise<ExecutionInstance> {
    await this.requireWorkspace(workspaceId)
    const instance = assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (instance.status === 'failed' || instance.status === 'done') return instance
    await this.stopRunContainer(workspaceId, executionId)
    await this.workRunner.cancelRun(workspaceId, executionId)
    await this.failRun(
      workspaceId,
      executionId,
      opts.reason ?? 'Stopped by the user.',
      opts.kind ?? 'cancelled',
    )
    return assertFound(
      await this.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
  }

  /**
   * Tear down every run under a block subtree — kill each container, terminate each
   * durable driver, and delete the run record — so deleting a service/module never
   * orphans a container or a Workflows instance. Best-effort and silent: the board
   * delete that follows emits the coarse refresh, so no per-run event is needed.
   */
  async teardownForBlockTree(workspaceId: string, rootId: string): Promise<void> {
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    for (const blockId of descendantIds(blocks, rootId)) {
      const run = await this.executionRepository.getByBlock(workspaceId, blockId)
      if (!run) continue
      await this.stopRunContainer(workspaceId, run.id)
      await this.workRunner.cancelRun(workspaceId, run.id)
      await this.executionRepository.deleteByBlock(workspaceId, blockId)
    }
  }

  /**
   * Best-effort: kill the per-run container backing an execution. The container is
   * keyed by the execution id (see ContainerAgentExecutor), so the handle needs no
   * step lookup. A no-op for inline executors (no `stopJob`) and for an already-gone
   * container; never throws, so it can't derail the teardown that calls it.
   */
  private async stopRunContainer(workspaceId: string, executionId: string): Promise<void> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor) || !executor.stopJob) return
    try {
      await executor.stopJob({ jobId: executionId, workspaceId })
    } catch {
      // The container may already be gone (eviction/completion) — nothing to reclaim.
    }
  }
}
