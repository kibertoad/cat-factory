import type {
  AgentExecutor,
  AgentRunContext,
  Block,
  BlockRepository,
  BranchUpdater,
  EnvironmentHandle,
  ExecutionInstance,
  ExecutionRepository,
  HumanTestStepState,
  PipelineStep,
  WorkRunner,
} from '@cat-factory/kernel'
import { ConflictError, getErrorMessage, isAsyncAgentExecutor } from '@cat-factory/kernel'
import { isDeployStep } from '@cat-factory/integrations'
import {
  CONFLICT_RESOLVER_AGENT_KIND,
  FIXER_AGENT_KIND,
  HUMAN_TEST_AGENT_KIND,
} from './ci.logic.js'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

/** Render the human's findings as the resolved-context block handed to the fixer. */
function renderFindingsForFixer(findings: string): string {
  return [
    'A human tested the change in a live environment and found the issues below.',
    'Fix them and push to the PR branch; the environment will be rebuilt for re-testing.',
    '',
    findings.trim(),
  ]
    .join('\n')
    .trim()
}

/**
 * The engine collaborators the human-testing gate drives (kept on the engine, injected here).
 * The environment + branch-update seams are optional — absent ones put the gate into its
 * degraded "manual" mode rather than failing.
 */
export interface HumanTestControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  agentExecutor: AgentExecutor
  contextBuilder: AgentContextBuilder
  notificationService?: NotificationService
  /**
   * Read the environment the DEPLOYER provisioned for the block (wraps the env provisioning
   * service's block lookup). The human-test gate NO LONGER provisions its own environment — the
   * upstream `deployer` step is the single provisioner, and this reads its result. Absent (or a
   * `null` result — an infraless service / a deployer-less chain) ⇒ the gate degrades to manual
   * mode (test against the PR branch and confirm here).
   */
  readEnvironment?: (workspaceId: string, block: Block) => Promise<EnvironmentHandle | null>
  /** Tear an env down (wraps the env teardown service). Best-effort. */
  teardownEnvironment?: (workspaceId: string, environmentId: string) => Promise<void>
  /** Merge the repo default branch into the block's PR branch (server-side). */
  branchUpdater?: BranchUpdater
  /** The task's helper attempt budget (from the resolved merge preset). */
  resolveRiskPolicy: (workspaceId: string, block: Block) => Promise<{ ciMaxAttempts: number }>
  /** The async instance/block spine (park/advance/finalize/persist/emit/progress/stop). */
  stateMachine: RunStateMachine
  /** The pure step mutators (start/finish a step). */
  stepGraph: StepGraph
  clockNow: () => number
}

/** The settle outcome of a helper (fixer / conflict-resolver) job, as seen by the gate. */
type HelperUpdate = { state: 'done' } | { state: 'failed' }

/**
 * Drives the `human-test` gate: a non-LLM engine step where a HUMAN is the verdict. When the step
 * is reached it READS the environment the upstream `deployer` step provisioned (the deployer is the
 * single provisioner — the gate never stands its own env up) and PARKS, surfacing the live URL; a
 * person validates the change and then drives one of a handful of actions — confirm (tear the env
 * down + advance), request a fix from findings (dispatch the Tester's `fixer`, then rebuild the env
 * by re-running the deployer + re-park), pull main into the branch + redeploy (a clean merge loops
 * back to the deployer; a conflict dispatches the `conflict-resolver` first), recreate (re-run the
 * deployer), or destroy the env. Rebuilding always LOOPS BACK to the upstream deployer rather than
 * provisioning here. Modelled like the iterative review gates: the slow/awaiting work runs in the
 * durable driver (the human actions just record intent + signal), so the HTTP request the user is
 * no longer waiting on never blocks. When no environment was provisioned (an infraless service, or
 * a deployer-less chain) the gate degrades to manual mode. Extracted out of `ExecutionService`; the
 * shared step-graph primitives stay on the engine and are injected via {@link HumanTestControllerDeps}.
 */
export class HumanTestController {
  constructor(private readonly deps: HumanTestControllerDeps) {}

  // ---- driver-entry paths --------------------------------------------------

