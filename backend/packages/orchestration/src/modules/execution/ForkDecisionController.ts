import type {
  BlockRepository,
  ChooseForkInput,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  ForkDecisionStepState,
  ForkProposal,
  IdGenerator,
  PipelineStep,
  WorkRunner,
} from '@cat-factory/kernel'
import { assertFound, ConflictError, ValidationError } from '@cat-factory/kernel'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import {
  DEFAULT_FORK_MAX_CHAT_TURNS,
  FORK_DECISION_PRODUCER_KIND,
  mintForks,
  usableForks,
} from './forkDecision.logic.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

/** What the fork-decision controller needs beyond the shared run state-machine spine. */
export interface ForkDecisionControllerDeps {
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  /** The async instance/block spine (park/advance/persist/emit/progress). */
  stateMachine: RunStateMachine
  /** The pure step mutators (start/finish/reset a step). */
  stepGraph: StepGraph
  idGenerator: IdGenerator
  clock: Clock
  /** Optional inbox channel; when unwired the `fork_decision_pending` card is skipped. */
  notificationService?: NotificationService
}

/**
 * Drives the human-facing half of the implementation-fork decision phase on the Coder step:
 * records the proposer's structured output onto `step.forkDecision` and parks the run (or
 * auto-advances a single path), and resolves the human's CHOICE by re-running the Coder with
 * the chosen approach folded in. The Phase-A proposer DISPATCH and the completion interception
 * live in {@link RunDispatcher} (they need its dispatch machinery); everything below is the
 * pure state transitions + the park/signal protocol, shaped like {@link ReviewGateController}
 * and injected via {@link ForkDecisionControllerDeps}.
 *
 * All state rides the run's coder step (`step.forkDecision`) — no side table — so it is
 * runtime-symmetric by construction, exactly like the Follow-up companion.
 */
export class ForkDecisionController {
  constructor(private readonly deps: ForkDecisionControllerDeps) {}

  /**
   * Record the fork-proposer's completed result onto the coder step and decide the flow. Runs
   * as the completion interceptor's body (short-circuiting `recordStepResult` before output /
   * PR / follow-up / approval handling — none of which apply to the proposer):
   *  - the escape hatch fired (`singlePath`) or fewer than two usable forks ⇒ record
   *    `single_path`, reset the step + re-arm it, and `continue` so the driver immediately
   *    dispatches the Coder (no park);
   *  - otherwise ⇒ mint fork ids, record them, raise the `fork_decision_pending` card, and
   *    park the run on the standard durable decision-wait for the human to choose.
   *
   * A missing/unparseable proposal degrades to a single path (advance rather than park on
   * nothing), so an unwired/degenerate proposer never wedges the run.
   */
  async recordProposal(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    proposal: ForkProposal | undefined,
    model: string | null | undefined,
  ): Promise<AdvanceResult> {
    const usable = proposal ? usableForks(proposal) : []
    const maxChatTurns = step.forkDecision?.maxChatTurns ?? DEFAULT_FORK_MAX_CHAT_TURNS
    if (!proposal || proposal.singlePath || usable.length < 2) {
      step.forkDecision = {
        status: 'single_path',
        seamSummary: proposal?.seamSummary ?? null,
        forks: [],
        singlePathReason:
          proposal?.singlePathReason ??
          (proposal ? 'Only one materially different approach was found.' : null),
        chat: [],
        maxChatTurns,
        model: model ?? null,
      }
      // Re-arm the SAME step so the driver re-enters and dispatches the Coder (Phase B).
      this.deps.stepGraph.resetStepForRerun(step)
      this.deps.stepGraph.startStep(step)
      await this.deps.stateMachine.casPersist(workspaceId, instance)
      await this.deps.stateMachine.emitInstance(workspaceId, instance)
      return { kind: 'continue' }
    }

    step.forkDecision = {
      status: 'awaiting_choice',
      seamSummary: proposal.seamSummary || null,
      forks: mintForks(usable, () => this.deps.idGenerator.next('fork')),
      singlePathReason: null,
      chat: [],
      maxChatTurns,
      model: model ?? null,
    }
    await this.raiseForkDecisionPending(workspaceId, instance, step.forkDecision.forks.length)
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
  }

