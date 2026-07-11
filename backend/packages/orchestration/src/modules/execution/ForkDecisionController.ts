import type {
  Block,
  BlockRepository,
  ChooseForkInput,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  ForkChatMessage,
  ForkChatRequestInput,
  ForkDecisionStepState,
  ForkProposal,
  IdGenerator,
  PipelineStep,
  WorkRunner,
} from '@cat-factory/kernel'
import { ConflictError, ValidationError } from '@cat-factory/kernel'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import type { ForkChatService } from './ForkChatService.js'
import {
  DEFAULT_FORK_MAX_CHAT_TURNS,
  forkChatBudgetSpent,
  FORK_DECISION_PRODUCER_KIND,
  mintForks,
  usableForks,
} from './forkDecision.logic.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

/** Max chars stored per chat message (mirrors the `forkChatMessageSchema` `maxLength`). */
const FORK_CHAT_MESSAGE_MAX = 4000

/** The canned assistant turn used when the inline chat responder is unwired or fails. */
const CHAT_UNAVAILABLE_REPLY =
  'Chat is not available for this task right now. Pick one of the proposed approaches, or enter ' +
  'your own approach, to continue.'

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
  /**
   * Inline grounded-chat responder. When unwired (no model) the chat degrades gracefully — a
   * human chat turn is answered with a canned "chat unavailable" reply — so pick / custom still
   * work. See {@link ForkDecisionController.answerChat}.
   */
  forkChatService?: ForkChatService
  /**
   * Resolve the EFFECTIVE task description an agent step runs against (reworked requirements →
   * clarified report → raw description) so the chat grounds on the same brief every agent sees.
   * Injected from {@link AgentContextBuilder.resolveEffectiveDescription}.
   */
  resolveEffectiveDescription?: (workspaceId: string, block: Block) => Promise<string>
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
      // A single path (the escape hatch fired, or fewer than two materially different
      // approaches survived): no park. Still fold the one explored approach into the Coder so
      // it runs "against the one returned fork" (the documented intent) instead of discarding
      // the proposer's work — mint the usable fork(s) and bind the recommended one as the
      // chosen directive. Nothing to bind when no usable fork survived (missing/degenerate
      // proposal), in which case the Coder runs exactly as before the feature existed.
      const minted =
        usable.length > 0 ? mintForks(usable, () => this.deps.idGenerator.next('fork')) : []
      const picked = minted.find((f) => f.recommended) ?? minted[0]
      step.forkDecision = {
        status: 'single_path',
        seamSummary: proposal?.seamSummary ?? null,
        forks: minted,
        singlePathReason:
          proposal?.singlePathReason ??
          (proposal ? 'Only one materially different approach was found.' : null),
        chat: [],
        maxChatTurns,
        model: model ?? null,
        ...(picked ? { chosen: { forkId: picked.id, at: this.deps.clock.now() } } : {}),
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

  /**
   * Send a human chat message about the surfaced forks. Records the message on the parked coder
   * step, flags the step `answering` + sets the `pendingForkChat` re-entry marker, and wakes the
   * durable driver — which computes the grounded reply INLINE off the HTTP request (see
   * {@link answerChat}) and re-parks. Returns immediately with the `answering` state; the
   * assistant reply arrives via the `execution` event. Mirrors {@link ReviewGateController.incorporate}'s
   * async offload: the CAS records the intent + re-arms the run, then the settle (emit + signal)
   * runs once after it wins.
   */
  async chat(
    workspaceId: string,
    executionId: string,
    input: ForkChatRequestInput,
  ): Promise<ForkDecisionStepState> {
    const text = input.text.trim()
    if (!text) throw new ValidationError('A chat message is required')

    const messageId = this.deps.idGenerator.next('fchat')
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
        if (forkChatBudgetSpent(step.forkDecision)) {
          throw new ConflictError(
            'This fork chat has reached its turn limit — pick an approach or enter your own',
          )
        }
        approvalId = step.approval.id
        const chat: ForkChatMessage[] = [
          ...(step.forkDecision.chat ?? []),
          { id: messageId, role: 'human', text, createdAt: this.deps.clock.now() },
        ]
        step.forkDecision = { ...step.forkDecision, status: 'answering', chat }
        // Re-arm BEFORE signalling: the park left the run `blocked`, and `advanceInstance`
        // no-ops unless it is `running`/`paused`, so a woken driver would otherwise return
        // without re-entering the fork handler to compute the reply.
        step.pendingForkChat = { messageId }
        if (inst.status === 'blocked') inst.status = 'running'
        state = step.forkDecision
      },
    )
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'fork-chat')
    return state!
  }

  /**
   * Compute the grounded reply to the pending chat turn INSIDE the durable driver (the LLM work
   * that used to sit in the HTTP request the user is no longer waiting on), append it to the
   * thread, and re-park the step `awaiting_choice` (a fresh approval id). Called from the fork
   * step handler on re-entry when `step.pendingForkChat` is set. Degrades gracefully: with no
   * chat responder wired, or on a responder failure, a canned "chat unavailable" assistant turn
   * is appended and the run re-parks — pick / custom stay available.
   */
  async answerChat(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    block: Block,
  ): Promise<AdvanceResult> {
    // Clear the re-entry marker up front so a replay/retry can't answer the same turn twice.
    step.pendingForkChat = null
    const fd = step.forkDecision
    if (!fd) return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)

    const reply = await this.computeChatReply(workspaceId, block, fd)
    step.forkDecision = {
      ...fd,
      status: 'awaiting_choice',
      chat: [...(fd.chat ?? []), reply],
    }
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
  }

  /** Run the inline responder for one turn, or the canned fallback when it is unwired / fails. */
  private async computeChatReply(
    workspaceId: string,
    block: Block,
    fd: ForkDecisionStepState,
  ): Promise<ForkChatMessage> {
    const canned = (): ForkChatMessage => ({
      id: this.deps.idGenerator.next('fchat'),
      role: 'assistant',
      text: CHAT_UNAVAILABLE_REPLY,
      createdAt: this.deps.clock.now(),
    })
    const svc = this.deps.forkChatService
    if (!svc?.enabled) return canned()
    try {
      const description =
        (await this.deps.resolveEffectiveDescription?.(workspaceId, block)) ??
        block.description ??
        ''
      const { text } = await svc.respond(workspaceId, block, {
        description,
        seamSummary: fd.seamSummary ?? null,
        forks: fd.forks ?? [],
        chat: fd.chat ?? [],
      })
      return {
        id: this.deps.idGenerator.next('fchat'),
        role: 'assistant',
        text: text.slice(0, FORK_CHAT_MESSAGE_MAX),
        createdAt: this.deps.clock.now(),
      }
    } catch {
      // A model/resolution failure must never wedge the parked run: fall back to the canned turn
      // so the human can still pick a fork or enter a custom approach.
      return canned()
    }
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
