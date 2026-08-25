import type {
  Block,
  BlockRepository,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  FollowUpItem,
  FollowUpsStepState,
  FollowUpResolution,
  IdGenerator,
  Logger,
  OperationalMetrics,
  PipelineStep,
  RunAutonomy,
  StreamedFollowUp,
  TicketTrackerProvider,
  WorkRunner,
} from '@cat-factory/kernel'
import { ConflictError, NotFoundError } from '@cat-factory/kernel'
import {
  followUpGateVerdict,
  followUpLoopBudget,
  followUpsAlreadySettled,
  followUpsToSendBack,
  hasPendingFollowUps,
  renderFollowUpRework,
} from './followUp.logic.js'
import type { AgentContextBuilder } from './AgentContextBuilder.js'
import type { RunStateMachine } from './RunStateMachine.js'
import { resolvesOwnCaps, type RunPolicyScope } from './policy-types.js'
import type { StepGraph } from './StepGraph.js'
import type { AdvanceResult } from './advance.js'
import type { NotificationService } from '../notifications/NotificationService.js'

/** Collaborators the follow-up companion gate needs (all shared with {@link RunDispatcher}). */
export interface FollowUpGateControllerDeps {
  executionRepository: ExecutionRepository
  blockRepository: BlockRepository
  contextBuilder: AgentContextBuilder
  stepGraph: StepGraph
  runStateMachine: RunStateMachine
  workRunner: WorkRunner
  idGenerator: IdGenerator
  clock: Clock
  notificationService?: NotificationService
  ticketTrackerProvider?: TicketTrackerProvider
  /**
   * The run's risk policy, read for ONE decision here: whether undecided follow-ups park for a
   * person or are dismissed by policy ({@link FollowUpGateController.dismissPendingUnattended}).
   */
  resolveRiskPolicy: (
    workspaceId: string,
    block: Block,
    run: RunPolicyScope,
  ) => Promise<{ autonomy?: RunAutonomy }>
  /** Facade logger; absent in tests, where the dismissal is asserted off the step instead. */
  logger?: Logger
  /**
   * Where a dropped send-back is COUNTED. Required rather than optional, like every other holder
   * of this port: an un-wired counter is indistinguishable from a deployment where this never
   * happens, and those are the two facts an operator most needs to tell apart here.
   */
  operationalMetrics: OperationalMetrics
}

/**
 * The Follow-up companion gate (the future-looking Coder), extracted out of
 * {@link RunDispatcher}: the Coder streams forward-looking items (loose ends / side-tasks /
 * questions) which accrue on its `step.followUps` live (see the dispatcher's poll fold). At
 * the Coder's completion the run parks while any item is undecided, then loops the Coder for
 * the items the human queued / answered (within the loop budget) before the following steps
 * may start. Also owns the human-action API (file / queue / answer / dismiss) the execution
 * controller reaches through the dispatcher's thin pass-throughs. Pure code movement from the
 * dispatcher; no behaviour changes.
 */
export class FollowUpGateController {
  private readonly executionRepository: ExecutionRepository
  private readonly blockRepository: BlockRepository
  private readonly contextBuilder: AgentContextBuilder
  private readonly stepGraph: StepGraph
  private readonly runStateMachine: RunStateMachine
  private readonly workRunner: WorkRunner
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly notificationService?: NotificationService
  private readonly ticketTrackerProvider?: TicketTrackerProvider
  private readonly resolveRiskPolicy: FollowUpGateControllerDeps['resolveRiskPolicy']
  private readonly logger?: Logger
  private readonly metrics: OperationalMetrics

  constructor(deps: FollowUpGateControllerDeps) {
    this.executionRepository = deps.executionRepository
    this.blockRepository = deps.blockRepository
    this.contextBuilder = deps.contextBuilder
    this.stepGraph = deps.stepGraph
    this.runStateMachine = deps.runStateMachine
    this.workRunner = deps.workRunner
    this.idGenerator = deps.idGenerator
    this.clock = deps.clock
    this.notificationService = deps.notificationService
    this.ticketTrackerProvider = deps.ticketTrackerProvider
    this.resolveRiskPolicy = deps.resolveRiskPolicy
    this.logger = deps.logger
    this.metrics = deps.operationalMetrics
  }