  /**
   * Resolve the human's choice: validate the picked fork id / custom approach against the
   * fresh snapshot, record it on the parked step (`forkDecision.chosen`, status `chosen`),
   * re-arm the step for the Coder dispatch (Phase B) and wake the driver. Mirrors the
   * follow-up "loop" resolution: the CAS records the intent + flips `blocked → running`, then
   * the non-idempotent settle (clear card / progress / signal / emit) runs once after it wins.
   */
  async choose(
    workspaceId: string,
    executionId: string,
    input: ChooseForkInput,
  ): Promise<ForkDecisionStepState> {
    const custom = input.custom?.trim()
    const forkId = input.forkId ?? undefined
    const note = input.note?.trim() || undefined
    if ((forkId == null) === (custom == null || custom.length === 0)) {
      throw new ValidationError('Provide exactly one of forkId or a custom approach')
    }

    let approvalId = ''
    let state: ForkDecisionStepState | undefined
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const step = inst.steps.find(
          (s) =>
            s.agentKind === FORK_DECISION_PRODUCER_KIND &&
            s.state === 'waiting_decision' &&
            s.approval?.status === 'pending' &&
            s.forkDecision?.status === 'awaiting_choice',
        )
        if (!step?.approval || !step.forkDecision) {
          throw new ConflictError('The run is no longer awaiting an implementation-fork choice')
        }
        if (forkId != null && !step.forkDecision.forks?.some((f) => f.id === forkId)) {
          throw new ValidationError(`Unknown fork '${forkId}'`)
        }
        // Capture the approval id BEFORE `resetStepForRerun` clears `step.approval`.
        approvalId = step.approval.id
        step.forkDecision = {
          ...step.forkDecision,
          status: 'chosen',
          chosen: {
            ...(forkId != null ? { forkId } : { custom }),
            ...(note ? { note } : {}),
            at: this.deps.clock.now(),
          },
        }
        // Re-arm the SAME step so the driver re-enters and dispatches the Coder with the choice
        // folded in (`forkDecision` survives `resetStepForRerun`, like `followUps`).
        this.deps.stepGraph.resetStepForRerun(step)
        this.deps.stepGraph.startStep(step)
        if (inst.status === 'blocked') inst.status = 'running'
        state = step.forkDecision
      },
    )
    await this.deps.stateMachine.clearWaitingNotification(workspaceId, instance)
    await this.deps.stateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'approved')
    return state!
  }

  /** The active fork-decision state for a run's GET, or null when no coder step carries one. */
  async getActive(workspaceId: string, executionId: string): Promise<ForkDecisionStepState | null> {
    const instance = await this.deps.executionRepository.get(workspaceId, executionId)
    if (!instance) return null
    return this.activeForkStep(instance)?.forkDecision ?? null
  }

  /**
   * The run's "active" fork-decision coder step: prefer the step the run is currently on, else
   * the latest coder step that carries fork state (a pipeline may have more than one coder
   * step). Mirrors {@link RunDispatcher.activeFollowUpStep}.
   */
  private activeForkStep(instance: ExecutionInstance): PipelineStep | undefined {
    const current = instance.steps[instance.currentStep]
    if (current?.agentKind === FORK_DECISION_PRODUCER_KIND && current.forkDecision) return current
    for (let i = instance.steps.length - 1; i >= 0; i--) {
      const s = instance.steps[i]!
      if (s.agentKind === FORK_DECISION_PRODUCER_KIND && s.forkDecision) return s
    }
    return undefined
  }

  /** Raise the "choose an implementation approach" inbox card when the run parks. */
  private async raiseForkDecisionPending(
    workspaceId: string,
    instance: ExecutionInstance,
    forkCount: number,
  ): Promise<void> {
    if (!this.deps.notificationService) return
    const block = await this.deps.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    await this.deps.notificationService.raise(workspaceId, {
      type: 'fork_decision_pending',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" has ${forkCount} implementation approaches to choose from`,
      body:
        'Before writing code the proposer surfaced materially different ways to implement ' +
        'this task. Open the task to pick an approach (or enter your own) — the Coder starts ' +
        'once you choose.',
      payload: { pipelineName: instance.pipelineName, forkCount },
    })
  }
}
