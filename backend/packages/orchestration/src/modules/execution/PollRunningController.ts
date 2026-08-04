import {
  type AgentJobUpdate,
  type BlockRepository,
  type Clock,
  ConflictError,
  type ExecutionInstance,
  NotFoundError,
  type PipelineStep,
  RunContendedError,
  recordGateAttempt,
  type GateDefinition,
  type GateHelperJobResult,
  type AgentRunResult,
  type RunInitiatorScope,
} from '@cat-factory/kernel'
import {
  applyContainerRunning,
  applyLastActivity,
  applySubtaskProgress,
} from './step-fold.logic.js'
import { applyValidationReport } from './validation.logic.js'
import { applySliceReviews } from './prReviewSlices.logic.js'
import { applyReproductionReport } from './reproductionProof.logic.js'
import { CONFLICTS_AGENT_KIND } from './ci.logic.js'
import {
  type ContainerFailureView,
  evictionFailureDetail,
  MAX_EVICTION_RECOVERIES,
  MAX_TRANSIENT_EVICTION_RECOVERIES,
} from './job.logic.js'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { DeployerStepController } from './DeployerStepController.js'
import type { FollowUpGateController } from './FollowUpGateController.js'
import type { SettledGate } from '../observability/GateOutcomeRecorder.js'

/**
 * Collaborators + bound call-backs the {@link PollRunningController} needs. The three
 * `gateFor` / `recordStepResult` / `recordBackendDiagnostics` hooks are bound dispatcher methods,
 * so a poll still runs against the SAME dispatcher state the inline code did.
 */
export interface PollRunningControllerDeps {
  blockRepository: BlockRepository
  clock: Clock
  runStateMachine: RunStateMachine
  deployer: DeployerStepController
  followUpGate: FollowUpGateController
  runInitiatorScope: RunInitiatorScope
  gateFor: (agentKind: string) => GateDefinition | undefined
  /**
   * Record a gate's terminal verdict into the `gate_outcomes` projection, for the ONE gate path
   * that settles here rather than in {@link GateStepController}: an investigate-don't-fix helper
   * finishing (`post-release-health` → `on-call`). Optional so a facade or test without the sink
   * runs unchanged; an unwired projection costs a dashboard row, never a run.
   */
  recordGateOutcome?: (settled: SettledGate) => Promise<void>
  recordStepResult: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ) => Promise<AdvanceResult>
  recordBackendDiagnostics: (instance: ExecutionInstance, backend: string | undefined) => boolean
}

/**
 * The RUNNING half of the agent-poll branch tree: folding a live container's delta onto the step
 * (subtask ticks, container phase, streamed follow-ups, the validation / reproduction / slice
 * republishes), returning a gate to `checking` once its helper finishes, and the shared
 * container-eviction recovery both the agent and deployer paths funnel through.
 *
 * The sibling of {@link PollCompletionController}, which owns the SETTLED half — extracted from
 * {@link RunDispatcher} on the same seam and for the same reason (the dispatcher's poll entry
 * points stay under their size/complexity ceilings), taking a deps object of bound dispatcher
 * call-backs.
 */
export class PollRunningController {
  constructor(private readonly deps: PollRunningControllerDeps) {}

  /**
   * Handle a `running` poll: a successful poll proves the container is up, so surface live subtask
   * progress (e.g. 3/8 todos) without advancing the step. Only persist + emit when something
   * actually changed so an idle poll doesn't churn storage or the event stream. Folds the poll's
   * delta via {@link applyRunningFold} — a cheap pre-check against the loaded snapshot, then the
   * authoritative re-apply on fresh state under CAS (idempotent for the set-to-latest folds and
   * correct for the drain-on-read follow-up append). Split from {@link pollAgentJobInner} to stay
   * under the statement ceiling.
   */
  async handleRunningPoll(
    workspaceId: string,
    executionId: string,
    instance: ExecutionInstance,
    update: Extract<AgentJobUpdate, { state: 'running' }>,
    jobId: string,
  ): Promise<AdvanceResult> {
    const foldCtx = { jobId, update, workspaceId }
    // Cheap pre-check against the loaded snapshot: skip the write entirely on an idle poll
    // (the common case). The mutation is discarded — the authoritative write re-applies the
    // same fold on fresh state under CAS below.
    if (await this.applyRunningFold(instance, foldCtx)) {
      try {
        const persisted = await this.deps.runStateMachine.mutateInstance(
          workspaceId,
          executionId,
          async (fresh) => {
            await this.applyRunningFold(fresh, foldCtx)
          },
        )
        // Progress-only fold (subtask ticks / streamed follow-ups): skip the per-run
        // LLM-metrics GROUP BY so a live container's poll cadence doesn't re-aggregate
        // the run on every tick. The rollup refreshes on the step-boundary/terminal emit.
        await this.deps.runStateMachine.emitInstance(workspaceId, persisted, {
          rollUpMetrics: false,
        })
      } catch (error) {
        // The run was cancelled/removed mid-poll (`NotFoundError`) or stayed hot-contended
        // past the retry budget (`ConflictError`) — re-drive on fresh state rather than
        // failing the run; the next entry no-ops on a gone/terminal run.
        if (error instanceof NotFoundError || error instanceof ConflictError) {
          throw new RunContendedError(executionId)
        }
        throw error
      }
    }
    return { kind: 'awaiting_job', jobId, stepIndex: instance.currentStep }
  }