  /**
   * Append the items the harness streamed since the last poll onto the Coder step's
   * follow-up state as fresh `pending` items. A no-op when the companion is off or nothing
   * was streamed. Returns whether anything was added (so the poller persists + emits).
   */
  appendStreamedFollowUps(step: PipelineStep, streamed: StreamedFollowUp[] | undefined): boolean {
    if (!step.followUps?.enabled || !streamed || streamed.length === 0) return false
    const now = this.clock.now()
    for (const s of streamed) {
      const title = (s.title ?? '').trim()
      if (!title) continue
      step.followUps.items.push({
        id: this.idGenerator.next('fu'),
        kind: s.kind === 'question' ? 'question' : 'follow_up',
        title,
        detail: s.detail ?? '',
        ...(s.suggestedAction ? { suggestedAction: s.suggestedAction } : {}),
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      })
    }
    return true
  }

  /**
   * The Follow-up companion gate, evaluated when the Coder step completes: park the run on
   * a durable decision while any item is undecided; else loop the Coder for the queued /
   * answered items (within the budget); else fall through (return undefined) so the normal
   * advance/finish logic runs. Returns an {@link AdvanceResult} only when it parks or loops.
   */
  async evaluateFollowUpGate(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<AdvanceResult | undefined> {
    const state = step.followUps
    if (!state?.enabled) return undefined
    if (hasPendingFollowUps(state)) {
      if (!(await this.dismissPendingUnattended(workspaceId, instance, state))) {
        await this.raiseFollowUpPending(workspaceId, instance, state)
        return this.runStateMachine.parkStepOnDecision(workspaceId, instance, step)
      }
    }
    const verdict = followUpGateVerdict(state)
    if (verdict === 'loop') {
      this.loopCoderForFollowUps(instance, step)
      await this.runStateMachine.persistAndEmit(workspaceId, instance, {
        blockStatus: 'in_progress',
      })
      return { kind: 'continue' }
    }
    if (verdict === 'exhausted') {
      // The caller persists (this path returns `undefined` so the ordinary advance/finish logic
      // runs and writes), so the stamp rides that write.
      this.reportDroppedSendBacks(workspaceId, instance, state, this.stampExhaustedSendBacks(state))
    }
    return undefined
  }

  /**
   * Mark the send-backs the loop budget could not pay for. Idempotent, and the stamp is what makes
   * it so: {@link followUpsToSendBack} excludes a dropped item, so a second call over the same
   * state finds nothing and returns empty.
   *
   * Reached when the Coder has been looped `maxLoops` times and a human's queued follow-up or
   * answered question is still unsent. The run advances from here, which is the right call (the
   * alternative is a run that never finishes, and the budget exists precisely to bound a
   * conversation that is not converging). But advancing is not the same as converging, and the two
   * used to be indistinguishable afterwards: the items sat `answered` with `sentToCoder` false
   * forever, reading exactly like answers the Coder had acted on.
   */
  private stampExhaustedSendBacks(state: FollowUpsStepState): FollowUpItem[] {
    const dropped = followUpsToSendBack(state)
    const now = this.clock.now()
    for (const item of dropped) {
      item.sendBackDropped = true
      item.updatedAt = now
    }
    return dropped
  }

  /**
   * Report what {@link stampExhaustedSendBacks} dropped, once, for the two readers the stamp
   * itself does not reach:
   *
   * - a `warn`, for the operator debugging THIS run, carrying the ids to find it and the budget
   *   that ran out;
   * - `followup.send_back_dropped`, for the operator who needs to know this is happening MORE than
   *   it was. One run hitting the cap is ordinary. A deployment where most runs do has a prompt or
   *   a triage habit to change, and only a rate tells those apart.
   *
   * Separate from the stamp because neither of these is idempotent and the stamp has to live
   * inside a CAS callback that re-runs on a lost race.
   */
  private reportDroppedSendBacks(
    workspaceId: string,
    instance: ExecutionInstance,
    state: FollowUpsStepState,
    dropped: FollowUpItem[],
  ): void {
    if (dropped.length === 0) return
    const budget = followUpLoopBudget(state)
    this.logger?.warn('follow-up send-backs dropped: the Coder loop budget is spent', {
      workspaceId,
      runId: instance.id,
      blockId: instance.blockId,
      dropped: dropped.length,
      loops: budget.loops,
      maxLoops: budget.maxLoops,
    })
    // Undimensioned: the only split worth having is which run, which is unbounded and already on
    // the log line above.
    this.metrics.increment('followup.send_back_dropped', {}, dropped.length)
  }

  /**
   * The follow-up triage under an unattended policy: DISMISS every undecided item, so the run
   * proceeds instead of parking on a triage nobody is going to do.
   *
   * `dismiss` and not `queue`, and the asymmetry is the point. A follow-up is work the Coder
   * deliberately did NOT do, and queueing it sends the Coder back to widen a change past what the
   * task asked for, unreviewed, on a run with no supervision. Dismissing keeps the run inside its
   * brief; the items themselves stay on the step with their text intact, so nothing the Coder
   * noticed is lost, it is just not acted on. A `question` is dismissed on the same terms: the
   * only honest unattended answer to "what should I do here" is that nobody said.
   *
   * Returns whether it dismissed anything, so the caller falls through to the ordinary
   * loop/advance instead of parking. `false` leaves the park exactly as it was.
   *
   * It reads the block to resolve the policy, which is a repository call the ATTENDED case does
   * not need. That is affordable here and nowhere near a hot path: the caller reaches this only
   * when a Coder completion left an item undecided, so it is at most once per Coder step, and the
   * policy read itself is served from the `riskPolicy` cache slice. Threading the block down from
   * `recordStepResult` (which does not carry one, on either the inline or the job-poll path)
   * would widen a shared settle signature to save that one read.
   */
  private async dismissPendingUnattended(
    workspaceId: string,
    instance: ExecutionInstance,
    state: FollowUpsStepState,
  ): Promise<boolean> {
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) {
      // Falling through to the park is the right disposition — with no block there is no policy
      // to consult, and waiting for a person is what every policy did before this existed. But it
      // must not be SILENT: the two branches below log their decision, and an unattended run that
      // parked anyway is a support question whose answer is otherwise invisible.
      this.logger?.warn('follow-up policy check skipped: the run’s block could not be read', {
        workspaceId,
        runId: instance.id,
        blockId: instance.blockId,
      })
      return false
    }
    const policy = await this.resolveRiskPolicy(workspaceId, block, instance)
    if (!resolvesOwnCaps(policy)) return false
    const now = this.clock.now()
    let dismissed = 0
    for (const item of state.items) {
      if (item.status !== 'pending') continue
      item.status = 'dismissed'
      item.dismissedByPolicy = true
      item.updatedAt = now
      dismissed++
    }
    this.logger?.info('follow-up items dismissed by policy', {
      workspaceId,
      runId: instance.id,
      blockId: block.id,
      dismissed,
    })
    return dismissed > 0
  }

