import type {
  AgentJobHandle,
  AgentJobUpdate,
  AgentRunContext,
  AgentRunResult,
  Clock,
  ExecutionInstance,
  Logger,
  PipelineStep,
} from '@cat-factory/kernel'
import { describeError, getErrorMessage, noopLogger } from '@cat-factory/kernel'
import {
  MAX_CONCURRENT_CHALLENGE_INVESTIGATIONS,
  type PrReviewChallengeJob,
  type PrReviewChallengeOutput,
} from '@cat-factory/contracts'
import { CHALLENGE_INVESTIGATOR_KIND, type AgentKindRegistry } from '@cat-factory/agents'
import type { SpendService } from '@cat-factory/spend'
import type { AdvanceResult } from './advance.js'
import { meterJobUsage } from './job-facts.js'
import {
  applyChallengeVerdict,
  failChallenge,
  renderChallengeInvestigatorFeedback,
} from './prReview.logic.js'
import type { RunStateMachine } from './RunStateMachine.js'
import { claimDispatchEpoch } from './step-fold.logic.js'
import type { StepHandlerContext } from './step-handler-registry.js'

/** How often a quiet queue refreshes the step's activity stamp, so the stale-run sweeper sees it. */
const ACTIVITY_HEARTBEAT_MS = 60_000

/** What the challenge queue needs from the dispatcher. */
export interface PrReviewChallengeQueueDeps {
  runStateMachine: RunStateMachine
  agentKindRegistry: AgentKindRegistry
  spend: SpendService
  clock: Clock
  logger?: Logger
  /** @see AgentDispatchController.startSideJob */
  startSideJob: (
    ctx: StepHandlerContext,
    dispatchKind: string,
    dispatchEpoch: number,
    augmentContext: (context: AgentRunContext) => void,
  ) => Promise<{ job: AgentJobHandle } | { result: AgentRunResult }>
  /** @see AgentDispatchController.pollSideJob */
  pollSideJob: (handle: AgentJobHandle) => Promise<AgentJobUpdate | null>
}

/**
 * The PR-review CHALLENGE QUEUE: every finding a human challenged gets its own read-only Challenge
 * Investigator, at most {@link MAX_CONCURRENT_CHALLENGE_INVESTIGATIONS} at once, the rest starting in
 * the order they were asked for as earlier ones settle.
 *
 * The investigators are HELPER jobs beside the `pr-reviewer` step, never the step's own job: one
 * step can hold one job, and three running side by side is the point. So each queue entry
 * (`step.challengeJobs`) carries what the step-level fields carry for the step's job, the claimed
 * epoch and the attribution its poll re-supplies.
 *
 * While the queue is non-empty the review is `challenging` and the run parks on
 * `awaiting_investigations`: the driver polls {@link poll} between sleeps. Every settled verdict
 * answers `continue`, which sends the driver back through the step handler ({@link drive}) to fill
 * the freed slot. That is also what keeps a long queue inside the poll budget: each settle starts a
 * fresh park, so the budget bounds one wait for one verdict, never the whole queue.
 *
 * Replay safety rests on claim-before-effect: an entry's epoch is claimed and PERSISTED before its
 * executor call, and the harness job id is derived from the epoch, so a replay that finds an epoch
 * with no job id re-addresses the same job rather than starting another.
 */
export class PrReviewChallengeQueue {
  private readonly log: Logger

  constructor(private readonly deps: PrReviewChallengeQueueDeps) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * The step handler's body while the review is `challenging`: re-address any claim a replay
   * interrupted, start queued challenges into the free slots, and park on the running ones. With
   * nothing left in the queue the review returns to `awaiting_selection` and parks for the human.
   */
  async drive(ctx: StepHandlerContext): Promise<AdvanceResult> {
    const { workspaceId, instance, step } = ctx
    for (const job of claimedUnstarted(step)) await this.start(ctx, job)
    for (;;) {
      const next = queued(step)[0]
      if (!next || running(step).length >= MAX_CONCURRENT_CHALLENGE_INVESTIGATIONS) break
      await this.claim(workspaceId, instance, step, next)
      await this.start(ctx, next)
    }
    if (!step.challengeJobs?.length) return this.finish(workspaceId, instance, step)
    return { kind: 'awaiting_investigations', stepIndex: instance.currentStep }
  }

  /**
   * One poll of the running investigators. A settled one has its verdict applied (or its failure
   * recorded) and answers `continue` so the handler can fill the slot; a queue with a free slot
   * (a challenge added while the others ran) answers `continue` for the same reason. Otherwise the
   * park holds.
   */
  async poll(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<AdvanceResult> {
    let settled = false
    for (const job of running(step)) {
      if (!job.jobId) continue
      const update = await this.deps.pollSideJob(handleFor(job, workspaceId, instance))
      if (!update || update.state === 'running') continue
      if (update.state === 'failed') {
        this.settleFailure(step, job, update.error)
      } else {
        await this.settleResult(workspaceId, instance, step, job, update.result)
      }
      settled = true
    }
    if (settled) {
      await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)
      return { kind: 'continue' }
    }
    if (queued(step).length && running(step).length < MAX_CONCURRENT_CHALLENGE_INVESTIGATIONS) {
      return { kind: 'continue' }
    }
    if (!step.challengeJobs?.length) return { kind: 'continue' }
    await this.heartbeat(workspaceId, instance, step)
    return { kind: 'awaiting_investigations', stepIndex: instance.currentStep }
  }

