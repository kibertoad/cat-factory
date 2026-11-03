import type { Clock, ExecutionInstance, IdGenerator, Logger, WorkRunner } from '@cat-factory/kernel'
import {
  ConflictError,
  CredentialRequiredError,
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

export interface CredentialWaitControllerDeps {
  stateMachine: RunStateMachine
  stepGraph: StepGraph
  idGenerator: IdGenerator
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
 * The person answers it with {@link resume}, whose HTTP route re-mints the activation from their
 * personal password first.
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
      async (inst) => {
        decisionId = null
        const step = inst.steps[inst.currentStep]
        if (!step || (inst.status !== 'running' && inst.status !== 'paused')) return
        decisionId = this.deps.idGenerator.next('appr')
        step.credentialWait = { raisedAt: this.deps.clock.now() }
        step.approval = {
          id: decisionId,
          status: 'pending',
          proposal: "The run's personal subscription credential lapsed.",
        }
        this.deps.stepGraph.pauseStepForInput(step)
        inst.status = 'blocked'
        await this.deps.stateMachine.updateBlockProgress(workspaceId, inst, 'blocked')
      },
    )
    if (!decisionId) return null
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
   * Resume a step parked on a lapsed credential: clear the park and wake the driver, which
   * re-dispatches the SAME step. The caller has already re-minted the activation; resuming without
   * one simply parks the step again at its next lease.
   */
  async resume(workspaceId: string, executionId: string): Promise<ExecutionInstance> {
    let approvalId = ''
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      async (inst) => {
        const step = inst.steps[inst.currentStep]
        if (!step?.credentialWait || step.approval?.status !== 'pending') {
          throw new ConflictError(
            'This run is not waiting on a personal subscription credential.',
            'credential_wait_not_parked',
          )
        }
        approvalId = step.approval.id
        step.credentialWait = null
        step.approval = null
        this.deps.stepGraph.startStep(step)
        if (inst.status === 'blocked') inst.status = 'running'
        await this.deps.stateMachine.updateBlockProgress(workspaceId, inst, 'in_progress')
      },
    )
    await this.deps.stateMachine.emitInstance(workspaceId, instance)
    await this.deps.workRunner.signalDecision(workspaceId, instance.id, approvalId, 'approved')
    return instance
  }
}