  /**
   * Reset the Coder step and fold the human's queued follow-ups / answered questions into
   * its rework so the next pass extends the prior work. Marks those items `sentToCoder` so
   * a later completion doesn't re-loop them, and counts the loop against the budget. Shared
   * by the at-completion path ({@link evaluateFollowUpGate}) and the parked-resume path.
   */
  private loopCoderForFollowUps(instance: ExecutionInstance, step: PipelineStep): void {
    const state = step.followUps!
    const sending = followUpsToSendBack(state)
    // Every question ruled on rides along, not only the ones ruled on since the last pass: the
    // Coder has no memory across passes, so a ruling dropped from the prompt is one it re-raises.
    const feedback = renderFollowUpRework(sending, followUpsAlreadySettled(state))
    for (const item of sending) {
      item.sentToCoder = true
      item.updatedAt = this.clock.now()
    }
    state.loops = (state.loops ?? 0) + 1
    // Reset the step for a fresh dispatch; `step.followUps` is intentionally preserved
    // (resetStepForRerun doesn't touch it) so the surfaced items survive the loop.
    this.stepGraph.resetStepForRerun(step)
    // A person decided these: policy can only DISMISS an item, so anything queued or answered
    // reached that state through the follow-up inbox. The feedback prose says so too.
    step.rework = { previousProposal: '', feedback, requestedBy: 'human' }
    this.stepGraph.startStep(step)
    if (instance.status === 'blocked') instance.status = 'running'
  }

