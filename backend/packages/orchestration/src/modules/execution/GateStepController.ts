import type {
  AgentExecutor,
  Block,
  Clock,
  ExecutionInstance,
  GateDefinition,
  PipelineStep,
  RiskPolicy,
  RunInitiatorScope,
} from '@cat-factory/kernel'
import { isAsyncAgentExecutor } from '@cat-factory/kernel'
import type { DescriptorField } from '@cat-factory/contracts'
import { sanitizeDescriptorFields } from '@cat-factory/contracts'
import type { AgentRunResult } from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import type { GateHelperDispatcher } from './GateHelperDispatcher.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { SettledGate } from '../observability/GateOutcomeRecorder.js'

// ---------------------------------------------------------------------------
// The polling-gate STATE MACHINE: one generic evaluation shared by every registered gate
// (`ci` / `conflicts` / `post-release-health` / `human-review` / a deployment's own), driving
// the precheck-or-escalate loop and the `awaiting_gate` park.
//
// Extracted from `RunDispatcher` as a cohesive collaborator per the file-size rule (split along a
// seam, never grow the ratchet) — the `DeployerStepController` / `RunRepoOpsController` shape: a
// small deps object of bound call-backs, and a thin delegate left on the dispatcher. It composes
// {@link GateHelperDispatcher} (the escalation half); together they are the whole gate machine a
// `GateDefinition` plugs its differentiators into.
// ---------------------------------------------------------------------------

/** The collaborators the gate state machine needs. */
export interface GateStepControllerDeps {
  agentExecutor: AgentExecutor
  clock: Clock
  runStateMachine: RunStateMachine
  runInitiatorScope: RunInitiatorScope
  /**
   * The task's fully-resolved merge preset — the source of every gate's attempt budget + the
   * time windows a gate stashes on first entry. Structurally typed (rather than naming the
   * engine's resolved-policy type) so this collaborator stays independent of the merge module.
   */
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
  ) => Promise<
    Pick<RiskPolicy, 'ciMaxAttempts' | 'releaseMaxAttempts'> & {
      releaseWatchWindowMinutes: number
      humanReviewGraceMinutes: number
    }
  >
  /**
   * Record the gate's terminal verdict into the queryable `gate_outcomes` projection (the
   * operator dashboard's attempt statistics). Optional so a facade or test without the sink
   * wired runs unchanged: an unwired projection costs a dashboard section, never a run.
   */
  recordGateOutcome?: (settled: SettledGate) => Promise<void>
  /**
   * The per-step parameters the gate REGISTERED for a step kind declared, so the values frozen
   * onto the gate state can be reduced to the ones that declaration actually covers. Reads the
   * app-owned registry the dispatcher already holds rather than a second copy: what the builder
   * offered, what run admission validated and what a probe reads must be one declaration.
   */
  declaredGateFields: (agentKind: string) => readonly DescriptorField[] | undefined
  /** The engine's completion spine, so a passing gate finishes + advances like any step. */
  recordStepResult: (
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
    result: AgentRunResult,
  ) => Promise<AdvanceResult>
}

export class GateStepController {
  constructor(
    private readonly deps: GateStepControllerDeps,
    private readonly helpers: GateHelperDispatcher,
  ) {}

