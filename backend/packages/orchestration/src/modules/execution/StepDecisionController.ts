import {
  type AgentExecutor,
  type AgentFailureKind,
  type Block,
  type BlockRepository,
  type Clock,
  ConflictError,
  type ExecutionInstance,
  type ExecutionRepository,
  NotFoundError,
  type PipelineStep,
  ValidationError,
  type StepReviewComment,
  type WorkRunner,
  assertFound,
} from '@cat-factory/kernel'
import { type AgentKindRegistry, companionTargets, isCompanionKind } from '@cat-factory/agents'
import { isAsyncAgentExecutor } from '@cat-factory/kernel'
import { isDryRun } from '@cat-factory/contracts'
import type { ReviewEffort } from '@cat-factory/contracts'
import { HUMAN_REVIEW_AGENT_KIND } from './ci.logic.js'
import { type DedicatedParkSurface, dedicatedParkSurface } from './step-park.logic.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'
import type { RunMergePolicy } from './RunMergePolicy.js'
import type { FinalizeMergeResult } from './MergeResolver.js'
import type { RunDispatcher } from './RunDispatcher.js'

/**
 * Collaborators + bound engine call-backs the {@link StepDecisionController} needs. The five
 * call-backs (`requireWorkspace` / `requireBlock` / `failRun` / `finalizeMerge`) are bound
 * {@link ExecutionService} methods, so a decision still runs against the SAME engine state the
 * inline code did.
 */
export interface StepDecisionControllerDeps {
  agentExecutor: AgentExecutor
  agentKindRegistry: AgentKindRegistry
  blockRepository: BlockRepository
  clock: Clock
  executionRepository: ExecutionRepository
  mergePolicy: RunMergePolicy
  runDispatcher: RunDispatcher
  runStateMachine: RunStateMachine
  stepGraph: StepGraph
  workRunner: WorkRunner
  requireWorkspace: (workspaceId: string) => Promise<unknown>
  requireBlock: (workspaceId: string, id: string) => Promise<Block>
  failRun: (
    workspaceId: string,
    executionId: string,
    message: string,
    kind?: AgentFailureKind,
    detail?: string | null,
    reason?: string | null,
  ) => Promise<void>
  finalizeMerge: (workspaceId: string, blockId: string) => Promise<FinalizeMergeResult>
}

/**
 * The HUMAN decision surface on a parked run: resolve a decision, approve / request changes on /
 * reject a gated proposal, ask the human-review gate for a fix, and merge (or decline to merge)
 * the PR a finished run left behind. Every one of these is reached from the SPA or the public
 * API when a person acts on a run the engine deliberately stopped — as opposed to the engine's
 * own advance path, which is the dispatcher's.
 *
 * Extracted from {@link ExecutionService} as a cohesive collaborator (the `RunDispatcher`
 * controller pattern: a deps object of bound engine call-backs), so the engine service keeps the
 * run state machine and this file keeps the decisions people make about it. The engine exposes
 * thin delegates, so no HTTP call site changed.
 */
/**
 * What to tell somebody who reached for the generic approve/request-changes/reject verbs on a park
 * a dedicated surface owns: the window that DOES resolve it, and the verbs it offers.
 *
 * A total `Record` over {@link DedicatedParkSurface} on purpose — a park kind added to the shared
 * classifier fails to compile until it has a sentence here, where a `switch` with a default would
 * quietly hand the operator the generic wording for a surface they cannot find.
 */
const WRONG_SURFACE_MESSAGES: Record<DedicatedParkSurface, string> = {
  'input-gate':
    "Resolve this run's input check through its notice (fix the task and re-check, or proceed anyway), not the approval gate",
  'requirements-review':
    'Resolve the requirements review through its review window, not the approval gate',
  'clarity-review': 'Resolve the clarity review through its review window, not the approval gate',
  brainstorm: 'Resolve the brainstorm through its brainstorm window, not the approval gate',
  'human-test':
    'Resolve the human-testing gate through its window (confirm / request a fix), not the approval gate',
  'visual-confirmation':
    'Resolve the visual-confirmation gate through its window (approve / request a fix), not the approval gate',
  interview: 'Resolve the interview through its interview window, not the approval gate',
  'companion-cap':
    'Resolve this companion review through its iteration-cap prompt, not the approval gate',
  'follow-ups':
    'Resolve the follow-up companion through its window (file / send back / answer / dismiss), not the approval gate',
  // Approving here would advance the run PAST the coder step with the build never run (the park
  // sits between the proposer and the Coder dispatch).
  'fork-decision':
    'Resolve the implementation-fork decision through its fork window (choose an approach), not the approval gate',
}