  /** Raise the "follow-ups need decisions" inbox card when the Coder parks on undecided items. */
  private async raiseFollowUpPending(
    workspaceId: string,
    instance: ExecutionInstance,
    state: FollowUpsStepState,
  ): Promise<void> {
    if (!this.notificationService) return
    const block = await this.blockRepository.get(workspaceId, instance.blockId)
    if (!block) return
    const pending = state.items.filter((i) => i.status === 'pending').length
    await this.notificationService.raise(workspaceId, {
      type: 'followup_pending',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" surfaced ${pending} follow-up${pending === 1 ? '' : 's'} to decide`,
      body:
        'The Coder flagged forward-looking follow-ups / questions. Open the task to file ' +
        'each as an issue, send it back to the Coder, answer it, or dismiss it — the ' +
        'pipeline continues once every item is decided.',
      payload: { pipelineName: instance.pipelineName, findingCount: pending },
    })
  }

  /**
   * The run's "active" follow-up companion step for a read with no item context (the GET /
   * the inbox-card open). A pipeline may carry MORE THAN ONE follow-up-enabled Coder step,
   * so this must not blindly pick the first: prefer the step the run is currently on (a Coder
   * parked on its follow-up gate), else the latest enabled step that has surfaced items, else
   * the first enabled one.
   */
  private activeFollowUpStep(
    instance: ExecutionInstance,
  ): { step: PipelineStep; index: number } | undefined {
    const current = instance.steps[instance.currentStep]
    if (current?.followUps?.enabled) return { step: current, index: instance.currentStep }
    for (let i = instance.steps.length - 1; i >= 0; i--) {
      const s = instance.steps[i]!
      if (s.followUps?.enabled && s.followUps.items.length > 0) return { step: s, index: i }
    }
    const index = instance.steps.findIndex((s) => s.followUps?.enabled)
    return index >= 0 ? { step: instance.steps[index]!, index } : undefined
  }