  /** Claim an epoch for a queued entry and mark its finding `investigating`, persisted first. */
  private async claim(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    job: PrReviewChallengeJob,
  ): Promise<void> {
    job.epoch = claimDispatchEpoch(instance, step, CHALLENGE_INVESTIGATOR_KIND)
    const review = step.prReview!
    step.prReview = {
      ...review,
      findings: (review.findings ?? []).map((f) =>
        f.id === job.findingId && f.challenge
          ? { ...f, challenge: { ...f.challenge, status: 'investigating' as const } }
          : f,
      ),
    }
    await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)
  }

  /**
   * Start (or, on a replay, re-address) a claimed entry's investigator. An inline executor answers
   * with the verdict straight away. A dispatch that throws settles THAT challenge as `failed` with
   * the reason: one finding's second opinion failing to start must not fail the review it sits in.
   */
  private async start(ctx: StepHandlerContext, job: PrReviewChallengeJob): Promise<void> {
    const { workspaceId, instance, step } = ctx
    const review = step.prReview!
    const finding = review.findings?.find((f) => f.id === job.findingId)
    if (!finding) {
      // Nothing can remove a finding while the review is `challenging`; dropping the entry rather
      // than dispatching a brief-less investigator keeps a stale queue from wedging the step.
      removeJob(step, job)
      await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)
      return
    }
    try {
      const started = await this.deps.startSideJob(
        ctx,
        CHALLENGE_INVESTIGATOR_KIND,
        job.epoch ?? 0,
        (context) => {
          context.priorOutputs = [
            ...context.priorOutputs,
            {
              agentKind: CHALLENGE_INVESTIGATOR_KIND,
              output: renderChallengeInvestigatorFeedback(
                finding,
                job.question ?? null,
                review.summary,
              ),
            },
          ]
        },
      )
      if ('job' in started) {
        job.jobId = started.job.jobId
        if (started.job.model) job.model = started.job.model
        if (started.job.subscriptionTokenId) {
          job.subscriptionTokenId = started.job.subscriptionTokenId
        }
        if (started.job.initiatedByUserId) job.initiatedByUserId = started.job.initiatedByUserId
      } else {
        await this.settleResult(workspaceId, instance, step, job, started.result)
      }
    } catch (error) {
      this.log.warn('challenge investigator dispatch failed', {
        workspaceId,
        executionId: instance.id,
        findingId: job.findingId,
        ...describeError(error),
      })
      this.settleFailure(step, job, getErrorMessage(error))
    }
    await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)
  }

  /** Apply a finished investigator's verdict, meter its usage, and drop its entry. */
  private async settleResult(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
    job: PrReviewChallengeJob,
    result: AgentRunResult,
  ): Promise<void> {
    await meterJobUsage(this.deps.spend, workspaceId, instance, step, result)
    const output = this.deps.agentKindRegistry
      .structuredOutput(CHALLENGE_INVESTIGATOR_KIND)
      ?.safeParse(result.custom) as PrReviewChallengeOutput | undefined
    step.prReview = applyChallengeVerdict(
      step.prReview!,
      job.findingId,
      job.question ?? null,
      output,
    )
    removeJob(step, job)
  }

  /** Record a failed investigation on its finding (left exactly as it was) and drop its entry. */
  private settleFailure(step: PipelineStep, job: PrReviewChallengeJob, reason: string): void {
    step.prReview = failChallenge(step.prReview!, job.findingId, job.question ?? null, reason)
    removeJob(step, job)
  }

  /** The queue drained: hand the review back to the human. */
  private finish(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<AdvanceResult> {
    step.prReview = { ...step.prReview!, status: 'awaiting_selection', resolution: null }
    return this.deps.runStateMachine.parkStepOnDecision(workspaceId, instance, step)
  }

  /**
   * Keep the run's `updated_at` moving while investigators work quietly, throttled. Without it the
   * stale-run sweeper reads a run that wrote nothing for a while as orphaned.
   */
  private async heartbeat(
    workspaceId: string,
    instance: ExecutionInstance,
    step: PipelineStep,
  ): Promise<void> {
    const now = this.deps.clock.now()
    if (step.lastActivityAt != null && now - step.lastActivityAt < ACTIVITY_HEARTBEAT_MS) {
      return
    }
    step.lastActivityAt = now
    await this.deps.runStateMachine.persistAndEmit(workspaceId, instance)
  }
}

/** Entries with a claimed epoch: running, or claimed and about to be (re-)started. */
function running(step: PipelineStep): PrReviewChallengeJob[] {
  return (step.challengeJobs ?? []).filter((j) => j.epoch !== undefined)
}

/** Claimed entries a replay interrupted before the executor accepted them. */
function claimedUnstarted(step: PipelineStep): PrReviewChallengeJob[] {
  return running(step).filter((j) => !j.jobId)
}

/** Entries still waiting for a slot, in the order they were asked for. */
function queued(step: PipelineStep): PrReviewChallengeJob[] {
  return (step.challengeJobs ?? []).filter((j) => j.epoch === undefined)
}

function removeJob(step: PipelineStep, job: PrReviewChallengeJob): void {
  step.challengeJobs = (step.challengeJobs ?? []).filter((j) => j !== job)
}

/** The poll handle of a running entry: the step-level `pollHandleFor`, for a side job. */
function handleFor(
  job: PrReviewChallengeJob,
  workspaceId: string,
  instance: ExecutionInstance,
): AgentJobHandle {
  return {
    jobId: job.jobId!,
    runId: instance.id,
    workspaceId,
    blockId: instance.blockId,
    agentKind: CHALLENGE_INVESTIGATOR_KIND,
    ...(job.model ? { model: job.model } : {}),
    ...(job.subscriptionTokenId ? { subscriptionTokenId: job.subscriptionTokenId } : {}),
    ...(job.initiatedByUserId ? { initiatedByUserId: job.initiatedByUserId } : {}),
  }
}
