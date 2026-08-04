import type {
  AgentExecutor,
  AgentJobHandle,
  AgentRunContext,
  AgentRunResult,
  Block,
  BlockRepository,
  Clock,
  ExecutionInstance,
  PipelineStep,
  ProviderCapabilities,
  ResolveRunRepoContext,
  RunInitiatorScope,
} from '@cat-factory/kernel'
import { getErrorMessage, isAsyncAgentExecutor, parseLocalModelId } from '@cat-factory/kernel'
import { PR_REVIEWER_KIND, resolvePrNumber } from '@cat-factory/agents'
import { recordDispatchAttribution } from './step-fold.logic.js'
import { classifyDispatchFailure } from './job.logic.js'
import { initialPrReviewState } from './prReview.logic.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { DeployerStepController } from './DeployerStepController.js'
import type { RunRepoOpsController } from './RunRepoOpsController.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepHandlerContext } from './step-handler-registry.js'
import type { AdvanceOptions, AdvanceResult } from './advance.js'

/**
 * What the dispatch side of a step needs: the collaborators that BUILD a job (context,
 * registered pre-ops, the environment projection) and the one bound call-back into the
 * dispatcher's own settlement path for the inline case.
 */
export interface AgentDispatchDeps {
  agentExecutor: AgentExecutor
  blockRepository: BlockRepository
  clock: Clock
  contextBuilder: AgentContextBuilder
  deployer: DeployerStepController
  repoOps: RunRepoOpsController
  runStateMachine: RunStateMachine
  runInitiatorScope: RunInitiatorScope
  resolveRunRepoContext?: ResolveRunRepoContext
  resolveProviderCapabilities?: (
    workspaceId: string,
    userId: string | null | undefined,
    modelPresetId?: string,
  ) => Promise<ProviderCapabilities>
  modelIdIsMetered: (id: string | undefined, caps: ProviderCapabilities) => boolean
  recordStepResult: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ) => Promise<AdvanceResult>
}

/**
 * The DISPATCH half of a step, the sibling of `PollRunningController` / `PollCompletionController`
 * on the other side of the park: build the agent context, run the kind's pre-ops, then either
 * start an async container job and park, or make the inline LLM call and settle.
 *
 * It also owns the facts that can only be RECORDED AT DISPATCH, which is why they live with it
 * rather than with the poll: the durable poll path rebuilds its handle from the STEP alone, so the
 * resolved model, the job's attribution and the investigation diagnostics have to be stamped here
 * or they are silently absent in production (see the dispatch-attribution rule in CLAUDE.md).
 * `RunDispatcher` keeps thin delegates, so no call site moved.
 */
export class AgentDispatchController {
  constructor(private readonly deps: AgentDispatchDeps) {}

