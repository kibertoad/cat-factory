import type {
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  Logger,
  WorkRunner,
} from '@cat-factory/kernel'
import { isCredentialWaitParked, mayResumeCredentialWait } from '@cat-factory/contracts'
import {
  ConflictError,
  CredentialRequiredError,
  ForbiddenError,
  assertFound,
  getErrorReason,
  noopLogger,
} from '@cat-factory/kernel'
import type { AdvanceResult } from './advance.js'
import type { RunStateMachine } from './RunStateMachine.js'
import type { StepGraph } from './StepGraph.js'

/**
 * The `details.reason` a lease refusal carries. Every dispatch that runs on a personal
 * subscription leases the run's activation, and the lease is the one authority on whether that
 * activation is still live, so this reason is what the park keys on rather than a prediction of
 * which steps will need a credential.
 */
const LAPSED_REASON = 'password_required'

/** Whether a thrown error is a step's lease being refused for a lapsed credential. */
function isLapseError(error: unknown): boolean {
  return error instanceof CredentialRequiredError && getErrorReason(error) === LAPSED_REASON
}

/**
 * Whether a settled step result is the same refusal, after an async dispatch site classified the
 * throw into a `preflight` failure (see `classifyDispatchFailure`).
 */
function isLapseResult(result: AdvanceResult): boolean {
  return (
    result.kind === 'job_failed' &&
    result.failureKind === 'preflight' &&
    result.reason === LAPSED_REASON
  )
}

/**
 * The approval id of a LIVE credential park, or null. Only a `blocked` run counts: a run stopped
 * while parked keeps the step exactly as it stood, and resuming it would re-mint a credential for
 * a run nobody is driving.
 */
function parkedApprovalId(instance: ExecutionInstance): string | null {
  const step = instance.steps[instance.currentStep]
  if (instance.status !== 'blocked' || !step || !isCredentialWaitParked(step)) return null
  return step.approval!.id
}

function notParked(): ConflictError {
  return new ConflictError(
    'This run is not waiting on a personal subscription credential.',
    'credential_wait_not_parked',
  )
}

export interface CredentialWaitControllerDeps {
  stateMachine: RunStateMachine
  stepGraph: StepGraph
  executionRepository: ExecutionRepository
  clock: Clock
  workRunner: WorkRunner
  logger?: Logger
}

/**
 * Parks a run whose personal-subscription credential lapsed, and resumes it.
 *
 * A run on an individual-usage model leases its initiator's credential at every dispatch, from an
 * activation with a fixed lifetime. Whatever advanced the run to that dispatch (a human answering
 * a review, a background re-review converging, a timer) is irrelevant here: the lease is refused,
 * and the step parks on the generic approval with `credentialWait` set, instead of failing the run.
 * The person answers it with {@link resume}, which re-mints the activation from their personal
 * password before re-dispatching.
 *
 * {@link guard} is the ONE place the refusal is recognised. The engine routes every call that can
 * dispatch (advance and the three poll entry points) through it, so no dispatch site and no
 * run-advancing route has to remember to check the credential itself.
 */
export class CredentialWaitController {
  private readonly log: Logger

  constructor(private readonly deps: CredentialWaitControllerDeps) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * Run one engine call that may dispatch a step, parking the run when the dispatch's lease was
   * refused. Anything else (a result or a throw) passes through untouched.
   */
  async guard(
    workspaceId: string,
    executionId: string,
    work: () => Promise<AdvanceResult>,
  ): Promise<AdvanceResult> {
    let result: AdvanceResult
    try {
      result = await work()
    } catch (error) {
      if (!isLapseError(error)) throw error
      const parked = await this.park(workspaceId, executionId)
      if (!parked) throw error
      return parked
    }
    if (!isLapseResult(result)) return result
    return (await this.park(workspaceId, executionId)) ?? result
  }

  /**
   * Park the run's current step on a credential wait. Answers `null` when the run is no longer
   * live (stopped or settled while the dispatch was failing), so the caller keeps the original
   * outcome rather than parking a run nobody is driving.
   */
  private async park(workspaceId: string, executionId: string): Promise<AdvanceResult | null> {
    let decisionId: string | null = null
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        decisionId = null
        const step = inst.steps[inst.currentStep]
        if (!step || (inst.status !== 'running' && inst.status !== 'paused')) return
        step.credentialWait = { raisedAt: this.deps.clock.now() }
        decisionId = this.deps.stateMachine.openDecisionPark(
          step,
          "The run's personal subscription credential lapsed.",
        )
        inst.status = 'blocked'
      },
    )
    if (!decisionId) return null
    await this.deps.stateMachine.updateBlockProgress(workspaceId, instance, 'blocked')
    this.log.info('run parked: personal subscription credential lapsed', {
      workspaceId,
      runId: executionId,
      stepIndex: instance.currentStep,
    })
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.stateMachine.ensureWaitingNotification(workspaceId, instance)
    return { kind: 'awaiting_decision', decisionId }
  }

  /**
   * Resume a step parked on a lapsed credential: re-mint the activation through `renew`, clear the
   * park and wake the driver, which re-dispatches the SAME step. The park and the caller are
   * checked before `renew` runs, so a run that is not parked (already resumed, stopped) never gets
   * a fresh credential minted for it, and nobody but the initiator mints one the lease would not
   * read.
   */
  async resume(
    workspaceId: string,
    executionId: string,
    actorUserId: string | null,
    renew: () => Promise<void>,
  ): Promise<ExecutionInstance> {
    const current = assertFound(
      await this.deps.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (!parkedApprovalId(current)) throw notParked()
    if (!mayResumeCredentialWait(current.initiatedBy, actorUserId)) {
      throw new ForbiddenError(
        'Only the person who started this run can renew its personal subscription credential.',
        { reason: 'credential_wait_not_initiator' },
      )
    }
    await renew()
    let approvalId = ''
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const parked = parkedApprovalId(inst)
        if (!parked) throw notParked()
        approvalId = parked
        const step = inst.steps[inst.currentStep]!
        step.credentialWait = null
        step.approval = null
        this.deps.stepGraph.startStep(step)
        inst.status = 'running'
      },
    )
    await this.deps.stateMachine.updateBlockProgress(workspaceId, instance, 'in_progress')
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'approved')
    return instance
  }
}