export class StepDecisionController {
  constructor(private readonly deps: StepDecisionControllerDeps) {}

  /**
   * Several gates park on a `step.approval` but are NOT generic prose approvals — they are
   * driven by their own dedicated surface, never the generic approve/request-changes/reject
   * resolvers (which would advance the run bypassing the loop). Guard those resolvers so a stray
   * approve can't short-circuit any of them.
   *
   * WHICH parks those are is {@link dedicatedParkSurface}'s answer, shared with the public API's
   * decision projection: the same distinction decides whether a caller is refused here and
   * whether that caller was offered the generic verbs in the first place, and two copies of the
   * list would drift into refusing a park one surface still advertises. This function owns only
   * the REFUSAL — which sentence names the right window to go to instead.
   */
  private assertNotIterativeGate(instance: ExecutionInstance, step: PipelineStep): void {
    const surface = dedicatedParkSurface(instance, step, this.deps.agentKindRegistry)
    if (!surface) return
    throw new ConflictError(
      WRONG_SURFACE_MESSAGES[surface],
      // Only the input gate carries a machine-readable reason today: it is the one refusal the
      // SPA maps to its own remedy copy (go and edit the task), the others being in-app routing
      // a person reads. `input_gate_parked`, NOT `input_gate_not_parked`: the gate IS holding this
      // run and the caller reached for the wrong surface, where the sibling reason means the
      // opposite and its copy would tell somebody staring at a live park that there is nothing
      // left to answer.
      surface === 'input-gate' ? 'input_gate_parked' : undefined,
    )
  }
  /**
   * Dispatch the `fixer` against the human-review gate's PR branch from a human's freeform
   * instructions — bypassing the precheck + grace window. Parks a `pendingFix` on the gate step,
   * consumed on the gate's next poll (see {@link evaluateGate}) which dispatches the fixer with
   * the instructions folded in. A second request before the first is consumed simply replaces the
   * pending instructions. Throws when no human-review gate is currently parked.
   *
   * The run is re-driven via `workRunner.startRun` so the pending fix is picked up promptly even
   * when the driver had died (e.g. its durable advance job expired/was evicted before the stale-
   * run sweeper re-drove it) — `startRun` is idempotent for a live run (the exclusive advance
   * queue no-ops a duplicate send), so this only has an effect when no driver is currently
   * polling. A spend-paused run is left paused (it resumes through its own path).
   */
  async requestHumanReviewFix(
    workspaceId: string,
    blockId: string,
    instructions: string,
  ): Promise<ExecutionInstance> {
    const block = await this.deps.blockRepository.get(workspaceId, blockId)
    if (!block?.executionId) {
      throw new ConflictError('No human-review gate is currently awaiting input')
    }
    // Optimistic-concurrency write: parking the `pendingFix` can race the gate's own poll
    // (the durable driver advancing the run), so re-read + re-apply on fresh state instead
    // of clobbering — the lost-update fix, same path as resolveDecision. The validation runs
    // inside the mutation so it sees the run as it stands at write time.
    const instance = await this.deps.runStateMachine.mutateInstance(
      workspaceId,
      block.executionId,
      (inst) => {
        const step = inst.steps[inst.currentStep]
        if (!step || step.agentKind !== HUMAN_REVIEW_AGENT_KIND || !step.gate) {
          throw new ConflictError('No human-review gate is currently awaiting input')
        }
        // The fix is consumed by evaluateGate's pendingFix branch, which dispatches the fixer
        // ONLY when the gate's provider is wired AND there is an async executor to escalate to.
        // Reject up front when neither holds, instead of silently parking a pendingFix the gate
        // would discard on its pass-through (an unwired gate advances) — the caller must see the
        // failure, not a 200.
        const gate = this.deps.runDispatcher.gateFor(step.agentKind)
        if (!gate?.wired() || !isAsyncAgentExecutor(this.deps.agentExecutor)) {
          throw new ConflictError(
            'The human-review gate cannot dispatch a fix on this deployment (no review provider or async executor configured)',
          )
        }
        step.gate.pendingFix = { instructions, at: this.deps.clock.now() }
        // Re-arm a decision-parked run so the re-driven loop polls instead of no-oping; a spend-
        // paused run stays paused.
        if (inst.status === 'blocked') inst.status = 'running'
      },
    )
    await this.deps.runStateMachine.emitInstance(workspaceId, instance)
    // Ensure a driver is active to consume the pending fix (idempotent for a live run).
    if (instance.status === 'running') {
      await this.deps.workRunner.startRun(workspaceId, instance.id)
    }
    return instance
  } /** Resolve a pending decision; the run's next step lets the agent finish it. */
  async resolveDecision(
    workspaceId: string,
    executionId: string,
    decisionId: string,
    choice: string,
  ): Promise<ExecutionInstance> {
    await this.deps.requireWorkspace(workspaceId)
    // Optimistic-concurrency write: a second resolve (double-click) or a racing driver
    // poll can't clobber the chosen decision — the loser re-reads and re-applies.
    const instance = await this.deps.runStateMachine.mutateInstance(
      workspaceId,
      executionId,
      async (inst) => {
        const step = inst.steps.find((s) => s.decision?.id === decisionId)
        if (!step || !step.decision) throw new NotFoundError('Decision', decisionId)
        step.decision.chosen = choice
        this.deps.stepGraph.startStep(step)
        if (inst.status === 'blocked') inst.status = 'running'
        await this.deps.runStateMachine.updateBlockProgress(workspaceId, inst, 'in_progress')
      },
    )
    // Wake the parked durable run, if any. The DB write above remains the source
    // of truth (so the backstop sweeper can still re-drive it); the signal is an
    // optimisation that lets the workflow continue immediately.
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, decisionId, choice)
    await this.deps.runStateMachine.emitInstance(workspaceId, instance)
    return instance
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
    await this.deps.requireWorkspace(workspaceId)
    // Optimistic-concurrency write like resolveDecision/requestStepChanges: an approve
    // holding a stale snapshot (a racing reject, a driver poll, a terminal transition)
    // must re-read and re-validate rather than blind-write — otherwise it can resurrect
    // a run another writer already failed. The advance's in-memory half runs inside the
    // CAS; the non-idempotent side effects (block writes, driver signal, emit) run once
    // after, on the winning state.
    let stepIndex = -1
    let alreadyApproved = false
    const instance = await this.deps.runStateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        alreadyApproved = false
        stepIndex = inst.steps.findIndex((s) => s.approval?.id === approvalId)
        const step = inst.steps[stepIndex]
        if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
        this.assertNotIterativeGate(inst, step)
        if (step.approval.status === 'approved') {
          alreadyApproved = true
          return
        }
        if (step.approval.status === 'rejected') {
          throw new ConflictError(`Approval '${approvalId}' was rejected`)
        }
        if (inst.status === 'failed' || inst.status === 'done') {
          throw new ConflictError(`Execution '${executionId}' is already ${inst.status}`)
        }