  /**
   * The generic container/inline-agent step — the lowest-priority StepHandler, claiming
   * every step no more-specific handler did (coder, architect, spec-writer, merger,
   * task-estimator, the container-backed companions, …). Builds the agent context, runs the
   * kind's pre-ops, then either dispatches an async container job and parks (the durable
   * driver polls between sleeps) or runs the inline LLM call and records the result. This is
   * what the dispatch chain falls through to; all the deterministic / gate / inline-review
   * kinds are claimed earlier by their own handlers (see {@link buildStepHandlerRegistry}).
   */
  async handleAgentStep(
    ctx: StepHandlerContext,
    dispatchKind?: string,
    augmentContext?: (context: AgentRunContext) => void,
  ): Promise<AdvanceResult> {
    const { workspaceId, instance, step, block, isFinalStep, options } = ctx

    // Async (container) steps don't block: dispatch the job and park. The durable
    // driver polls `pollAgentJob` between sleeps so the run can span far longer
    // than a single durable step's timeout, while each step stays short. A set
    // `jobId` means a prior (possibly replayed) dispatch already started the job,
    // so we re-attach instead of starting a duplicate.
    //
    // `dispatchKind` overrides the dispatched agent kind WITHOUT changing `step.agentKind`
    // — used by the fork-decision phase to dispatch the read-only `fork-proposer` explore
    // job as a HELPER off the coder step (Phase A). The completion still records against the
    // coder step, and the fork-proposal interceptor keys on `step.agentKind` + the fork state.
    const context = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
      dispatchKind ? { agentKind: dispatchKind } : undefined,
    )
    // A caller re-dispatching this step under an overriding kind can fold extra context in
    // (e.g. the PR-review `fix` resolution points the Fixer at the reviewed PR's head branch and
    // hands it the selected findings). Runs before pre-ops / dispatch so the job body sees it.
    augmentContext?.(context)
    // A registered custom kind's PRE-ops run deterministic backend repo work before the
    // agent dispatches (e.g. read a baseline `spec/` shard into the prompt). Gated on the
    // step not having dispatched yet so a Workflows replay (jobId already set) doesn't
    // re-run them; a no-op for built-in kinds and when GitHub isn't wired.
    if (!step.jobId) {
      await this.deps.repoOps.runRegisteredPreOps(workspaceId, instance, block, step, context)
    }
    const executor = this.deps.agentExecutor
    if (isAsyncAgentExecutor(executor) && executor.runsAsync(context)) {
      if (!step.jobId) {
        // The model is fixed the moment its ref resolves (block pin > workspace
        // default > env routing) — long before the container is up — so name it on
        // the very first "spinning up container" emit instead of waiting for the
        // dispatch to return. startJob confirms the same value below.
        const previewModel = await this.previewStepModel(context)
        if (previewModel) step.model = previewModel
        // Surface the explicit container lifecycle for the cold-boot window: dispatch
        // blocks until the per-run container is up and has accepted the job, so emitting
        // `starting` now lets the details show the boot (and then the live phase + the
        // container id/url) instead of a blank "working" state.
        step.container = { status: 'starting' }
        // Seed the in-flight PR-review state so a `pr-reviewer` run surfaces a real `reviewing`
        // phase in the deep-review window (the reviewed PR + the live slices-reviewed progress
        // off the step's todo subtasks) instead of an empty panel until the findings land. Only
        // on the reviewer's OWN first dispatch: a `fix`/`post` re-dispatch reuses this step under
        // an overriding kind and already carries `prReview` (`fixing`/`posting`), which must not
        // be reset back to `reviewing`.
        if (step.agentKind === PR_REVIEWER_KIND && !step.prReview) {
          const prUrl = block?.taskTypeFields?.prUrl?.trim() || null
          // Capture the PR head sha NOW (review start), so the `post` resolution can detect a
          // branch update between here and posting and fold drifted findings into the summary.
          const reviewedHeadSha = await this.resolveReviewedHeadSha(workspaceId, instance, block)
          step.prReview = initialPrReviewState(prUrl, step.model ?? null, reviewedHeadSha)
        }
        // Surface the block's ephemeral environment (if any) alongside the cold-boot
        // phase, so a run's details show the env spinning up next to the container.
        await this.deps.deployer.attachEnvironmentProjection(workspaceId, instance.blockId, step)
        await this.deps.runStateMachine.casPersist(workspaceId, instance)
        await this.deps.runStateMachine.emitInstance(workspaceId, instance)

        let handle: AgentJobHandle
        try {
          handle = await executor.startJob(context)
        } catch (error) {
          // Classify the throw (see {@link classifyDispatchFailure}). A genuine container
          // accept failure (HTTP/network/capacity) is framed as `dispatch` ("container failed
          // to start") with the EXACT provider response as detail; a dispatch-time eviction
          // routes to `evicted`. But a job is BUILT before any container is contacted, so a
          // precondition (e.g. `github_not_connected` — no connected repo) is a `preflight`
          // rejection that surfaces its own actionable message + machine-readable reason
          // instead of the misleading container framing.
          step.container = { status: 'errored' }
          await this.deps.runStateMachine.casPersist(workspaceId, instance)
          await this.deps.runStateMachine.emitInstance(workspaceId, instance)
          // Hand the classifier the step's run history so a container lost AFTER work began (a
          // failed eviction-recovery re-dispatch, `evictionRecoveries > 0`) is reported as an
          // unrecoverable eviction — with elapsed minutes + any partial slice count — rather than
          // the misleading "container failed to start". See ADR 0026 D1.
          return {
            kind: 'job_failed',
            ...classifyDispatchFailure(error, {
              evictionRecoveries: step.evictionRecoveries,
              transientEvictionRecoveries: step.transientEvictionRecoveries,
              startedAt: step.startedAt,
              sliceCount: step.prReview?.slices?.length,
            }),
          }
        }
        step.jobId = handle.jobId
        // Record the model at dispatch — the poll site can't resolve it later.
        recordDispatchAttribution(step, handle, context.agentKind)
        // Surface web-search availability + provider on the step (run details), resolved
        // backend-side at dispatch. A static per-run fact, not gated by prompt telemetry.
        if (handle.search) step.search = handle.search
        // Stamp after-the-fact investigation diagnostics for this dispatch: the step's
        // agent kind, resolved model, and repo — the facts a failure post-mortem needs but
        // that are otherwise spread across DB joins / the harness transcript. The execution
        // backend (native vs. container) is unknown until the transport reports it on the
        // first poll, so `pollAgentJob` fills it in then.
        this.recordDispatchDiagnostics(instance, context, handle)
        // The dispatch returned, so the container is up and the job is accepted; the
        // live phase + the container id/url arrive on the first poll.
        step.container = { status: 'up' }
        await this.deps.runStateMachine.casPersist(workspaceId, instance)
        await this.deps.runStateMachine.emitInstance(workspaceId, instance)
      }
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // Inline path: the model is resolved before the (blocking) LLM call, so surface
    // it now — the board names the model while the step is querying instead of only
    // once the result lands. recordStepResult re-asserts it from the result.
    const previewModel = await this.previewStepModel(context)
    if (previewModel && previewModel !== step.model) {
      step.model = previewModel
      await this.deps.runStateMachine.casPersist(workspaceId, instance)
      await this.deps.runStateMachine.emitInstance(workspaceId, instance)
    }

    const result = await this.runAgent(context, options)
    return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, result)
  }

  /**
   * Stamp the run's investigation diagnostics from a container dispatch (the `lastDispatch`
   * block + the control-plane host). Mutates `instance` in place; the caller upserts. Reflects
   * the MOST RECENT dispatch — a run's failure is almost always in its latest step, and keeping
   * one block (not a per-step history) keeps the record small. `executionBackend` is left for the
   * first poll to fill (the transport reports it). Never carries a token/secret.
   */
  private recordDispatchDiagnostics(
    instance: ExecutionInstance,
    context: AgentRunContext,
    handle: AgentJobHandle,
  ): void {
    // Orchestration is runtime-neutral (no @types/node), so read `process.platform` off globalThis
    // with a guard rather than the bare global — undefined on a runtime that doesn't expose it
    // (e.g. workerd), which just omits the host block. Best-effort investigation context.
    const platform = (globalThis as { process?: { platform?: string } }).process?.platform
    instance.diagnostics = {
      ...instance.diagnostics,
      lastDispatch: {
        stepIndex: instance.currentStep,
        agentKind: context.agentKind,
        ...(handle.model ? { model: handle.model } : {}),
        ...(handle.repo ? { repo: handle.repo } : {}),
        at: this.deps.clock.now(),
      },
      ...(platform ? { host: { platform } } : {}),
    }
  }

  /**
   * Fill in `diagnostics.lastDispatch.executionBackend` from the transport-reported backend on
   * the first poll that carries it (native host process vs. sandboxed container — the datum that
   * is otherwise indistinguishable after the fact). Idempotent: a no-op once set, or when the
   * update carries no backend / the dispatch block is missing. Returns whether it changed
   * anything (so the caller can skip a redundant upsert).
   */
  recordBackendDiagnostics(instance: ExecutionInstance, backend: string | undefined): boolean {
    const dispatch = instance.diagnostics?.lastDispatch
    if (!backend || !dispatch || dispatch.executionBackend === backend) return false
    instance.diagnostics = {
      ...instance.diagnostics,
      lastDispatch: { ...dispatch, executionBackend: backend },
    }
    return true
  }

  /**
   * Preview the model a step will run (`provider:model`) ahead of the work, so the
   * board can show it during the inline query / container cold-boot rather than only
   * once the result or job handle lands. Best-effort: the executor may not implement
   * a preview, and a resolution failure (e.g. an unwired container kind that fails at
   * dispatch anyway) must never break the run — both yield undefined.
   */
  async previewStepModel(context: AgentRunContext): Promise<string | undefined> {
    if (!this.deps.agentExecutor.resolveModel) return undefined
    try {
      return await this.deps.agentExecutor.resolveModel(context)
    } catch {
      return undefined
    }
  }

  /**
   * Whether the current step incurs NO metered monetary LLM cost, so the spend gate can
   * let it proceed even when the budget is exhausted. Two non-metered cases:
   *  - a flat-rate SUBSCRIPTION (quota) model — Claude Code / Codex on a pooled token;
   *    resolved through the executor (the authority on "subscriptions always win").
   *  - a LOCAL-runner model (Ollama / LM Studio / …) — keyless, runs on the user's own
   *    endpoint, so it costs the deployment nothing; detected off the resolved model id.
   * This is what makes a `0` budget mean "no PAID spend" without bricking a workspace that
   * deliberately runs only local models or subscriptions (see the spend-budget docs).
   *
   * Once the executor resolves the step's concrete model id, the metered/non-metered
   * decision is delegated to the SAME {@link modelIdIsMetered} predicate the up-front
   * {@link assertBudgetAllowsPipeline} gate uses, so the two gates can't classify a model
   * differently (a divergence would let a run pass the start gate then immediately pause,
   * or vice versa). The executor's `isQuotaBased` is still consulted first as the
   * authoritative subscription-routing signal; the shared predicate covers local-runner +
   * subscription-by-capability + Cloudflare classification identically to the start gate.
   * Falls back to a bare local-id check when no capability resolver is wired.
   *
   * Best-effort and side-effect-free: an executor without the capability, a missing block,
   * or any resolution error all report false (treated as budget-metered, the prior
   * behaviour). Only consulted on the over-budget path, so it never touches the happy path.
   */
  async currentStepIsNonMetered(
    workspaceId: string,
    instance: ExecutionInstance,
    step: ExecutionInstance['steps'][number],
  ): Promise<boolean> {
    try {
      const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
      if (!block) return false
      const isFinalStep = instance.currentStep === instance.steps.length - 1
      const context = await this.deps.contextBuilder.buildContext(
        workspaceId,
        instance,
        step,
        isFinalStep,
        block,
      )
      if (
        this.deps.agentExecutor.isQuotaBased &&
        (await this.deps.agentExecutor.isQuotaBased(context))
      ) {
        return true
      }
      if (this.deps.agentExecutor.resolveModel) {
        const modelId = await this.deps.agentExecutor.resolveModel(context)
        // Classify the resolved id through the shared predicate (same as the start gate)
        // when capabilities are wired; else fall back to the bare local-runner check.
        if (this.deps.resolveProviderCapabilities) {
          const caps = await this.deps.resolveProviderCapabilities(
            workspaceId,
            instance.initiatedBy,
            block.modelPresetId,
          )
          if (!this.deps.modelIdIsMetered(modelId, caps)) return true
        } else if (parseLocalModelId(modelId)) {
          return true
        }
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Resolve the reviewed PR's head sha at review-START, stamped onto `step.prReview` when the
   * `pr-reviewer` first dispatches. The `post` resolution later re-reads the PR head and folds
   * every finding into the summary when it moved (the frozen line numbers may have drifted). Best
   * effort: null on any failure, no PR number, or a client without the `pullRequestHeadSha`
   * capability — the drift check then simply doesn't run (posting falls back to per-line filtering).
   */
  private async resolveReviewedHeadSha(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block | null | undefined,
  ): Promise<string | null> {
    if (!block) return null
    const prNumber = resolvePrNumber(block.taskTypeFields ?? undefined)
    if (prNumber == null) return null
    try {
      const runRepo = await this.deps.resolveRunRepoContext?.(workspaceId, block.id)
      const headSha = runRepo?.repo.pullRequestHeadSha
      if (!headSha) return null
      return await this.deps.runInitiatorScope(
        { workspaceId, initiatedBy: instance.initiatedBy },
        () => headSha(prNumber),
      )
    } catch {
      return null
    }
  }

  /**
   * Invoke the agent for an already-built context. Failures are swallowed into the
   * step output so a run never wedges — unless `rethrowAgentErrors` is set (the
   * durable path), in which case the error propagates so the driver's per-step
   * retry can take over.
   */
  async runAgent(context: AgentRunContext, options: AdvanceOptions = {}): Promise<AgentRunResult> {
    try {
      return await this.deps.agentExecutor.run(context)
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
}
