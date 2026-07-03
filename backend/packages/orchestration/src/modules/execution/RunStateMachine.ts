import type {
  AgentExecutor,
  AgentFailure,
  AgentFailureKind,
  Block,
  BlockRepository,
  Clock,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  IdGenerator,
  PipelineStep,
  SubscriptionActivationRepository,
  WorkRunner,
} from '@cat-factory/kernel'
import {
  assertFound,
  ConflictError,
  isAsyncAgentExecutor,
  isInitiativeAgentKind,
} from '@cat-factory/kernel'
import { MERGER_AGENT_KIND } from './ci.logic.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { LlmObservabilityService } from '../observability/LlmObservabilityService.js'
import type { AdvanceResult } from './advance.js'
import type { StepGraph } from './StepGraph.js'

/**
 * Structural view of the Kaizen agent's scheduler the engine calls at run completion.
 * Kept minimal so the execution engine doesn't depend on the concrete `KaizenService`.
 */
export interface KaizenScheduler {
  scheduleForRun(workspaceId: string, instance: ExecutionInstance): Promise<void>
}

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
    'The implementation container kept vanishing mid-run even after automatic fresh-container restarts. Most often this is transient: a deploy / new-version rollout draining the container, in which case simply retrying once the rollout has finished succeeds. If it persists, it points at a memory or crash issue on the run — inspect its logs (Cloudflare Workers Observability, filtered by the run id) and consider a heavier container instance type. Retry to try again.',
  timeout:
    'The run exceeded its time budget — a step or the implementation job did not finish in time. Retry to start it again.',
  rejected:
    'You rejected this step’s proposal, stopping the run. Retry to re-run the pipeline from the rejected step.',
  companion_rejected:
    'A companion agent could not return a usable quality assessment (its reply was truncated or malformed) even after a repair retry. Review the companion’s raw output on the run, then retry.',
  stalled:
    'This run stopped making progress — its durable driver was lost (most often a crashed or restarted orchestrator) and automatic recovery could not resume it in time, so it was flagged rather than left spinning. Retry to start a fresh run.',
  cancelled: 'You stopped this run; its container was killed. Retry to start it again.',
  dispatch:
    'The agent’s container could not be started — the run never began executing. The provider/runtime’s verbatim response is shown below. Most often this is transient (a capacity blip or a new-version rollout); retrying spins a fresh container. If it persists it points at a misconfigured container binding/image or runner pool. Retry to try again.',
  environment:
    'The deployer step could not provision its ephemeral environment — the environment provider failed, so the run never reached the steps that need it. The provider’s verbatim error is shown below. Most often this is a transient provider/network blip (retrying re-runs the provisioning) or a misconfigured provider connection / repo config. Fix the cause if it persists, then retry.',
  unknown: 'The run failed for an unclassified reason. Review the run, then retry.',
}

/** How many times {@link RunStateMachine.mutateInstance} re-reads + re-applies a mutation
 * before giving up on a hot-contended run. Generous: real contention is one human action
 * racing the driver, which settles in one retry; the cap only bounds a pathological loop. */
const MAX_MUTATE_ATTEMPTS = 8

/** Collaborators the {@link RunStateMachine} needs to persist, emit and transition a run. */
export interface RunStateMachineDeps {
  executionRepository: ExecutionRepository
  blockRepository: BlockRepository
  events: ExecutionEventPublisher
  workRunner: WorkRunner
  agentExecutor: AgentExecutor
  idGenerator: IdGenerator
  clock: Clock
  /** The pure step/cursor mutators ({@link StepGraph}) the transitions build on. */
  stepGraph: StepGraph
  notificationService?: NotificationService
  kaizenScheduler?: KaizenScheduler
  subscriptionActivations?: SubscriptionActivationRepository
  llmObservability?: LlmObservabilityService
}

/**
 * The async instance/block state-machine spine of the execution engine — the outer layer
 * over {@link StepGraph}. It owns everything the engine and every gate controller share
 * about MOVING a run: persisting the instance, pushing the live event (with the metrics
 * rollup + terminal-state cleanup), the block status/progress writes, parking on a decision
 * and advancing past a resolved one, finalizing a finished pipeline, failing a run, and
 * reclaiming the per-run container.
 *
 * Lifted verbatim out of `ExecutionService` so these primitives have ONE cohesive home
 * instead of being scattered as private methods and handed to each controller as a fat
 * callback bag. The merge/auto-start subgraph (`finalizeMerge` / `applyModuleAssignment` /
 * `autoStartDependents`) deliberately stays on the engine — `finalizeBlock` here only flips
 * status and raises the no-merger notification, so this layer carries no merge collaborators.
 */
