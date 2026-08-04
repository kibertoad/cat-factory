import type {
  AgentRunContext,
  Block,
  ExecutionInstance,
  GateDefinition,
  PipelineStep,
} from '@cat-factory/kernel'
import { DEFAULT_RISK_POLICY, isAsyncAgentExecutor } from '@cat-factory/kernel'
import type { AgentExecutor } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunStateMachine } from './RunStateMachine.js'
import { recordDispatchAttribution } from './step-fold.logic.js'

// ---------------------------------------------------------------------------
// The gate ESCALATION half of the polling-gate machine: when a gate's precheck fails and the
// attempt budget allows, dispatch its helper container agent (`ci-fixer` / `conflict-resolver` /
// `fixer` / `on-call`) and park the run on that job.
//
// Extracted from `RunDispatcher` as a cohesive collaborator per the file-size rule (split along a
// seam, never grow the ratchet) — the `DeployerStepController` / `RunRepoOpsController` shape: a
// small deps object, and a thin delegate left on the dispatcher. The gate's own verdict logic +
// state machine stay in `evaluateGate`; this owns only "build the helper's context, start the
// job, record the attempt".
// ---------------------------------------------------------------------------

/** The collaborators the helper dispatch needs. */
export interface GateHelperDispatcherDeps {
  agentExecutor: AgentExecutor
  contextBuilder: AgentContextBuilder
  runStateMachine: RunStateMachine
}

export class GateHelperDispatcher {
  constructor(private readonly deps: GateHelperDispatcherDeps) {}

  /**
   * Dispatch a gate's helper container agent on a failed precheck: build the agent
   * context with the kind overridden to the helper (it clones the PR head branch and
   * pushes — no new PR), park on the job, and flip the gate to `working`. Idempotent
   * under replay via the step's `jobId` (re-attach handled in {@link evaluateGate}).
   */
  async dispatch(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    helper: { gate: GateDefinition; failureSummary?: string },
  ): Promise<AdvanceResult> {
    const { gate, failureSummary } = helper
    const executor = this.deps.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      // Defensive: evaluateGate only calls this when async-capable.
      return { kind: 'job_failed', error: `No async executor available for the ${gate.kind} gate.` }
    }
    // Build the context AS the helper kind: the hosting step's kind is the gate
    // (`ci` / `post-release-health`), so trait-driven context — the `code-aware`
    // service-fragment fold for `ci-fixer` / `on-call` — must key off the helper.
    const base = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
      { agentKind: gate.helperKind },
    )
    // A gate may build richer helper context asynchronously (the on-call agent gets the
    // full Datadog evidence bundle); otherwise fall back to the simple summary prior.
    const extras = gate.gatherHelperPriorOutputs
      ? await gate.gatherHelperPriorOutputs(
          workspaceId,
          block.id,
          step.gate ?? { phase: 'checking', attempts: 0, maxAttempts: 0 },
        )
      : [gate.helperPriorOutput?.(failureSummary ?? '')].filter(
          (o): o is { agentKind: string; output: string } => o != null,
        )
    // When the conflicts gate detected the conflict on a PEER repo (multi-repo task), hand the
    // conflict-resolver the target repo so the executor points it at THAT repo (own-service or
    // a connected service) instead of always the own service. Own-repo conflicts leave it absent
    // (`conflictTarget` carries no `frameId`), so the resolver targets the own repo as before.
    const conflictTarget = step.gate?.conflictTarget
    const context: AgentRunContext = {
      ...base,
      agentKind: gate.helperKind,
      priorOutputs: [...base.priorOutputs, ...extras],
      ...(conflictTarget?.frameId
        ? { conflictTarget: { repo: conflictTarget.repo, frameId: conflictTarget.frameId } }
        : {}),
    }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    recordDispatchAttribution(step, handle, context.agentKind)
    step.gate = {
      // Preserve the recorded verdict/failure detail (set in evaluateGate) so the UI
      // keeps showing what the helper is fixing while it works.
      ...step.gate,
      phase: 'working',
      attempts: (step.gate?.attempts ?? 0) + 1,
      maxAttempts: step.gate?.maxAttempts ?? DEFAULT_RISK_POLICY.ciMaxAttempts,
      headSha: step.gate?.headSha ?? null,
      // Stash the instructions this helper was handed (the failing-check summary / conflict
      // reason / human fix prompt) so the attempt recorded at its completion can show WHAT
      // this round set out to fix — the gate analogue of the Tester attempt's `concerns`.
      // Covers every dispatch path (the failed-precheck `probe.failureSummary` and the human
      // `pendingFix.instructions`), which both arrive here as `failureSummary`.
      lastDispatchedInstructions: failureSummary ?? step.gate?.lastDispatchedInstructions ?? null,
    }
    await this.deps.runStateMachine.casPersist(workspaceId, instance)
    await this.deps.runStateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }
}