  /** Read a run's live follow-up companion state (the active Coder step's items), or null. */
  async getFollowUps(workspaceId: string, executionId: string): Promise<FollowUpsStepState | null> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) throw new NotFoundError('Execution', executionId)
    return this.activeFollowUpStep(instance)?.step.followUps ?? null
  }

  /**
   * Locate the run + the Coder step that OWNS the addressed item + the item, throwing 404
   * when absent. Routes by item id (not "the first enabled step") so a pipeline carrying more
   * than one follow-up-enabled Coder step decides each item on the step that surfaced it —
   * otherwise a later Coder's items 404 and its gate can never be cleared.
   */
  private async loadFollowUpItem(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<{
    instance: ExecutionInstance
    step: PipelineStep
    index: number
    item: FollowUpItem
  }> {
    const instance = await this.executionRepository.get(workspaceId, executionId)
    if (!instance) throw new NotFoundError('Execution', executionId)
    const index = instance.steps.findIndex(
      (s) => s.followUps?.enabled && s.followUps.items.some((i) => i.id === itemId),
    )
    if (index < 0) throw new NotFoundError('Follow-up item', itemId)
    const step = instance.steps[index]!
    const item = step.followUps!.items.find((i) => i.id === itemId)!
    return { instance, step, index, item }
  }

  /** File a `follow_up` item as a tracker issue (GitHub / Jira), recording the ticket ref. */
  async fileFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    // Snapshot read for validation + frame resolution before the non-idempotent ticket
    // creation; the item's ticket refs are then recorded under CAS in applyFollowUpDecision.
    const { instance, item } = await this.loadFollowUpItem(workspaceId, executionId, itemId)
    if (item.kind !== 'follow_up') {
      throw new ConflictError('Only follow-up items can be filed as issues')
    }
    if (!this.ticketTrackerProvider) {
      throw new ConflictError('No issue tracker is configured for this workspace')
    }
    const frameId =
      (await this.contextBuilder.resolveServiceFrameId(workspaceId, instance.blockId)) ??
      instance.blockId
    const body = [
      item.detail,
      item.suggestedAction ? `\n\nSuggested approach: ${item.suggestedAction}` : '',
    ]
      .join('')
      .trim()
    const ticket = await this.ticketTrackerProvider.createTicket({
      workspaceId,
      frameId,
      title: item.title,
      body: body || item.title,
    })
    if (!ticket) {
      throw new ConflictError('No issue tracker is configured for this workspace')
    }
    return this.applyFollowUpDecision(workspaceId, executionId, itemId, (target) => {
      // Re-validated on the fresh snapshot inside the CAS (the ticket was already created above).
      if (target.kind !== 'follow_up') {
        throw new ConflictError('Only follow-up items can be filed as issues')
      }
      target.status = 'filed'
      target.ticketExternalId = ticket.externalId
      target.ticketUrl = ticket.url
      target.updatedAt = this.clock.now()
    })
  }

  /** Queue a `follow_up` item to send back to the Coder on its next pass. */
  async queueFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    return this.applyFollowUpDecision(workspaceId, executionId, itemId, (item) => {
      if (item.kind !== 'follow_up') {
        throw new ConflictError('Only follow-up items can be sent back to the Coder')
      }
      item.status = 'queued'
      item.sentToCoder = false
      item.updatedAt = this.clock.now()
    })
  }

  /**
   * Answer a `question` item.
   *
   * `answered` (the default) folds the answer into the Coder's next pass. `closed` records the
   * reply as a RULING: the item is decided and clears the gate exactly as an answer does, but it
   * buys no pass, and it is carried into every later rework prompt as settled. See
   * `followUpResolutionSchema` for why the answerer picks this rather than the engine inferring it.
   */
  async answerFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
    answer: string,
    resolution: FollowUpResolution = 'answered',
  ): Promise<FollowUpsStepState> {
    return this.applyFollowUpDecision(workspaceId, executionId, itemId, (item) => {
      if (item.kind !== 'question') {
        throw new ConflictError('Only question items can be answered')
      }
      item.status = resolution === 'closed' ? 'closed' : 'answered'
      item.answer = answer
      // Left false on a `closed` item too, and deliberately: nothing was sent, and `sendBackDropped`
      // is what distinguishes "never going to be sent" from "was going to be, and was not".
      item.sentToCoder = false
      item.updatedAt = this.clock.now()
    })
  }

  /** Dismiss a follow-up / question item without acting on it. */
  async dismissFollowUp(
    workspaceId: string,
    executionId: string,
    itemId: string,
  ): Promise<FollowUpsStepState> {
    return this.applyFollowUpDecision(workspaceId, executionId, itemId, (item) => {
      item.status = 'dismissed'
      item.updatedAt = this.clock.now()
    })
  }

  /**
   * Apply a human follow-up item decision and, when the run is PARKED on this step's follow-up
   * gate with every item now decided, drive it forward — loop the Coder for the queued/answered
   * items, hand off to a co-located approval gate, or advance past the gate — all under
   * OPTIMISTIC CONCURRENCY. A follow-up decision can race the driver's running-poll fold (which
   * appends newly-streamed items) or another decision on a sibling item, so it RE-READS +
   * RE-APPLIES on a lost CAS race instead of clobbering — the human-action dual of the driver's
   * abort-and-redrive (race-audit 2.2). The item mutation + the in-memory gate transition run
   * INSIDE the CAS callback (idempotent, re-runnable on reload); the non-idempotent side effects
   * (notifications, `signalDecision`, emit) run once AFTER, on the winning snapshot. `decide`
   * validates + mutates the item, throwing a `ConflictError`/`NotFoundError` that propagates
   * immediately (a domain error is not retried).
   */
  private async applyFollowUpDecision(
    workspaceId: string,
    executionId: string,
    itemId: string,
    decide: (item: FollowUpItem) => void,
  ): Promise<FollowUpsStepState> {
    // Captured inside the (re-runnable) callback for the last winning attempt; the
    // non-idempotent side effects below act on them.
    let outcome: 'record' | 'loop' | 'handoff' | 'advance' = 'record'
    let index = -1
    let loopDecisionId: string | undefined
    let dropped: FollowUpItem[] = []
    const persisted = await this.runStateMachine.mutateInstance(
      workspaceId,
      executionId,
      (fresh) => {
        outcome = 'record'
        loopDecisionId = undefined
        dropped = []
        index = fresh.steps.findIndex(
          (s) => s.followUps?.enabled && s.followUps.items.some((i) => i.id === itemId),
        )
        if (index < 0) throw new NotFoundError('Follow-up item', itemId)
        const step = fresh.steps[index]!
        decide(step.followUps!.items.find((i) => i.id === itemId)!)

        const parkedHere =
          fresh.status === 'blocked' &&
          step.approval?.status === 'pending' &&
          fresh.currentStep === index
        // Still collecting decisions (or the run isn't parked on this gate): only record it.
        if (!parkedHere || hasPendingFollowUps(step.followUps!)) return
        // Every item decided and the run is parked here: loop the Coder for the send-back items,
        // hand off to a co-located approval gate, or advance past the gate.
        const verdict = followUpGateVerdict(step.followUps!)
        if (verdict === 'loop') {
          loopDecisionId = step.approval!.id
          this.loopCoderForFollowUps(fresh, step)
          outcome = 'loop'
          return
        }
        // The STAMP only: it is idempotent and belongs with the write, so it re-applies safely
        // when a lost CAS race re-runs this callback on the winner's snapshot. Its log line and
        // its counter are not idempotent, so they fire once, below, on the persisted snapshot.
        if (verdict === 'exhausted') dropped = this.stampExhaustedSendBacks(step.followUps!)
        const isFinalStep = index === fresh.steps.length - 1
        if (step.requiresApproval && !isFinalStep && step.approval?.status === 'pending') {
          // The follow-up park reused `step.approval`; advancing here would silently SKIP the
          // approval. Refresh the proposal and hand off to the standard approval gate (the
          // follow-up card is cleared + the "waiting for input" card re-raised below), preserving
          // the follow-up-before-approval ordering recordStepResult established across the park.
          step.approval = { ...step.approval, proposal: step.output ?? '' }
          outcome = 'handoff'
          return
        }
        this.runStateMachine.advanceRunPastGate(fresh, index)
        outcome = 'advance'
      },
    )
    // Non-idempotent side effects on the winning snapshot (the CAS write is the source of truth,
    // so nothing re-persists here). The settled paths first clear the follow-up waiting card.
    this.reportDroppedSendBacks(workspaceId, persisted, persisted.steps[index]!.followUps!, dropped)
    if (outcome === 'record') {
      await this.runStateMachine.emitInstance(workspaceId, persisted)
    } else {
      await this.runStateMachine.clearWaitingNotification(workspaceId, persisted)
      if (outcome === 'loop') {
        await this.runStateMachine.updateBlockProgress(workspaceId, persisted, 'in_progress')
        await this.workRunner.signalDecision(workspaceId, persisted.id, loopDecisionId!, 'approved')
        await this.runStateMachine.emitInstance(workspaceId, persisted)
      } else if (outcome === 'handoff') {
        await this.runStateMachine.ensureWaitingNotification(workspaceId, persisted)
        await this.runStateMachine.emitInstance(workspaceId, persisted)
      } else {
        // advance: block writes + `signalDecision('approved')` + emit — the approveStep template.
        await this.runStateMachine.settleAdvancedGate(workspaceId, persisted, index)
      }
    }
    return persisted.steps[index]!.followUps!
  }
}