  /**
   * Evaluate a polling gate step once and decide (shared by the initial advance and the
   * durable `awaiting_gate` re-poll):
   *   - no provider wired → pass-through (advance; nothing to gate);
   *   - precheck passes   → advance to the next step (the helper agent is NEVER spun up);
   *   - still computing   → `awaiting_gate` (the driver sleeps then calls {@link pollGate});
   *   - fails, budget left → dispatch the helper container agent (`awaiting_job`);
   *   - fails, budget spent → the gate's exhaustion handler, then fail the run.
   */
  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    gate: GateDefinition,
  ): Promise<AdvanceResult> {
    // Re-attach after a replay: a helper is already in flight for this gate.
    if (step.gate?.phase === 'working' && step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }

    // Provider not wired: the gate is a pass-through so the engine works without it.
    if (!gate.wired()) {
      return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: gate.unwiredOutput,
      })
    }

    // Initialise the gate's state on first entry, resolving the attempt budget from the
    // task's merge preset (stable across polls once set).
    if (!step.gate) {
      const preset = await this.deps.resolveRiskPolicy(workspaceId, block)
      // The step's OWN parameters for this gate, validated against the gate's declared fields at
      // pipeline save and again at run admission. Copied onto the gate state once, alongside the
      // budget it may itself override, so every subsequent poll reads one settled snapshot rather
      // than re-deriving from a pipeline definition that is editable mid-run.
      //
      // SANITIZED on the way in, not merely validated, because this is where the value is FROZEN
      // onto the run. Validation deliberately skips a field whose `showWhen` currently fails, so
      // a stale answer under a hidden field reaches here having passed no type check; freezing it
      // would hand a gate's probe a value nothing ever inspected. Same rule, and the same helper,
      // every other descriptor form applies at its own write.
      const config = sanitizeDescriptorFields(
        this.deps.declaredGateFields(step.agentKind) ?? [],
        step.stepOptions?.gateConfig?.fields ?? {},
      )
      step.gate = {
        phase: 'checking',
        attempts: 0,
        maxAttempts: gate.attemptBudget ? gate.attemptBudget(preset, config) : preset.ciMaxAttempts,
        ...(Object.keys(config).length ? { config } : {}),
        headSha: null,
        // Stash the watch window once (read on every poll by a time-windowed gate's
        // probe; harmless/unused for the CI/conflicts gates).
        watchWindowMinutes: preset.releaseWatchWindowMinutes,
        // Stash the human-review grace window once (read by the human-review gate's probe;
        // harmless/unused for the other gates).
        humanReviewGraceMinutes: preset.humanReviewGraceMinutes,
      }
    }

    // A human-initiated fix request (an in-app freeform prompt, or a GitHub-comment
    // instruction) parked on the gate is dispatched immediately — bypassing the precheck +
    // grace window. Consume it at-most-once: clear + persist BEFORE the (side-effecting)
    // dispatch so a retried driver step can't re-dispatch a second fixer. Falls through to
    // the normal probe when there is no async executor to escalate to.
    if (step.gate.pendingFix && isAsyncAgentExecutor(this.deps.agentExecutor)) {
      const fix = step.gate.pendingFix
      step.gate.pendingFix = null
      await this.deps.runStateMachine.casPersist(workspaceId, instance)
      return this.helpers.dispatch(workspaceId, instance, step, block, isFinalStep, {
        gate,
        failureSummary: fix.instructions,
      })
    }
    // A time-windowed gate (post-release-health) marks when it began watching, on first
    // entry, so its probe knows whether the monitoring window has elapsed. Harmless for
    // the CI/conflicts gates, which ignore it.
    if (step.gate.watchSince == null) step.gate.watchSince = this.deps.clock.now()

    // Resolve the gate's GitHub reads (CI checks / mergeability) under the run
    // initiator's ambient context, so a per-user PAT (when set) is preferred over the
    // deployment's App/env token — see PatPreferringAppRegistry.
    const gateState = step.gate
    const probe = await this.deps.runInitiatorScope(
      { workspaceId, initiatedBy: instance.initiatedBy },
      () => gate.probe(workspaceId, block.id, gateState),
    )
    step.gate.headSha = probe.headSha
    // Multi-repo (service-connections phase 4): the CI / conflicts gates aggregate across every
    // PR the task opened; persist the per-repo head shas (and, for the conflicts gate, which repo
    // conflicted) so the run-detail UI can group checks by service and the conflict-resolver can
    // target the conflicted repo.
    step.gate.headShas = probe.headShas ?? null
    step.gate.conflictTarget = probe.conflictTarget ?? null
    // Persist the precheck outcome so the run-detail UI can surface why the gate is
    // looping (the failing checks / conflict reason) — detail that was previously fed
    // only to the helper agent and then discarded.
    step.gate.lastVerdict = probe.status
    step.gate.lastFailureSummary = probe.failureSummary ?? null
    step.gate.failingChecks = probe.failingChecks ?? null

    if (probe.status === 'pass') {
      // Stop the moment the precheck passes — finish the step and advance.
      await this.recordOutcome(workspaceId, instance, step, gate, 'passed')
      return this.deps.recordStepResult(workspaceId, instance, step, isFinalStep, {
        output: probe.passOutput ?? `${gate.kind} gate passed.`,
      })
    }

    if (probe.status === 'pending') {
      // Keep polling. Persist the head sha + phase so the board can reflect it.
      step.gate.phase = 'checking'
      await this.deps.runStateMachine.casPersist(workspaceId, instance)
      await this.deps.runStateMachine.emitInstance(workspaceId, instance)
      return { kind: 'awaiting_gate', stepIndex: instance.currentStep }
    }

    // probe.status === 'fail'.
    // A gate can decline escalation for a failure its helper can't fix (e.g. the conflicts
    // gate on a PEER-repo conflict it has no resolver for) — go straight to give-up instead
    // of burning the attempt budget on a helper that can't touch the problem.
    const canEscalate = isAsyncAgentExecutor(this.deps.agentExecutor) && probe.escalatable !== false
    if (canEscalate && step.gate.attempts < step.gate.maxAttempts) {
      return this.helpers.dispatch(workspaceId, instance, step, block, isFinalStep, {
        gate,
        failureSummary: probe.failureSummary,
      })
    }

    // Budget spent (or no async executor to escalate to): give up.
    await this.recordOutcome(workspaceId, instance, step, gate, 'exhausted')
    const { error } = await gate.onExhausted({
      workspaceId,
      instance,
      block,
      step,
      summary: probe.failureSummary,
    })
    return { kind: 'job_failed', error }
  }

  /**
   * Project the settled gate for the operator rollup. Recorded BEFORE the verdict is acted on
   * (the advance, or the gate's exhaustion handler) so a gate whose hand-off then throws is
   * still counted: the statistic is about what the gate DID, and a run that failed noisily
   * afterwards is exactly the one an operator is looking for. Never throws: the recorder is
   * best-effort internally, and an unwired one is a no-op.
   */
  private async recordOutcome(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    gate: GateDefinition,
    outcome: 'passed' | 'exhausted',
  ): Promise<void> {
    await this.deps.recordGateOutcome?.({
      workspaceId,
      instance,
      step,
      stepIndex: instance.currentStep,
      helperKind: gate.helperKind,
      outcome,
    })
  }
}