        // A human edit to the proposal replaces the agent's text, so the revised
        // proposal is what downstream steps read (via priorOutputs). That only holds when the
        // output IS the agent's work product: a step whose output is a RENDERING of an
        // already-ingested artifact (the spec doc, the blueprint tree, the initiative plan —
        // see `reviewableArtifactOutput`) would take the edit into `step.output` while the
        // committed artifact stayed the ingested one, so the correction silently reaches
        // nothing. Refuse rather than accept-and-drop; the reviewer's route is "request
        // changes", which re-runs the producer with the correction as feedback.
        if (opts.proposal !== undefined) {
          if (step.outputIsRendered) {
            throw new ValidationError(
              "This step's output is a rendering of the artifact it already produced, so edits " +
                'to it cannot change that artifact. Request changes instead — the step re-runs ' +
                'with your feedback.',
              { reason: 'proposal_not_editable' },
            )
          }
          step.output = opts.proposal
          step.approval.proposal = opts.proposal
        }
        step.approval.status = 'approved'
        // A gate is never raised on the final step, but the shared advance stays defensive.
        this.deps.runStateMachine.advanceRunPastGate(inst, stepIndex)
      },
    )
    if (alreadyApproved) return instance
    await this.deps.runStateMachine.settleAdvancedGate(workspaceId, instance, stepIndex)
    return instance
  }

  /**
   * Request changes on a step's gated proposal: the same step re-runs with the
   * human's freeform feedback and/or per-block comments (and its prior proposal)
   * folded into the agent's context (see {@link AgentContextBuilder}). The run is left
   * `running` on the same step; on the re-run's completion the gate is raised
   * afresh. At least one of `feedback`/`comments` is expected (the controller
   * validates this), but an empty review is harmless — the agent simply re-runs.
   */
  async requestStepChanges(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    review: { feedback?: string; comments?: StepReviewComment[] },
  ): Promise<ExecutionInstance> {
    await this.deps.requireWorkspace(workspaceId)
    // Optimistic-concurrency write: two concurrent change-requests on the same gate
    // (the documented double-submit) can't both dispatch a re-run — the loser re-reads,
    // sees `changes_requested`, and is rejected below instead of clobbering.
    const instance = await this.deps.runStateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const step = inst.steps.find((s) => s.approval?.id === approvalId)
        if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
        this.assertNotIterativeGate(inst, step)
        if (step.approval.status === 'approved') {
          throw new ConflictError(`Approval '${approvalId}' is already approved`)
        }
        if (step.approval.status === 'rejected') {
          throw new ConflictError(`Approval '${approvalId}' was rejected`)
        }
        // A re-run is already in flight (and will raise a fresh gate on completion);
        // acting on this now-stale gate id would dispatch duplicate work.
        if (step.approval.status === 'changes_requested') {
          throw new ConflictError(`Approval '${approvalId}' is already being re-run`)
        }

        const stepIndex = inst.steps.findIndex((s) => s.approval?.id === approvalId)

        step.approval.status = 'changes_requested'
        step.approval.feedback = review.feedback
        step.approval.comments = review.comments?.length ? review.comments : undefined

        // A companion's gate reviews the PRODUCER's output, not the companion's own work:
        // requesting changes here must re-run the producer (with the human's feedback
        // folded in) and re-grade, NOT re-run the companion. Redirect the rework to the
        // nearest preceding step of one of the companion's target kinds.
        if (isCompanionKind(step.agentKind, this.deps.agentKindRegistry)) {
          const targets = companionTargets(step.agentKind, this.deps.agentKindRegistry)
          let producerIndex = -1
          for (let i = stepIndex - 1; i >= 0; i--) {
            if (targets.includes(inst.steps[i]!.agentKind)) {
              producerIndex = i
              break
            }
          }
          const producer = producerIndex >= 0 ? inst.steps[producerIndex]! : undefined
          if (producer) {
            // Re-run the producer (with the human's feedback) and every step up to and
            // including the companion, then the companion re-grades. Does NOT touch the
            // companion's automatic-rework budget — a human-driven iteration is unbounded.
            const previousProposal = producer.output ?? step.approval.proposal
            this.deps.stepGraph.rerunProducerThrough(inst, producerIndex, stepIndex, {
              previousProposal,
              feedback: review.feedback ?? '',
              ...(review.comments?.length ? { comments: review.comments } : {}),
            })
            if (inst.status === 'blocked') inst.status = 'running'
            return
          }
        }

        // Drop the live job handle so the re-run dispatches fresh work rather than
        // re-attaching to the finished job (async steps); inline steps ignore this.
        step.jobId = undefined
        // A requested re-run is a fresh execution: clear the prior timing so the next
        // start/finish times this attempt rather than spanning the human gate wait.
        step.startedAt = null
        step.finishedAt = null
        this.deps.stepGraph.startStep(step)
        if (inst.status === 'blocked') inst.status = 'running'
      },
    )
    await this.deps.workRunner.signalDecision(
      workspaceId,
      instance.id,
      approvalId,
      'changes_requested',
    )
    await this.deps.runStateMachine.emitInstance(workspaceId, instance)
    return instance
  }

  /**
   * Reject a step's gated proposal: the run stops entirely. The gate is marked
   * `rejected` and the run is failed with a dedicated `rejected` failure kind, so
   * the board surfaces it via the shared failure banner (block → `blocked`) with a
   * Retry affordance. The parked durable run is woken so it observes the now-terminal
   * status and stops (the workflow's advance loop no-ops on a non-running run).
   * Idempotent — rejecting an already-terminal gate is a no-op.
   */
  async rejectStep(
    workspaceId: string,
    executionId: string,
    approvalId: string,
    reason?: string,
  ): Promise<ExecutionInstance> {
    await this.deps.requireWorkspace(workspaceId)
    // Optimistic-concurrency write: a reject racing the durable driver (or a concurrent
    // resolve/request-changes on the same gate) re-reads and re-applies instead of
    // clobbering the other writer — the lost-update fix, same as resolveDecision.
    let alreadyRejected = false
    const instance = await this.deps.runStateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const step = inst.steps.find((s) => s.approval?.id === approvalId)
        if (!step || !step.approval) throw new NotFoundError('Approval', approvalId)
        this.assertNotIterativeGate(inst, step)
        if (step.approval.status === 'approved') {
          throw new ConflictError(`Approval '${approvalId}' is already approved`)
        }
        // A re-run is in flight; this gate id is stale (a fresh one is raised on its
        // completion). Reject the current gate via that fresh id, not this one.
        if (step.approval.status === 'changes_requested') {
          throw new ConflictError(`Approval '${approvalId}' is being re-run`)
        }
        // Already rejected (and the run already failed): leave it as-is and skip failRun below.
        if (step.approval.status === 'rejected') {
          alreadyRejected = true
          return
        }
        step.approval.status = 'rejected'
        if (reason) step.approval.feedback = reason
      },
    )
    if (alreadyRejected) return instance
    const message = reason
      ? `A reviewer rejected the proposal: ${reason}`
      : 'A reviewer rejected the proposal, stopping the run.'
    // failRun persists the terminal failure + flips the block to `blocked` and emits.
    await this.deps.failRun(workspaceId, executionId, message, 'rejected')
    // Wake the parked durable run; it re-reads the now-terminal status and stops.
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'rejected')
    return assertFound(
      await this.deps.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
  }

  /**
   * Merge an open PR: a block moves from `pr_ready` to `done`. This is the HUMAN merge path —
   * a `merge_review` / `pipeline_complete` notification act, or the inspector's merge control.
   *
   * `reviewEffort` records, in the same call, how much review the PR actually needed. It is
   * always optional: an untagged merge settles the track record with a null tag and nothing
   * downstream breaks. The record settle runs AFTER the merge and is best-effort inside the
   * service, so no part of this feature can fail or block a merge.
   *
   * A DRY RUN's PR is refused here. Without this the sandbox is decorative: `MergeResolver`
   * declining to auto-merge only to leave a `merge_review` card whose own action lands the change
   * would let a run that was never authorised to merge do exactly that, one tap later and through
   * the surface the mode exists to guard.
   */
  async mergePr(
    workspaceId: string,
    blockId: string,
    reviewEffort?: ReviewEffort | null,
  ): Promise<Block> {
    await this.deps.requireWorkspace(workspaceId)
    const block = await this.deps.requireBlock(workspaceId, blockId)
    if (block.status !== 'pr_ready') {
      throw new ConflictError(`Block '${blockId}' has no PR awaiting merge`, 'no_pr_to_merge')
    }
    await this.assertNotDryRun(workspaceId, block)
    await this.deps.finalizeMerge(workspaceId, blockId)
    await this.deps.mergePolicy.recordHumanMerge(workspaceId, blockId, reviewEffort)
    return this.deps.requireBlock(workspaceId, blockId)
  }

  /**
   * Refuse the platform merge path for a PR a DRY RUN produced.
   *
   * The mode is read off the run the block points at, which is the run that opened this PR:
   * `block.executionId` is not cleared when a run settles, and here that is exactly what we want.
   * A block with no run recorded, or a run that has since been swept, reads as not-a-dry-run —
   * the same disposition every pre-existing block has, and the only one that does not refuse
   * merges the platform has always allowed on the strength of state it cannot find.
   *
   * The refusal is actionable rather than final: re-running the task live produces a PR that
   * merges normally. It deliberately does NOT claim the change cannot land at all — the PR is a
   * real PR on the host, and someone with write access there can always merge it by hand. What
   * this mode guarantees is that the PLATFORM will not do it on a sandboxed run's behalf.
   */
  private async assertNotDryRun(workspaceId: string, block: Block): Promise<void> {
    if (!block.executionId) return
    const instance = await this.deps.executionRepository.get(workspaceId, block.executionId)
    if (!isDryRun(instance?.mode)) return
    throw new ConflictError(
      'This pull request came from a dry run, so it cannot be merged from here. Start the task ' +
        'again as a live run to produce a pull request this workspace will merge.',
      'dry_run_not_mergeable',
      { executionId: block.executionId },
    )
  }

  /**
   * Record that a human DECLINED to merge — they dismissed the review card rather than acting on
   * it, so the class's rollup counts a rejection instead of a forever-`pending_review` row.
   */
  recordMergeRejection(workspaceId: string, executionId: string): Promise<void> {
    return this.deps.mergePolicy.recordRejection(workspaceId, executionId)
  }
}