export class RunStateMachine {
  private readonly executionRepository: ExecutionRepository
  private readonly blockRepository: BlockRepository
  private readonly events: ExecutionEventPublisher
  private readonly workRunner: WorkRunner
  private readonly agentExecutor: AgentExecutor
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly stepGraph: StepGraph
  private readonly notificationService?: NotificationService
  private readonly kaizenScheduler?: KaizenScheduler
  private readonly subscriptionActivations?: SubscriptionActivationRepository
  private readonly llmObservability?: LlmObservabilityService

  constructor(deps: RunStateMachineDeps) {
    this.executionRepository = deps.executionRepository
    this.blockRepository = deps.blockRepository
    this.events = deps.events
    this.workRunner = deps.workRunner
    this.agentExecutor = deps.agentExecutor
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.stepGraph = deps.stepGraph
    this.notificationService = deps.notificationService
    this.kaizenScheduler = deps.kaizenScheduler
    this.subscriptionActivations = deps.subscriptionActivations
    this.llmObservability = deps.llmObservability
  }

  /** Persist the instance (the single write seam shared by the engine + controllers). */
  persistInstance(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    return this.executionRepository.upsert(workspaceId, instance)
  }

  /**
   * Apply a pure in-memory mutation to a run under OPTIMISTIC CONCURRENCY: load the run,
   * run `mutate`, then `compareAndSwap`. If another writer advanced the row in between
   * (a racing human action, or the durable driver), reload and re-apply `mutate` on the
   * fresh state (bounded retries) so the mutation is never lost to a clobbering blind
   * write. This is the lost-update fix for the human-action handlers (resolve decision /
   * approve / request changes), where two requests — or a request and a driver poll —
   * otherwise each persist a full snapshot from a stale read and the last write wins.
   *
   * `mutate` MUST be idempotent w.r.t. external systems: it can run several times, so do
   * all non-idempotent work (signalling the durable driver, emitting events, dispatching
   * containers) AFTER this resolves, on the returned instance. A domain error thrown from
   * `mutate` (e.g. the gate is already resolved on the fresh state) propagates immediately
   * and is not retried. Throws {@link NotFoundError} if the run is gone, or
   * {@link ConflictError} if the row stays contended past the retry budget.
   */
  async mutateInstance(
    workspaceId: string,
    executionId: string,
    mutate: (instance: ExecutionInstance) => void | Promise<void>,
  ): Promise<ExecutionInstance> {
    for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt++) {
      const instance = assertFound(
        await this.executionRepository.get(workspaceId, executionId),
        'Execution',
        executionId,
      )
      await mutate(instance)
      if (await this.executionRepository.compareAndSwap(workspaceId, instance)) {
        return instance
      }
    }
    throw new ConflictError(`Execution '${executionId}' is being modified concurrently; retry`)
  }

  async emitInstance(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    // Stamp each step with the run id so a lone step (in a pushed event, a log line, a
    // detail view) is self-describing for debugging; the value always equals the run id.
    for (const step of instance.steps) step.runId = instance.id
    // The metrics rollup and the block fetch are independent, so run them concurrently
    // — the rollup adds no serial latency to the (frequent) emit path.
    const [, block] = await Promise.all([
      this.attachStepMetrics(workspaceId, instance),
      this.blockRepository.get(workspaceId, instance.blockId),
    ])
    await this.events.executionChanged(workspaceId, instance, block)
    // When a run reaches a terminal state, schedule a post-run Kaizen grading for each
    // completed agent step (the scheduler skips verified combos + already-graded steps).
    // Best-effort + idempotent: a failure here must never derail the emit, and a re-emit
    // of an already-scheduled run is a no-op. The actual LLM grading runs later in the
    // background sweep, so this only does cheap inserts.
    if (this.kaizenScheduler && (instance.status === 'done' || instance.status === 'failed')) {
      try {
        await this.kaizenScheduler.scheduleForRun(workspaceId, instance)
      } catch {
        // Swallow — grading is an observability concern and must never break a run.
      }
    }
    // When a run reaches a terminal state, delete its per-run personal-credential
    // activation immediately (individual-usage subscriptions) so the system-encrypted
    // token copy doesn't linger to its TTL. Best-effort + idempotent — a missing repo or
    // a re-emit of an already-cleared run is a no-op, and a failure here must never
    // derail the emit.
    if (
      this.subscriptionActivations &&
      (instance.status === 'done' || instance.status === 'failed')
    ) {
      try {
        await this.subscriptionActivations.deleteByExecution(instance.id)
      } catch {
        // Swallow — a failure here must never derail the emit. This is not a silent
        // data-loss path: the TTL sweep reclaims the row as a backstop, and the sweep
        // (Worker cron / Node retention timer) logs its own errors, so a *systemic*
        // cleanup failure surfaces there rather than being lost here.
      }
    }
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
          cachedPromptTokens: s.cachedPromptTokens,
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
  async updateBlockProgress(
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
   * Advance the block's step PROGRESS without touching its status — used when a step
   * resolver already owns the block's terminal status (the merger set `done`/`pr_ready`)
   * and a trailing step still follows, so the bar moves on without downgrading that status.
   */
  async refreshBlockProgress(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    const total = instance.steps.length || 1
    const done = instance.steps.filter((s) => s.state === 'done').length
    await this.blockRepository.update(workspaceId, instance.blockId, {
      progress: Math.min(1, done / total),
    })
  }

  /**
   * Park a step on a human approval decision: mint the approval id, freeze the step's
   * duration clock, flip the run `blocked`, persist + emit, and return the durable
   * `awaiting_decision` outcome the driver parks on.
   */
  async parkStepOnDecision(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    proposal = '',
  ): Promise<AdvanceResult> {
    step.approval = { id: this.idGenerator.next('appr'), status: 'pending', proposal }
    this.stepGraph.pauseStepForInput(step)
    instance.status = 'blocked'
    await this.updateBlockProgress(workspaceId, instance, 'blocked')
    await this.executionRepository.upsert(workspaceId, instance)
    await this.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_decision', decisionId: step.approval.id }
  }

  /**
   * The pure in-memory half of {@link advancePastResolvedGate}: stamp the gate step done
   * and move the run cursor (final step → run `done`; else start the next step). No
   * persistence and no external effects, so it is safe inside a {@link mutateInstance}
   * callback (which may re-run the mutation on a CAS retry). Returns whether the gate
   * was the final step.
   */
  advanceRunPastGate(instance: ExecutionInstance, stepIndex: number): boolean {
    const step = instance.steps[stepIndex]!
    this.stepGraph.finishStep(step)
    step.progress = 1
    const isFinalStep = stepIndex === instance.steps.length - 1
    if (isFinalStep) {
      instance.status = 'done'
    } else {
      instance.currentStep = stepIndex + 1
      const next = instance.steps[instance.currentStep]
      if (next) this.stepGraph.startStep(next)
      if (instance.status === 'blocked') instance.status = 'running'
    }
    return isFinalStep
  }

  /**
   * The side effects that follow an in-memory gate advance whose instance write already
   * happened (via {@link mutateInstance}): the block status/progress writes, the durable
   * driver's `approved` signal, and the emit. The instance itself is NOT re-persisted —
   * the CAS write is the source of truth.
   */
  async settleAdvancedGate(
    workspaceId: string,
    instance: ExecutionInstance,
    stepIndex: number,
  ): Promise<void> {
    const decisionId = instance.steps[stepIndex]!.approval!.id
    if (stepIndex === instance.steps.length - 1) {
      await this.finalizeBlock(workspaceId, instance, undefined)
      await this.stopRunContainer(workspaceId, instance)
    } else {
      await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    }
    await this.workRunner.signalDecision(workspaceId, instance.id, decisionId, 'approved')
    await this.emitInstance(workspaceId, instance)
  }

  /**
   * Finish a gate step whose decision a human resolved and advance the run: stamp the step
   * done, finalize the block (final step) or start the next, persist, signal the durable
   * driver that the decision is `approved`, and emit.
   */
  async advancePastResolvedGate(
    workspaceId: string,
    instance: ExecutionInstance,
    stepIndex: number,
  ): Promise<void> {
    const decisionId = instance.steps[stepIndex]!.approval!.id
    const isFinalStep = this.advanceRunPastGate(instance, stepIndex)
    if (isFinalStep) {
      await this.finalizeBlock(workspaceId, instance, undefined)
      await this.stopRunContainer(workspaceId, instance)
    } else {
      await this.updateBlockProgress(workspaceId, instance, 'in_progress')
    }
    await this.executionRepository.upsert(workspaceId, instance)
    await this.workRunner.signalDecision(workspaceId, instance.id, decisionId, 'approved')
    await this.emitInstance(workspaceId, instance)
  }

  /**
   * A pipeline finished. A frame becomes `done` (a mapping-only run leaves it
   * `ready`). A *task* never auto-`done`s from a confidence score any more — that
   * looked merged when the PR was still open with red CI. Instead:
   *   - if the pipeline has a `merger` step, it already owned the merge/notify
   *     decision (see `resolveMergerStep`); we only backstop a missing one;
   *   - otherwise the work is complete but unmerged: leave the PR open (`pr_ready`)
   *     and raise a `pipeline_complete` notification for a human to confirm + merge.
   * `done` now strictly means the PR was merged (see the engine's `finalizeMerge`).
   */
  async finalizeBlock(
    workspaceId: string,
    instance: ExecutionInstance,
    confidence: number | undefined,
  ): Promise<void> {
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block || block.status === 'done') return

    if ((block.level ?? 'frame') !== 'task') {
      // An initiative block's PLANNING run finishing means execution BEGINS, not that
      // the initiative is done — the block stays `in_progress`, and the execution loop
      // (a later slice) flips it terminal once every tracker item settles.
      if (instance.steps.some((s) => isInitiativeAgentKind(s.agentKind))) {
        await this.blockRepository.update(workspaceId, block.id, {
          status: 'in_progress',
          progress: 0,
        })
        return
      }
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
   * Record a terminal failure on a run: reclaim its container, mark it `failed` with the
   * richest failure record (first write wins), drop the block to `blocked` with the
   * progress it reached, and emit. The single funnel for every failure kind.
   */
  async failRun(
    workspaceId: string,
    executionId: string,
    message: string,
    kind: AgentFailureKind = 'agent',
    detail: string | null = null,
  ): Promise<void> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) return
    // Reclaim the per-run container on the failure path too: a failed run otherwise
    // leaves its container to idle out sleepAfter. This is the single funnel for
    // every failure kind (job_failed from the driver, the spend/decision timeouts,
    // and the user-facing stopRun, which already reclaimed — the call is idempotent).
    await this.stopRunContainer(workspaceId, instance)
    // The FIRST recorded failure wins: a run already in a terminal `failed` state keeps
    // its existing (richest) failure rather than being overwritten. An inline gate that
    // knows the precise kind/detail returns a `job_failed` result the driver funnels here,
    // so there should only ever be one write — but this guards against a future path that
    // both records a failure and returns `job_failed`, which would otherwise clobber the
    // good record with a generic one (the companion-rejected regression).
    if (instance.status === 'failed') return
    const failure: AgentFailure = {
      kind,
      message,
      detail,
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

  /** Reclaim the per-run container (per-job backends cancel the parked job; run-container
   * backends use the run id). Best-effort: a vanished container is nothing to reclaim. */
  async stopRunContainer(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    const executor = this.agentExecutor
    if (!isAsyncAgentExecutor(executor) || !executor.stopJob) return
    // The in-flight step's job id (when a job is parked), so a per-job backend can
    // cancel exactly it; the run-container backends ignore it and use the run id.
    const jobId = instance.steps[instance.currentStep]?.jobId ?? instance.id
    try {
      await executor.stopJob({ jobId, runId: instance.id, workspaceId })
    } catch {
      // The container may already be gone (eviction/completion) — nothing to reclaim.
    }
  }

  /** Raise the iteration-cap `decision_required` card when a review loop parks at its cap. */
  async raiseDecisionRequired(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    if (!this.notificationService) return
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    await this.notificationService.raise(workspaceId, {
      type: 'decision_required',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" ran out of automatic iterations and needs your decision`,
      body:
        'An automatic review loop reached its iteration cap without converging. Open the ' +
        'task to choose: one more round, proceed with the current result, or stop and reset.',
      payload: { pipelineName: instance.pipelineName },
    })
  }

  /**
   * Ensure an open notification exists for a run that has just parked waiting for a human
   * (an agent-raised decision, an approval gate, or an iterative review gate). Without
   * the old decision timeout the run waits indefinitely, so the inbox card — which the
   * periodic sweep escalates yellow → red — is the only signal a human is needed.
   *
   * Non-clobbering: if ANY open notification is already on the block (a more specific
   * `merge_review`, iteration-cap `decision_required`, etc.), it is left untouched and we
   * raise nothing — so the richer message wins. Best-effort: no notification service
   * (tests) or a missing block is a no-op.
   */
  async ensureWaitingNotification(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    const svc = this.notificationService
    if (!svc) return
    const open = await svc.listOpen(workspaceId)
    if (open.some((n) => n.blockId === instance.blockId)) return
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    await svc.raise(workspaceId, {
      type: 'decision_required',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" is waiting for your input`,
      body: 'A pipeline step is parked awaiting a human decision. Open the task to respond.',
      payload: { pipelineName: instance.pipelineName },
    })
  }

  /**
   * Clear the auto-raised "waiting for a human decision" card once a run advances past
   * the decision it was parked on (so the escalation sweep can't flip a settled decision
   * red). Scoped to the `decision_required` type, so the human-actionable cards a stopped
   * run leaves behind are untouched. Best-effort: no notification service (tests) is a no-op.
   */
  async clearWaitingNotification(workspaceId: string, instance: ExecutionInstance): Promise<void> {
    const svc = this.notificationService
    if (!svc) return
    await svc.clearWaitingDecision(workspaceId, instance.blockId)
  }
}
