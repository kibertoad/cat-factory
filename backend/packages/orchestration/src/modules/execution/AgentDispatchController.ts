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
import type { DispatchToolServers } from '@cat-factory/contracts'
import { PR_REVIEWER_KIND, resolvePrNumber } from '@cat-factory/agents'
import { recordDispatchedJob, recordInlineToolServers } from './step-fold.logic.js'
import { classifyDispatchFailure, type DispatchFailureClassification } from './job.logic.js'
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
      {
        ...(dispatchKind ? { agentKind: dispatchKind } : {}),
        // A set `jobId` means this call is a RE-ATTACH, not a dispatch: the job that produced the
        // tree already ran, under an earlier resolution. So the step's per-dispatch observability
        // (`selectedFragmentIds`, `validationConfigUnreadable`) must keep describing THAT read
        // rather than this one, or a store that has since recovered silently erases the record
        // that the shipped job ran with no checks.
        recordsDispatch: !step.jobId,
      },
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
      // Held as a local so the `awaiting_job` report below is a `string` on BOTH paths: this
      // dispatch's own stamp, or the id a Workflows replay re-entered with.
      let jobId = step.jobId
      if (!jobId) {
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
        // Stamp the investigation diagnostics BEFORE contacting anything, so the failures that
        // need them most still carry them: a container that never accepts the job and a
        // preflight rejection both leave `startJob` with no handle to read them off. The
        // handle refines this block below with what only the dispatch knows (the repo it
        // resolved, the model it confirmed).
        this.beginDispatchDiagnostics(instance, context, step.model ?? null)
        await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)

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
          // Hand the classifier the step's run history so a container lost AFTER work began (a
          // failed eviction-recovery re-dispatch, `evictionRecoveries > 0`, or the re-dispatch of a
          // step whose work-branch push was refused) is reported as what it is (an unrecoverable
          // eviction with elapsed minutes + any partial slice count, or a resume of already-pushed
          // commits) rather than the misleading "container failed to start". See ADR 0026 D1.
          const classified = classifyDispatchFailure(error, {
            evictionRecoveries: step.evictionRecoveries,
            transientEvictionRecoveries: step.transientEvictionRecoveries,
            branchContentionRecoveries: step.branchContentionRecoveries,
            startedAt: step.startedAt,
            sliceCount: step.prReview?.slices?.length,
          })
          // Fold the SAME classification onto the diagnostics block, before the persist below
          // carries it. The step's own failure fields are overwritten by a later retry of the
          // step; this survives as the record of what the run's last dispatch attempted.
          this.recordDispatchFailure(instance, classified)
          await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)
          return { kind: 'job_failed', ...classified }
        }
        jobId = recordDispatchedJob(step, handle, context.agentKind)
        // Surface web-search availability + provider on the step (run details), resolved
        // backend-side at dispatch. A static per-run fact, not gated by prompt telemetry.
        if (handle.search) step.search = handle.search
        // Refine the pre-dispatch block with what only the accepted dispatch knows: the repo
        // it resolved and the model it confirmed. The execution backend (native vs. container)
        // is unknown until the transport reports it on the first poll, so `pollAgentJob`
        // fills that in then.
        this.recordAcceptedDispatch(instance, handle)
        await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)
      }
      return { kind: 'awaiting_job', jobId, stepIndex: instance.currentStep }
    }

    // Inline path: the model is resolved before the (blocking) LLM call, so surface
    // it now — the board names the model while the step is querying instead of only
    // once the result lands. recordStepResult re-asserts it from the result.
    const previewModel = await this.previewStepModel(context)
    if (previewModel && previewModel !== step.model) step.model = previewModel
    // What an inline executor will do with this kind's tool servers, recorded HERE rather than off
    // the result, so it lands in the persist below and survives a call that then throws: the
    // container path stamps at dispatch for the same reason. Today's one producer is a
    // consensus-diverted step, which wires none and states them all as withheld; every other inline
    // run previews nothing and the step's record stays absent, which is what absent has always
    // meant here.
    recordInlineToolServers(step, await this.previewStepToolServers(context), context.agentKind)
    // An inline step dispatches nowhere, which is exactly why it used to stamp nothing and
    // left a run whose last step was inline reporting whatever CONTAINER step ran before it
    // (or nothing at all, on a pure inline pipeline) as where the run was when it died. It
    // names its backend as `inline` rather than leaving it for a poll that never comes.
    this.beginDispatchDiagnostics(instance, context, step.model ?? null, 'inline')
    // Persist UNCONDITIONALLY, exactly as the container path above does. The block is opened on
    // every dispatch, so there is always something new to write, and the inline call below runs
    // under `rethrowAgentErrors` on both durable drivers: its throw propagates past here and
    // `failRun` re-reads the instance from storage. Gating this on the model having changed left
    // the failure this block exists to explain with no diagnostics whenever the preview resolved
    // nothing or resolved what the step already carried.
    await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)

    const result = await this.runAgent(context, options)
    return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, result)
  }

  /**
   * Open the run's investigation diagnostics for a dispatch: the `lastDispatch` block with
   * everything known BEFORE the work is handed off (which step, which kind, the model its ref
   * resolved to) plus the control-plane host. Mutates `instance` in place; the caller upserts.
   *
   * REPLACES any previous block rather than merging into it, which is what keeps the record
   * honest across a re-dispatch: the facts of the last attempt (including whether it failed)
   * must not survive into the next one. Reflects the MOST RECENT dispatch only, because a run's
   * failure is almost always in its latest step, and one block instead of a per-step history
   * keeps the record small. Never carries a token/secret.
   */
  private beginDispatchDiagnostics(
    instance: ExecutionInstance,
    context: AgentRunContext,
    model: string | null,
    executionBackend?: string,
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
        ...(model ? { model } : {}),
        ...(executionBackend ? { executionBackend } : {}),
        at: this.deps.clock.now(),
      },
      ...(platform ? { host: { platform } } : {}),
    }
  }

  /**
   * Fold what an ACCEPTED dispatch resolved onto the block {@link beginDispatchDiagnostics}
   * opened: the repo the job operates on, and the model the executor confirmed (which is the
   * authority when the pre-dispatch preview could not resolve one). A no-op if no block is
   * open, which cannot happen on the dispatch path and keeps this safe to call anyway.
   */
  private recordAcceptedDispatch(instance: ExecutionInstance, handle: AgentJobHandle): void {
    const dispatch = instance.diagnostics?.lastDispatch
    if (!dispatch) return
    instance.diagnostics = {
      ...instance.diagnostics,
      lastDispatch: {
        ...dispatch,
        ...(handle.model ? { model: handle.model } : {}),
        ...(handle.repo ? { repo: handle.repo } : {}),
      },
    }
  }

  /**
   * Record that the open dispatch never reached a running job, in the engine's own dispatch
   * failure vocabulary. The step carries the same verdict, but a retry of the step overwrites
   * it, so this is what a later investigation reads for what the run's last attempt was doing
   * when it died.
   */
  private recordDispatchFailure(
    instance: ExecutionInstance,
    classified: DispatchFailureClassification,
  ): void {
    const dispatch = instance.diagnostics?.lastDispatch
    if (!dispatch) return
    instance.diagnostics = {
      ...instance.diagnostics,
      lastDispatch: {
        ...dispatch,
        failure: {
          kind: classified.failureKind,
          ...(classified.reason ? { reason: classified.reason } : {}),
          at: this.deps.clock.now(),
        },
      },
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
   * Preview what an inline dispatch will do with the running kind's tool servers (MCP), so the
   * step carries the record from dispatch rather than only once a result lands. Best-effort on
   * the same terms as {@link previewStepModel}: an executor without the capability and a
   * resolution failure both yield undefined, leaving the record absent, which is what an inline
   * step that resolves nothing has always left.
   */
  async previewStepToolServers(context: AgentRunContext): Promise<DispatchToolServers | undefined> {
    if (!this.deps.agentExecutor.previewToolServers) return undefined
    try {
      return await this.deps.agentExecutor.previewToolServers(context)
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
   * Side-effect-freedom is what `recordsDispatch: false` buys below, and it is load-bearing
   * rather than tidiness: this probe resolves a context WITHOUT starting a job, so recording
   * from it would state a dispatch that never happened, and clearing from it would erase the
   * record of one that did.
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
        { recordsDispatch: false },
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