  /**
   * Run the gate from `stepInstance`. On FRESH entry (no state yet) it provisions an
   * environment and parks (or degrades to manual mode when no provider is wired). On RE-ENTRY
   * after a human action (a `pendingAction` is set on the parked step) it consumes that action.
   * Otherwise (a replay with no pending action) it re-derives from the current phase.
   */
  async evaluate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    const ht = step.humanTest
    if (ht?.pendingAction) {
      const action = ht.pendingAction
      ht.pendingAction = null
      // Checkpoint the consumed action BEFORE doing any slow/side-effecting work (a helper
      // dispatch is a real container). The driver runs `advance` inside a retriable durable
      // step: if the slow work succeeds but its later persist throws, the closure retries —
      // and unless the cleared `pendingAction` is already in storage it would re-consume the
      // action and dispatch a SECOND helper. Persisting now makes the dispatch at-most-once
      // (a crash between here and the dispatch merely drops the action; the human re-requests).
      await this.deps.stateMachine.persistInstance(workspaceId, instance)
      return this.handleAction(workspaceId, instance, step, block, isFinalStep, action)
    }
    if (!ht) return this.begin(workspaceId, instance, step, block)
    // Replay / re-entry with no pending action: re-derive from the phase. `provisioning` here means
    // the upstream deployer was (re-)run to (re)build the env and control has now returned to the
    // gate — read the fresh env and park (a loop-back sets this phase; see loopBackToDeployer).
    if (ht.phase === 'provisioning') {
      return this.readEnvAndPark(workspaceId, instance, step, block)
    }
    // A helper (fixer / conflict-resolver) is in flight: the step is `working` with a live
    // job, NOT parked. Re-attach to its job instead of re-parking, so a re-drive through
    // `advance` (the stale-run sweeper, or a durable replay that lost the `awaiting_job`
    // position) keeps polling the job rather than abandoning it.
    if ((ht.phase === 'fixing' || ht.phase === 'resolving_conflicts') && step.jobId) {
      return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
    }
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step, this.proposal(ht))
  }

  /**
   * A helper job (fixer / conflict-resolver) the gate dispatched has settled (delegated from
   * `pollAgentJob`). Record the round's outcome and rebuild the environment against the
   * (now-updated) branch, then re-park the human. We never fail the whole run here — the human
   * is in control and can request another fix.
   */
  async onHelperComplete(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    update: HelperUpdate,
  ): Promise<AdvanceResult> {
    const ht = step.humanTest
    if (!ht) return { kind: 'continue' }
    const rounds = ht.rounds ?? []
    const last = rounds[rounds.length - 1]
    if (last && !last.outcome) last.outcome = update.state === 'failed' ? 'failed' : 'completed'
    step.jobId = undefined
    step.subtasks = undefined
    // Reclaim the finished helper container before reprovisioning so a fresh env build
    // doesn't re-attach to the completed job by run id.
    await this.deps.stateMachine.stopRunContainer(workspaceId, instance)
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return { kind: 'noop' }
    return this.loopBackToDeployer(workspaceId, instance, step, block)
  }

  // ---- human actions (called from ExecutionService, driven server-side) ----

  /** The human confirmed the change works: tear the env down and advance the run. */
  async confirm(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.signalAction(workspaceId, blockId, { type: 'confirm' })
  }

  /** The human wrote findings and asked for a fix: dispatch the Tester's `fixer`. */
  async requestFix(
    workspaceId: string,
    blockId: string,
    findings: string,
  ): Promise<ExecutionInstance> {
    return this.signalAction(workspaceId, blockId, { type: 'request-fix', findings })
  }

  /** Pull the repo default branch into the PR branch + redeploy (conflict → conflict-resolver). */
  async pullMain(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.signalAction(workspaceId, blockId, { type: 'pull-main' })
  }

  /** Rebuild the ephemeral environment on demand. */
  async recreateEnvironment(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    return this.signalAction(workspaceId, blockId, { type: 'recreate' })
  }

  /**
   * Destroy the ephemeral environment on demand WITHOUT advancing — the run stays parked so the
   * human can recreate it (or confirm/test manually) later. Synchronous: no durable driver
   * involvement, since nothing about the run's position changes.
   */
  async destroyEnvironment(workspaceId: string, blockId: string): Promise<ExecutionInstance> {
    // Destroy is allowed both while parked (awaiting_human) AND during a deployer-driven rebuild
    // (the transient `provisioning` phase a loop-back sets) — a human must be able to drop the env
    // at either point.
    const { instance, step } = this.requireParked(await this.findActive(workspaceId, blockId))
    const ht = step.humanTest!
    await this.teardownCurrent(workspaceId, ht)
    if (ht.phase === 'provisioning') {
      // Mid-rebuild (the upstream deployer is re-running): just forget the env locally — the
      // re-entry (`readEnvAndPark`) reads the freshly-rebuilt one, or degrades if none stood up.
      ht.environment = null
    } else if (ht.environment) {
      ht.environment = { ...ht.environment, status: 'torn_down' }
    }
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return instance
  }

  // ---- internals -----------------------------------------------------------

  /** Fresh entry: read the environment the deployer provisioned (or degrade) and park the human. */
  private async begin(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult> {
    const maxAttempts = (await this.deps.resolveRiskPolicy(workspaceId, block)).ciMaxAttempts
    step.humanTest = {
      phase: 'provisioning',
      environment: null,
      attempts: 0,
      maxAttempts,
      rounds: [],
      ...(block.pullRequest?.branch ? { headSha: null } : {}),
    }
    return this.readEnvAndPark(workspaceId, instance, step, block)
  }

  /**
   * Read the environment the upstream `deployer` step provisioned for this block and park the human
   * on it. The deployer is the single provisioner and it runs BEFORE this gate, so a healthy env is
   * already `ready` here; anything else — no provider wired, no env stood up (an infraless service /
   * a deployer-less chain), or a not-ready/failed env — degrades to manual mode (test against the PR
   * branch and confirm here) rather than the gate provisioning anything itself.
   */
  private async readEnvAndPark(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult> {
    const ht = step.humanTest!
    if (!this.deps.readEnvironment) {
      return this.degrade(
        workspaceId,
        instance,
        step,
        block,
        'No ephemeral-environment provider is configured; test against the PR branch and confirm here.',
      )
    }
    let handle: EnvironmentHandle | null
    try {
      handle = await this.deps.readEnvironment(workspaceId, block)
    } catch (error) {
      return this.degrade(
        workspaceId,
        instance,
        step,
        block,
        `Could not read the environment (${getErrorMessage(error)}); test against the PR branch and confirm here.`,
      )
    }
    ht.environment = handle ? this.toEnvView(handle) : null
    if (handle?.status === 'ready') {
      ht.degradedReason = null
      return this.toAwaitingHuman(workspaceId, instance, step, block)
    }
    return this.degrade(
      workspaceId,
      instance,
      step,
      block,
      handle
        ? 'The environment is not ready yet; test against the PR branch and confirm here.'
        : 'No ephemeral environment was provisioned for this service (add a Deployer step before this gate, or test against the PR branch and confirm here).',
    )
  }

  /** Consume a human-requested action on re-entry. */
  private async handleAction(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    isFinalStep: boolean,
    action: NonNullable<HumanTestStepState['pendingAction']>,
  ): Promise<AdvanceResult> {
    const ht = step.humanTest!
    switch (action.type) {
      case 'confirm': {
        await this.teardownCurrent(workspaceId, ht)
        ht.phase = 'passed'
        if (ht.environment) ht.environment = { ...ht.environment, status: 'torn_down' }
        await this.clearReadyNotification(workspaceId, instance.blockId)
        return this.completeStep(workspaceId, instance, step, isFinalStep)
      }
      case 'request-fix':
        return this.dispatchHelper(workspaceId, instance, step, block, 'fix', action.findings ?? '')
      case 'pull-main':
        return this.pullMainInDriver(workspaceId, instance, step, block)
      case 'recreate':
        return this.loopBackToDeployer(workspaceId, instance, step, block)
    }
  }

  /** Pull main into the PR branch; clean → rebuild env; conflict → conflict-resolver. */
  private async pullMainInDriver(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult> {
    if (!this.deps.branchUpdater) {
      return this.toAwaitingHuman(workspaceId, instance, step, block)
    }
    let outcome: Awaited<ReturnType<BranchUpdater['updateFromBase']>>
    try {
      outcome = await this.deps.branchUpdater.updateFromBase(workspaceId, block.id)
    } catch {
      // The branch update failed (e.g. no PR): leave the human parked to retry/confirm.
      return this.toAwaitingHuman(workspaceId, instance, step, block)
    }
    if (outcome === 'conflict') {
      return this.dispatchHelper(workspaceId, instance, step, block, 'pull-main', '')
    }
    // merged / noop → rebuild the env against the updated branch.
    return this.loopBackToDeployer(workspaceId, instance, step, block)
  }

  /**
   * Dispatch a helper container — the Tester's `fixer` (from findings) or the
   * `conflict-resolver` (after a conflicting pull-main) — and park on its job. The gate's
   * phase tracks which helper is in flight; `onHelperComplete` rebuilds the env on its settle.
   */
  private async dispatchHelper(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    roundKind: 'fix' | 'pull-main',
    findings: string,
  ): Promise<AdvanceResult> {
    const ht = step.humanTest!
    const executor = this.deps.agentExecutor
    if (!isAsyncAgentExecutor(executor)) {
      return this.toAwaitingHuman(workspaceId, instance, step, block)
    }
    // Both helpers push onto the implementation PR branch, so they need one to exist.
    if (!block.pullRequest?.branch) {
      return this.toAwaitingHuman(workspaceId, instance, step, block)
    }
    const helperKind = roundKind === 'fix' ? FIXER_AGENT_KIND : CONFLICT_RESOLVER_AGENT_KIND
    const isFinalStep = instance.currentStep === instance.steps.length - 1
    // Build the context AS the helper kind, so trait-driven context (the `code-aware`
    // service-fragment fold for the fixer) keys off the helper, not the hosting step.
    const base = await this.deps.contextBuilder.buildContext(
      workspaceId,
      instance,
      step,
      isFinalStep,
      block,
      { agentKind: helperKind },
    )
    const context: AgentRunContext =
      roundKind === 'fix'
        ? {
            ...base,
            agentKind: helperKind,
            priorOutputs: [
              ...base.priorOutputs,
              { agentKind: HUMAN_TEST_AGENT_KIND, output: renderFindingsForFixer(findings) },
            ],
          }
        : { ...base, agentKind: helperKind }
    const handle = await executor.startJob(context)
    step.jobId = handle.jobId
    if (handle.model) step.model = handle.model
    // The dispatch returned, so the helper's per-run container is up; surface it via the
    // same `container` projection the Coder/Tester use (the live phase + id/url arrive on
    // the first poll). A finished cold-boot must NOT linger as a stale "spinning up".
    step.container = { status: 'up' }
    step.subtasks = undefined
    // Leave the parked decision state: while the helper runs the step is `working` with a
    // live job (like the Tester→Fixer loop), NOT `waiting_decision` on a stale approval. If
    // it stayed parked, a re-drive through `advance` (sweeper / replay) would re-park on the
    // old approval id and silently abandon the in-flight helper. The human re-parks on a
    // fresh approval once the helper settles (`onHelperComplete` → `toAwaitingHuman`).
    this.deps.stepGraph.startStep(step)
    step.approval = null
    ht.phase = roundKind === 'fix' ? 'fixing' : 'resolving_conflicts'
    ht.attempts += 1
    ht.rounds = [
      ...(ht.rounds ?? []),
      {
        kind: roundKind,
        findings:
          roundKind === 'fix' ? findings : 'Pulled latest main into the branch (conflicts).',
        helperKind,
        jobId: handle.jobId,
        outcome: null,
        at: this.deps.clockNow(),
      },
    ]
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return { kind: 'awaiting_job', jobId: step.jobId, stepIndex: instance.currentStep }
  }

  /**
   * Rebuild the environment by LOOPING BACK to the upstream `deployer` step (the single
   * provisioner): reset every step from the deployer through this gate, re-arm the deployer, and
   * re-drive. The deployer re-provisions against the (now-updated) branch, then control returns here
   * and {@link readEnvAndPark} reads the fresh env (via the repurposed `provisioning` phase in
   * {@link evaluate}). The fix-attempt budget + round history survive the reset (the cap lives on
   * `attempts`). When no deployer precedes the gate (an infraless service / a deployer-less chain)
   * there is nothing to rebuild through, so degrade to manual mode.
   */
  private async loopBackToDeployer(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult> {
    const humanTestIndex = instance.currentStep
    const deployerIndex = this.deps.stepGraph.nearestStepIndexBefore(
      instance.steps,
      humanTestIndex,
      (s) => isDeployStep(s.agentKind),
    )
    const ht = step.humanTest!
    if (deployerIndex < 0) {
      return this.degrade(
        workspaceId,
        instance,
        step,
        block,
        'No Deployer step precedes this gate, so the environment cannot be rebuilt automatically; test against the PR branch and confirm here.',
      )
    }
    // Reclaim the CURRENT env's real infra before rebuilding (best-effort): the deployer re-run
    // supersedes the registry row, but for a non-deterministic external id (e.g. a SHA-scoped
    // namespace on the async placeholder path) supersede can't identity-match it, so without an
    // eager teardown each rebuild would orphan the prior namespace until the TTL reaper. A no-op
    // when no env is currently held (e.g. a fixer-complete loop-back already dropped it).
    await this.teardownCurrent(workspaceId, ht)
    // `resetStepForRerun` clears a step's transient fields but not `humanTest`, so re-seed it
    // explicitly: preserve the fix-attempt budget + round history (the cap lives on `attempts`), and
    // set `provisioning` so the re-entry (once the deployer settles) reads the freshly-rebuilt env.
    const preserved: HumanTestStepState = {
      phase: 'provisioning',
      environment: null,
      attempts: ht.attempts,
      maxAttempts: ht.maxAttempts,
      rounds: ht.rounds ?? [],
      ...(ht.headSha !== undefined ? { headSha: ht.headSha } : {}),
    }
    this.deps.stepGraph.rerunRange(instance, deployerIndex, humanTestIndex)
    step.humanTest = preserved
    if (instance.status === 'blocked') instance.status = 'running'
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }

  /** Park in degraded (manual) mode: no live env, but the human can still test + confirm. */
  private async degrade(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
    reason: string,
  ): Promise<AdvanceResult> {
    const ht = step.humanTest!
    ht.degradedReason = reason
    return this.toAwaitingHuman(workspaceId, instance, step, block)
  }

  /** Flip to awaiting-human, summon the human (idempotent notification), and park. */
  private async toAwaitingHuman(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult> {
    const ht = step.humanTest!
    ht.phase = 'awaiting_human'
    await this.raiseReadyNotification(workspaceId, instance, block, ht)
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step, this.proposal(ht))
  }

  /** Finish the gate step and advance to the next step (or finish the run). No re-signal. */
  private async completeStep(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    isFinalStep: boolean,
  ): Promise<AdvanceResult> {
    this.deps.stepGraph.finishStep(step)
    step.progress = 1
    step.subtasks = undefined
    step.approval = null
    if (isFinalStep) {
      instance.status = 'done'
      await this.deps.stateMachine.finalizeBlock(workspaceId, instance, undefined)
      await this.deps.stateMachine.persistInstance(workspaceId, instance)
      await this.deps.stateMachine.emitInstance(workspaceId, instance)
      await this.deps.stateMachine.stopRunContainer(workspaceId, instance)
      return { kind: 'done' }
    }
    instance.currentStep += 1
    const next = instance.steps[instance.currentStep]
    if (next) this.deps.stepGraph.startStep(next)
    await this.deps.stateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    return { kind: 'continue' }
  }

  /**
   * Record the human's action on the parked gate step and wake the durable driver, which
   * re-enters {@link evaluate} and acts on it (the analogue of `incorporateRequirements`).
   * Re-arms the run to `running` first so the woken driver advances instead of no-oping.
   */
  private async signalAction(
    workspaceId: string,
    blockId: string,
    action: NonNullable<HumanTestStepState['pendingAction']>,
  ): Promise<ExecutionInstance> {
    const { instance, step } = this.requireParked(await this.findParked(workspaceId, blockId))
    const ht = step.humanTest!
    // Honour the resolved fix-attempt ceiling (the sibling Tester gate enforces the same
    // `ciMaxAttempts`). The human stays in control of the other actions (confirm / pull main /
    // recreate); only the findings-driven fix loop is capped, so it can't run away.
    if (action.type === 'request-fix' && ht.attempts >= ht.maxAttempts) {
      throw new ConflictError(
        `This task has reached its fix-attempt limit (${ht.maxAttempts}); confirm the change, pull main, or recreate the environment instead.`,
      )
    }
    ht.pendingAction = action
    if (instance.status === 'blocked') instance.status = 'running'
    await this.deps.stateMachine.persistInstance(workspaceId, instance)
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(
      workspaceId,
      instance.id,
      step.approval!.id,
      'human-test',
    )
    return instance
  }

  /** Locate the run + gate step a block's human-test gate is parked on (or null). */
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
        s.agentKind === HUMAN_TEST_AGENT_KIND &&
        s.state === 'waiting_decision' &&
        s.approval?.status === 'pending',
    )
    return step ? { instance, step } : null
  }

  /**
   * Locate the run + gate step for a block's ACTIVE human-test gate — parked for the human OR
   * still provisioning an env (the two phases a human can destroy from). Unlike {@link
   * findParked} it does not require a pending approval, so a provisioning env can be cancelled.
   */
  private async findActive(
    workspaceId: string,
    blockId: string,
  ): Promise<{ instance: ExecutionInstance; step: PipelineStep } | null> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block?.executionId) return null
    const instance = await this.deps.executionRepository.get(workspaceId, block.executionId)
    if (!instance) return null
    const step = instance.steps.find(
      (s) =>
        s.agentKind === HUMAN_TEST_AGENT_KIND &&
        (s.humanTest?.phase === 'awaiting_human' || s.humanTest?.phase === 'provisioning'),
    )
    return step ? { instance, step } : null
  }

  private requireParked(found: { instance: ExecutionInstance; step: PipelineStep } | null): {
    instance: ExecutionInstance
    step: PipelineStep
  } {
    if (!found) throw new ConflictError('No human-test gate is currently awaiting input')
    return found
  }

  /** Tear down the env tracked on the step (best-effort) and forget it locally. */
  private async teardownCurrent(workspaceId: string, ht: HumanTestStepState): Promise<void> {
    const id = ht.environment?.id
    if (!id || !this.deps.teardownEnvironment) return
    try {
      await this.deps.teardownEnvironment(workspaceId, id)
    } catch {
      // Best-effort: a failing provider must not wedge the gate. The TTL sweep reclaims it.
    }
  }

  /** Project an environment handle onto the compact view carried on the step. */
  private toEnvView(handle: EnvironmentHandle): HumanTestStepState['environment'] {
    return {
      id: handle.id,
      url: handle.url,
      status: handle.status,
      ...(handle.expiresAt != null ? { expiresAt: handle.expiresAt } : {}),
    }
  }

  private proposal(ht: HumanTestStepState): string {
    if (ht.environment?.url)
      return `Test the change at ${ht.environment.url}, then confirm or request a fix.`
    return 'Test the change, then confirm or request a fix.'
  }

  /** Summon the human to test (idempotent per block+type). Best-effort. */
  private async raiseReadyNotification(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block,
    ht: HumanTestStepState,
  ): Promise<void> {
    if (!this.deps.notificationService) return
    const where = ht.environment?.url
      ? `Test it at ${ht.environment.url}.`
      : 'Test it against the PR branch.'
    await this.deps.notificationService.raise(workspaceId, {
      type: 'human_test_ready',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" is ready for human testing`,
      body: `${where} Confirm it works to continue the pipeline, or request a fix with your findings.`,
      payload: {
        ...(block.pullRequest?.url ? { prUrl: block.pullRequest.url } : {}),
        pipelineName: instance.pipelineName,
      },
    })
  }

  /** Dismiss the "ready for testing" card once the gate passes. Best-effort. */
  private async clearReadyNotification(workspaceId: string, blockId: string): Promise<void> {
    const svc = this.deps.notificationService
    if (!svc) return
    const open = await svc.listOpen(workspaceId)
    for (const n of open) {
      if (n.type === 'human_test_ready' && n.blockId === blockId) {
        await svc.resolve(workspaceId, n.id, 'act')
      }
    }
  }
}