  /**
   * A gate whose helper INVESTIGATES instead of fixing (post-release-health → on-call) declares a
   * `resolveHelperCompletion` hook. When such a helper's job settles — done OR failed — call the
   * hook INSTEAD of re-probing the precheck (re-probing an investigate-don't-fix helper would just
   * regress again and burn the budget) and finish the gate step with the output it returns. Returns
   * the resulting {@link AdvanceResult}, or `null` when this branch doesn't apply (the caller falls
   * through to the re-probe / other completion paths).
   */
  async resolveInvestigateHelperCompletion(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    update: AgentJobUpdate,
  ): Promise<AdvanceResult | null> {
    const completionGate = this.deps.gateFor(step.agentKind)
    if (
      completionGate?.resolveHelperCompletion &&
      step.gate?.phase === 'working' &&
      (update.state === 'done' || update.state === 'failed')
    ) {
      const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
      step.jobId = undefined
      step.subtasks = undefined
      if (!block) return { kind: 'noop' }
      const isFinalStep = instance.currentStep === instance.steps.length - 1
      const jobResult: GateHelperJobResult =
        update.state === 'done'
          ? { state: 'done', result: update.result }
          : { state: 'failed', error: update.error ?? null }
      const resolution = await completionGate.resolveHelperCompletion({
        workspaceId,
        instance,
        block,
        step,
        result: jobResult,
      })
      // This is a TERMINAL gate verdict, so it joins the operator projection like the ones the
      // precheck machine settles. Recorded as `exhausted`: the gate ended without the precheck
      // going green and a human owns the outcome out-of-band (`on-call` raises
      // `release_regression` and never reverts), which is the distinction that bucket carries.
      // Recorded BEFORE the hand-off for the same reason `GateStepController` does it: a gate
      // whose resolution then throws is exactly the one an operator is looking for.
      await this.deps.recordGateOutcome?.({
        workspaceId,
        instance,
        step,
        stepIndex: instance.currentStep,
        helperKind: completionGate.helperKind,
        outcome: 'exhausted',
      })
      // Preserve the done-result's fields (usage metering etc.) while recording the gate's
      // resolved output; a failed investigation has no result to carry.
      const base: AgentRunResult = update.state === 'done' ? update.result : { output: '' }
      return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
        ...base,
        output: resolution.output,
      })
    }
    return null
  }

  /**
   * Fold a running poll's container signals into `step.container`: a successful poll
   * proves the container is `up`, and the harness's live phase (clone / agent / push)
   * plus the transport's container id/url enrich it. Returns whether anything changed,
   * so the caller only persists + emits on a real transition (an idle poll is a no-op).
   * Prior id/url/phase are preserved when a poll omits them (drain-on-read semantics).
   */
  /**
   * Fold a running poll's live delta (container status/phase, subtask counts, backend, streamed
   * follow-ups, env projection) onto `target`, returning whether anything changed. Idempotent for
   * the set-to-latest folds and correct under CAS retry for the drain-on-read follow-up append —
   * see the call site in {@link pollAgentJobInner}. A concurrent write that advanced the step (or
   * superseded the job) makes it a no-op.
   */
  private async applyRunningFold(
    target: ExecutionInstance,
    ctx: {
      jobId: string
      update: Extract<AgentJobUpdate, { state: 'running' }>
      workspaceId: string
    },
  ): Promise<boolean> {
    const { jobId, update, workspaceId } = ctx
    const s = target.steps[target.currentStep]
    // The step advanced (or the job was superseded) under a concurrent write — nothing to fold.
    if (!s || s.jobId !== jobId) return false
    let changed = false
    if (applyContainerRunning(s, update)) changed = true
    if (applySubtaskProgress(s, update.subtasks)) changed = true
    // Persist the harness liveness heartbeat (throttled) so a quiet-but-alive container keeps the
    // run's `updated_at` fresh — the signal a long, output-less phase (a reviewer reading files)
    // would otherwise never emit, leaving it indistinguishable from a wedged run to the sweeper + UI.
    if (applyLastActivity(s, update.lastActivityAt)) changed = true
    // Republish the latest pre-PR validation attempt so the repair loop is visible WHILE it
    // runs ("lint failed, repairing — attempt 2 of 3") instead of only at the end.
    if (applyValidationReport(s, update.validationReport)) changed = true
    // Republish the reproduction proof so a failed verification is visible WHILE the repair loop
    // still runs, for the same reason as the validation republish above.
    if (applyReproductionReport(s, update.reproductionReport)) changed = true
    // Persist each PR-review slice's captured report as its subagent returns. Unlike the two
    // republishes above this is not for visibility: the reviewer emits findings only in its
    // terminal output, so this is the one thing that makes finished slices survive a review that
    // never gets there, and the only state a manual resume can preserve work from.
    if (applySliceReviews(s, update.sliceReviews)) changed = true
    // The transport reports WHICH backend served the job on the first poll (native host
    // process vs. sandboxed container) — record it in the run diagnostics.
    if (this.deps.recordBackendDiagnostics(target, update.backend)) changed = true
    // Append any forward-looking items the Coder streamed since the last poll so the
    // Follow-up companion lights up + accrues items LIVE while the container still runs.
    if (this.deps.followUpGate.appendStreamedFollowUps(s, update.followUps)) changed = true
    // Refresh the env projection so its status transitions (provisioning→ready→
    // expired/torn_down) and any error stay live in the run details during the run.
    if (await this.deps.deployer.attachEnvironmentProjection(workspaceId, target.blockId, s)) {
      changed = true
    }
    return changed
  }

  /**
   * A polling gate step's in-flight job is its helper agent (ci-fixer / conflict-resolver / the
   * human-review fixer), NOT the step's own work: when it finishes (or fails) we don't record a
   * result or advance — we run any deterministic post-helper bookkeeping hook, record the attempt,
   * drop the handle, return the gate to `checking`, and re-run the precheck (the helper's push
   * triggers a fresh CI run / updates mergeability). A helper that failed without pushing leaves the
   * precheck negative, so the next check re-dispatches (until the attempt budget is spent). Split
   * from {@link pollAgentJobInner} to keep it under the complexity ceiling.
   */
  async reprobeGateAfterHelper(
    gate: GateDefinition,
    ctx: {
      workspaceId: string
      instance: ExecutionInstance
      step: PipelineStep
      update: Extract<AgentJobUpdate, { state: 'done' } | { state: 'failed' }>
    },
  ): Promise<AdvanceResult> {
    const { workspaceId, instance, step, update } = ctx
    // A gate may need deterministic GitHub-side bookkeeping to land BEFORE the re-probe
    // reads it (the human-review gate replies to + RESOLVES the threads it handed the
    // fixer, so the next probe counts them addressed). Run that side-effect hook first;
    // it does NOT replace the re-probe (unlike resolveHelperCompletion).
    if (gate.onHelperComplete && step.gate) {
      const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
      if (block) {
        const jobResult: GateHelperJobResult =
          update.state === 'done'
            ? { state: 'done', result: update.result }
            : { state: 'failed', error: update.error ?? null }
        await this.deps.runInitiatorScope({ workspaceId, initiatedBy: instance.initiatedBy }, () =>
          gate.onHelperComplete!({
            workspaceId,
            instance,
            block,
            step,
            result: jobResult,
          }),
        )
      }
    }
    // Record the just-finished helper attempt before re-probing. The gate's next
    // precheck stays the source of truth for pass/fail, but the helper's own account
    // (what it did, and for the conflict-resolver which files it left conflicting) is
    // otherwise discarded here — leaving the gate window with only a bare attempt
    // count. Capture it so the UI can show what each attempt tried.
    if (step.gate) {
      const attempt = recordGateAttempt(
        step.gate,
        update.state === 'done'
          ? { state: 'done', output: update.result.output ?? null }
          : { state: 'failed', error: update.error ?? null },
        this.deps.clock.now(),
      )
      step.gate.attemptLog = [...(step.gate.attemptLog ?? []), attempt]
      // Same reasoning for the helper's effort self-assessment: a gate step runs no agent of
      // its own, so its report is its LAST helper's (what made fixing CI / resolving the
      // conflicts hard). This path deliberately never records a result, so without this the
      // gate window could only ever show a bare attempt count.
      if (update.state === 'done' && update.result.effortReport) {
        step.effortReport = update.result.effortReport
      }
      // The conflicts gate's precheck carries no failure detail of its own (GitHub
      // reports mergeability as a single bit), so surface the resolver's account as
      // the gate's last failure summary. CI's probe already sets a richer summary
      // (the red checks) — don't clobber it with the fixer's push note.
      if (step.agentKind === CONFLICTS_AGENT_KIND && attempt.summary) {
        step.gate.lastFailureSummary = attempt.summary
      }
    }
    step.jobId = undefined
    step.subtasks = undefined
    if (step.gate) step.gate.phase = 'checking'
    await this.deps.runStateMachine.casPersist(workspaceId, instance)
    await this.deps.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
  }

  /**
   * Shared container-eviction recovery for an async step (agent or deployer). When `error` is a
   * container-eviction error and the per-flavour budget (transient vs genuine) isn't spent, resets
   * the step so the driver re-dispatches a fresh container (returns `continue`); once the budget is
   * spent, marks the container errored and returns the terminal `job_evicted`. Returns null when
   * `error` is NOT an eviction, so the caller proceeds with its own genuine-failure handling.
   * `onBeforeRedispatch` runs the kind-specific reclaim (the deployer releases its separately
   * dispatched deploy-job runner) before the step state is reset. Keeps the eviction budgets +
   * the user-facing "still evicting…" wording uniform across the agent and deployer paths.
   */
  async recoverContainerEviction(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    failure: ContainerFailureView,
    onBeforeRedispatch?: () => Promise<void>,
  ): Promise<AdvanceResult | null> {
    const { error, evicted, detail } = failure
    // The eviction verdict rides the transport's STRUCTURED `evicted` field (every transport
    // mints it). Absent ⇒ not an eviction, so the caller proceeds with genuine-failure handling.
    const kind = evicted
    if (!kind) return null
    const transient = kind === 'transient'
    const limit = transient ? MAX_TRANSIENT_EVICTION_RECOVERIES : MAX_EVICTION_RECOVERIES
    const recoveries = transient
      ? (step.transientEvictionRecoveries ?? 0)
      : (step.evictionRecoveries ?? 0)
    if (recoveries < limit) {
      if (transient) step.transientEvictionRecoveries = recoveries + 1
      else step.evictionRecoveries = recoveries + 1
      // Retain the FIRST death's post-mortem before re-dispatching: the dead container is
      // removed right now, so this recovery is the last moment its evidence exists — and it is
      // usually the informative one (the retry is a fresh container hitting the same wall).
      // `evictionFailureDetail` folds it into the failure if the budget later runs out.
      if (detail && !step.firstEvictionDetail) step.firstEvictionDetail = detail
      if (onBeforeRedispatch) await onBeforeRedispatch()
      step.jobId = undefined
      step.subtasks = undefined
      step.progress = 0
      // The container vanished and a fresh one is about to boot for the re-dispatch, so the
      // details show it spinning up again rather than a stale "up".
      step.container = { status: 'starting' }
      await this.deps.runStateMachine.casPersist(workspaceId, instance)
      await this.deps.runStateMachine.emitInstance(workspaceId, instance)
      return { kind: 'continue' }
    }
    // Eviction budget spent — the container is gone for good. Mark it errored and persist so the
    // failed details show the errored container (failRun re-reads the run from storage, so an
    // in-memory-only mutation would be lost; it emits the terminal frame, so markContainerErrored
    // deliberately doesn't).
    await this.markContainerErrored(workspaceId, instance, step)
    // The transports' post-mortems of the containers that died (exit state + log tail). Each
    // container is reclaimed as the run settles or re-dispatches, so this is the only place the
    // cause survives — carry it onto the failure rather than reporting a bare "still evicting".
    const evictionDetail = evictionFailureDetail(step.firstEvictionDetail, detail)
    return {
      kind: 'job_evicted',
      error: transient
        ? `${error} (still evicting after ${recoveries} automatic restarts through the infrastructure churn — treating as deterministic)`
        : `${error ?? 'Container evicted'} (still evicting after ${recoveries} automatic container restart${recoveries === 1 ? '' : 's'} — treating as deterministic)`,
      ...(evictionDetail ? { detail: evictionDetail } : {}),
    }
  }

  /**
   * Mark a container step's container `errored` (preserving the id/url/phase it reached) and
   * PERSIST it, so a failed run's details show the errored container. Called on the genuine
   * job-failure / exhausted-eviction paths before the result funnels to `failRun`, which
   * re-reads the run from storage (so an in-memory-only mutation here would be lost) and emits
   * the terminal frame itself — so we deliberately persist WITHOUT emitting here, to avoid a
   * redundant transient "errored but still running" broadcast right before the "failed" one.
   */
  async markContainerErrored(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<void> {
    step.container = { ...step.container, status: 'errored' }
    await this.deps.runStateMachine.casPersist(workspaceId, instance)
  }
}
