import type {
  Clock,
  ExecutionInstance,
  ExecutionRepository,
  Logger,
  WorkRunner,
} from '@cat-factory/kernel'
import {
  isCredentialWaitParked,
  mayResumeCredentialWait,
  type CapabilityCredentialWait,
  type StepCredentialWait,
} from '@cat-factory/contracts'
import {
  CapabilityCredentialMissingError,
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
  return new ConflictError('This run is not waiting on a credential.', 'credential_wait_not_parked')
}

/** The parked step's wait, read off a run already known to be parked. */
function parkedWait(instance: ExecutionInstance): StepCredentialWait {
  return instance.steps[instance.currentStep]!.credentialWait!
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
 * How a resume satisfies the wait it answers, supplied by the caller that holds the credential
 * stores: re-mint a personal activation, or ask whether a capability credential now resolves for
 * the run's workspace (of the same subject that declared it).
 */
export interface CredentialWaitResumeHooks {
  renewPersonal: () => Promise<void>
  capabilityResolves: (wait: CapabilityCredentialWait) => Promise<boolean>
}

/**
 * Parks a run whose dispatch is missing a credential, and resumes it.
 *
 * Two refusals park. A run on an individual-usage model leases its initiator's credential at every
 * dispatch, from an activation with a fixed lifetime, and that lease can be refused (`personal`).
 * A step can declare a capability credential the workspace has not stored (`capability`). Whatever
 * advanced the run to that dispatch (a human answering a review, a background re-review
 * converging, a timer) is irrelevant here: the step parks on the generic approval with
 * `credentialWait` set, instead of failing the run. {@link resume} answers it: a personal wait
 * re-mints the activation from the initiator's personal password, a capability wait first checks
 * the key now resolves, and both then re-dispatch.
 *
 * {@link guard} is the ONE place either refusal is recognised. The engine routes every call that can
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
   * refused or a capability credential it declared is missing. Anything else (a result or a
   * throw) passes through untouched.
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
      const wait = this.waitFor(error)
      if (!wait) throw error
      const parked = await this.park(workspaceId, executionId, wait)
      if (!parked) throw error
      return parked
    }
    if (!isLapseResult(result)) return result
    return (await this.park(workspaceId, executionId, this.personalWait())) ?? result
  }

  /** The wait a thrown dispatch refusal parks on, or null for any other error. */
  private waitFor(error: unknown): StepCredentialWait | null {
    if (isLapseError(error)) return this.personalWait()
    if (error instanceof CapabilityCredentialMissingError) {
      const { missing } = error
      return {
        subject: 'capability',
        raisedAt: this.deps.clock.now(),
        key: missing.key,
        declaredBy: missing.declaredBy,
        ...(missing.label ? { label: missing.label } : {}),
        ...(missing.onboarding ? { onboarding: missing.onboarding } : {}),
        ...(missing.reason ? { reason: missing.reason } : {}),
        ...(missing.observed ? { observed: missing.observed } : {}),
      }
    }
    return null
  }

  private personalWait(): StepCredentialWait {
    return { subject: 'personal', raisedAt: this.deps.clock.now() }
  }

  /**
   * Park the run's current step on a credential wait. Answers `null` when the run is no longer
   * live (stopped or settled while the dispatch was failing), so the caller keeps the original
   * outcome rather than parking a run nobody is driving.
   */
  private async park(
    workspaceId: string,
    executionId: string,
    wait: StepCredentialWait,
  ): Promise<AdvanceResult | null> {
    let decisionId: string | null = null
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        decisionId = null
        const step = inst.steps[inst.currentStep]
        if (!step || (inst.status !== 'running' && inst.status !== 'paused')) return
        step.credentialWait = wait
        decisionId = this.deps.stateMachine.openDecisionPark(step, parkMessage(wait))
        inst.status = 'blocked'
      },
    )
    if (!decisionId) return null
    await this.deps.stateMachine.updateBlockProgress(workspaceId, instance, 'blocked')
    this.log.info('run parked: a credential is missing', {
      workspaceId,
      runId: executionId,
      stepIndex: instance.currentStep,
      subject: wait.subject,
      ...(wait.subject === 'capability' ? { key: wait.key } : {}),
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
    hooks: CredentialWaitResumeHooks,
  ): Promise<ExecutionInstance> {
    const current = assertFound(
      await this.deps.executionRepository.get(workspaceId, executionId),
      'Execution',
      executionId,
    )
    if (!parkedApprovalId(current)) throw notParked()
    const wait = parkedWait(current)
    if (wait.subject === 'unrecorded') {
      throw new ConflictError(
        'This wait was recorded before waits named what they wait on; restart the run.',
        'credential_wait_unrecorded',
      )
    }
    if (!mayResumeCredentialWait(wait, current.initiatedBy, actorUserId)) {
      throw new ForbiddenError(
        'Only the person who started this run can renew its personal subscription credential.',
        { reason: 'credential_wait_not_initiator' },
      )
    }
    if (wait.subject === 'personal') await hooks.renewPersonal()
    else if (!(await hooks.capabilityResolves(wait))) throw stillMissing(wait)
    let approvalId = ''
    const instance = await this.deps.stateMachine.mutateInstance(
      workspaceId,
      executionId,
      (inst) => {
        const parked = parkedApprovalId(inst)
        if (!parked || parkedWait(inst).subject !== wait.subject) throw notParked()
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

/**
 * A premature resume is refused, so a person who has not yet stored the key loses a toast rather
 * than a dispatch that would park again at once.
 */
function stillMissing(wait: CapabilityCredentialWait): ConflictError {
  return new ConflictError(
    `The credential '${wait.key}' is still not stored for this workspace.`,
    'capability_credential_still_missing',
    { key: wait.key },
  )
}

/** The decision park's message, saying what the step waits on. */
function parkMessage(wait: StepCredentialWait): string {
  if (wait.subject !== 'capability') return "The run's personal subscription credential lapsed."
  const name = wait.label ? `${wait.label} (${wait.key})` : wait.key
  return `The step needs the credential ${name}, which is not stored for this workspace.`
}
