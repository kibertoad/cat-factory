import type {
  Block,
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  IdGenerator,
  PipelineStep,
  PrReviewAgentOutput,
  PrReviewStepState,
  ResolvePrReviewInput,
  WorkRunner,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import { PR_REVIEWER_KIND } from '@cat-factory/agents'
import type { NotificationService } from '../notifications/NotificationService.js'
import type { AdvanceResult } from './advance.js'
import { coercePrReview } from './prReview.logic.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

/** The step kind the PR-review park loop runs on (the read-only reviewer agent). */
export const PR_REVIEW_STEP_KIND = PR_REVIEWER_KIND

/** What the PR-review controller needs beyond the shared run state-machine spine. */
export interface PrReviewControllerDeps {
  executionRepository: ExecutionRepository
  workRunner: WorkRunner
  /** The async instance/block spine (park/advance/persist/emit/progress). */
  stateMachine: RunStateMachine
  /** The pure step mutators (start/finish/pause a step). */
  stepGraph: StepGraph
  idGenerator: IdGenerator
  clock: Clock
  /** Optional inbox channel; when unwired the `pr_review_ready` card is skipped. */
  notificationService?: NotificationService
}

/**
 * Drives the human-facing half of the PR deep-review flow. The read-only `pr-reviewer`
 * container agent slices an open PR's diff and returns prioritized findings; rather than
 * finishing the run the moment it returns, {@link recordFindings} (run as the completion
 * interceptor's body) records the sliced findings onto `step.prReview` and PARKS the run for a
 * human to SELECT which findings matter through the dedicated window, then {@link resolve}
 * records the selection and advances past the gate. A clean PR (no findings) — or an unwired
 * reviewer — passes through: `recordFindings` records an empty `done` review and lets the
 * normal completion finish the step.
 *
 * All state rides the run's `pr-reviewer` step (`step.prReview`) — no side table — so it is
 * runtime-symmetric by construction, exactly like the fork-decision flow. The Fixer /
 * inline-comment resolutions are the tracked PR 3 follow-up; PR 2 resolves with `finish`.
 */
export class PrReviewController {
  constructor(private readonly deps: PrReviewControllerDeps) {}

  /**
   * Record the completed reviewer's findings onto the `pr-reviewer` step and decide the flow.
   * Runs as the completion interceptor's body (short-circuiting `recordStepResult` when it
   * parks). With findings: coerce + record them (`awaiting_selection`), raise the
   * `pr_review_ready` card, and park on a durable decision-wait. With none (clean PR / degenerate
   * output): record an empty `done` review in place and return `null` so the normal
   * finish/advance spine completes the read-only step. Idempotent: a step already carrying a
   * recorded review is left alone — an already-parked review stays parked (no re-coercion,
   * which would re-mint the finding ids the human may be mid-selection on, nor a duplicate
   * card), and a resolved/clean review falls through to the normal spine.
   */
  async recordFindings(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    output: PrReviewAgentOutput | undefined,
    model: string | null | undefined,
    block: Block | null | undefined,
  ): Promise<AdvanceResult | null> {
    // A double-fire of the completion interceptor (a durable retry/replay) must not re-coerce:
    // re-minting finding ids would strand the human's in-flight selection and re-raise the card.
    // Keep an unresolved review parked; leave a resolved/clean one to the normal spine.
    if (step.prReview && step.prReview.status !== 'reviewing') {
      return step.prReview.status === 'awaiting_selection'
        ? this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
        : null
    }

    const prUrl = block?.taskTypeFields?.prUrl?.trim() || null
    const { summary, slices, findings } = coercePrReview(
      output,
      () => this.deps.idGenerator.next('prs'),
      () => this.deps.idGenerator.next('prf'),
    )

    if (findings.length === 0) {
      // A clean PR (or an unwired/degenerate reviewer): nothing to select. Record the review in
      // place and let the normal completion spine finish the read-only step (no park).
      step.prReview = {
        status: 'done',
        summary,
        slices,
        findings: [],
        selectedFindingIds: [],
        resolution: 'finish',
        prUrl: prUrl ?? null,
        model: model ?? null,
      }
      return null
    }

    step.prReview = {
      status: 'awaiting_selection',
      summary,
      slices,
      findings,
      selectedFindingIds: [],
      resolution: null,
      prUrl: prUrl ?? null,
      model: model ?? null,
    }
    await this.raisePrReviewReady(workspaceId, instance, block, findings.length, slices.length)
    return this.deps.stateMachine.parkStepOnDecision(workspaceId, instance, step)
  }

  /**
   * Resolve a parked PR review: record the human's curated selection (`findingIds`, validated
   * against the live findings) + the resolution, mark the review `done`, and advance the run
   * past the gate. Mirrors the review gate's resolved-gate advance: the pure in-memory advance
   * runs inside the CAS, its side effects (finalize / signal / emit) run once after, on the
   * winning snapshot. PR 2 supports only `finish`; PR 3 wires `fix` / `post`.
   */
  async resolve(
    workspaceId: string,
    executionId: string,
    input: ResolvePrReviewInput,
  ): Promise<PrReviewStepState> {
    let stepIndex = -1
    let state: PrReviewStepState | undefined
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        stepIndex = inst.steps.findIndex(
          (s) =>
            s.agentKind === PR_REVIEW_STEP_KIND &&
            s.state === 'waiting_decision' &&
            s.approval?.status === 'pending' &&
            s.prReview?.status === 'awaiting_selection',
        )
        const step = stepIndex === -1 ? undefined : inst.steps[stepIndex]
        if (!step?.approval || !step.prReview) {
          throw new ConflictError('The run is no longer awaiting a PR-review selection')
        }
        const known = new Set(step.prReview.findings?.map((f) => f.id) ?? [])
        const selectedFindingIds = (input.findingIds ?? []).filter((id) => known.has(id))
        step.prReview = {
          ...step.prReview,
          status: 'done',
          resolution: input.action ?? 'finish',
          selectedFindingIds,
        }
        step.approval.status = 'approved'
        this.deps.stateMachine.advanceRunPastGate(inst, stepIndex)
        state = step.prReview
      },
    )
    await this.deps.stateMachine.clearWaitingNotification(workspaceId, instance)
    if (stepIndex !== -1) {
      await this.deps.stateMachine.settleAdvancedGate(workspaceId, instance, stepIndex)
    }
    return state!
  }

  /** The active PR-review state for a run's GET, or null when no `pr-reviewer` step carries one. */
  async getActive(workspaceId: string, executionId: string): Promise<PrReviewStepState | null> {
    const instance = await this.deps.executionRepository.get(workspaceId, executionId)
    if (!instance) return null
    return this.activePrReviewStep(instance)?.prReview ?? null
  }

  /**
   * The run's "active" PR-review step: prefer the step the run is currently on, else the latest
   * `pr-reviewer` step that carries review state. Mirrors {@link ForkDecisionController.activeForkStep}.
   */
  private activePrReviewStep(instance: ExecutionInstance): PipelineStep | undefined {
    const current = instance.steps[instance.currentStep]
    if (current?.agentKind === PR_REVIEW_STEP_KIND && current.prReview) return current
    for (let i = instance.steps.length - 1; i >= 0; i--) {
      const s = instance.steps[i]!
      if (s.agentKind === PR_REVIEW_STEP_KIND && s.prReview) return s
    }
    return undefined
  }

  /** Raise the "select PR-review findings" inbox card when the run parks. */
  private async raisePrReviewReady(
    workspaceId: string,
    instance: ExecutionInstance,
    block: Block | null | undefined,
    findingCount: number,
    sliceCount: number,
  ): Promise<void> {
    if (!this.deps.notificationService || !block) return
    await this.deps.notificationService.raise(workspaceId, {
      type: 'pr_review_ready',
      blockId: block.id,
      executionId: instance.id,
      title: `"${block.title}" — ${findingCount} review finding${findingCount === 1 ? '' : 's'} to triage`,
      body:
        'The PR reviewer sliced the pull request and surfaced prioritized findings. Open the ' +
        'task to select which findings to act on.',
      payload: { pipelineName: instance.pipelineName, findingCount, sliceCount },
    })
  }
}
