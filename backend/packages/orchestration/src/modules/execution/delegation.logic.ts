import type { AgentKindRegistry } from '@cat-factory/agents'
import { delegatedExecutorFor } from '@cat-factory/agents'
import {
  ConflictError,
  DomainError,
  getErrorMessage,
  noopLogger,
  runBestEffort,
  stepJobId,
  type AgentJobHandle,
  type AgentRunContext,
  type AsyncAgentExecutor,
  type Clock,
  type DelegatedExecutorRegistry,
  type DelegatedPollPolicy,
  type ExecutionInstance,
  type Logger,
  type PipelineStep,
} from '@cat-factory/kernel'
import { claimDelegation, failDelegationDispatch, recordDispatchedJob } from './step-fold.logic.js'

// ---------------------------------------------------------------------------
// The ENGINE's half of a delegated dispatch: what it must know and COMMIT before an external
// executor is ever called.
//
// It is deliberately small, and every field on it is there because the poll site cannot re-derive
// it. The poll runs in another process, after a durable replay, from the persisted step alone,
// the same constraint that made `recordDispatchAttribution` exist, and a delegated step's poll has
// even less to go on than a container one: no runner ref, no per-run container, only the executor
// id and the key the external run was asked to make itself findable by.
// ---------------------------------------------------------------------------

/** What a delegated dispatch needs settled before it happens. */
export interface DelegatedDispatchPlan {
  /** The registered executor this dispatch goes to. */
  executor: string
  /**
   * The key the executor is asked to make its run recoverable by, and the step's job id from the
   * moment of the claim. The SAME string the container path uses as its harness job id
   * (`stepJobId`), so one run's jobs stay distinct whichever executor class they landed on.
   */
  correlationKey: string
  /** The cadence the driver polls this step on, copied onto the record at the claim. */
  poll: DelegatedPollPolicy
}

/**
 * Plan a delegated dispatch, or answer undefined for a kind that runs on the platform's own
 * executors.
 *
 * It REFUSES rather than falls back when a delegated kind names an executor this process does not
 * register, and the refusal is the point: boot validation catches that on a standalone deployment,
 * but a MOTHERSHIP-MODE node boot-validates none of the kinds it resolves: they arrive per
 * dispatch, chosen by a process one build ahead of this one. Falling through to the container
 * executor there would take a step the deployment declared as external and quietly run it in the
 * platform's harness, with the agent's own prompt, against the repository: a run that looks
 * successful and is nothing anybody asked for.
 */
export function planDelegatedDispatch(
  context: AgentRunContext,
  registries: {
    agentKindRegistry: AgentKindRegistry
    delegatedExecutorRegistry: DelegatedExecutorRegistry
  },
): DelegatedDispatchPlan | undefined {
  const executor = delegatedExecutorFor(context.agentKind, registries.agentKindRegistry)
  if (!executor) return undefined
  const definition = registries.delegatedExecutorRegistry.get(executor)
  if (!definition) {
    throw new ConflictError(
      `The \`${context.agentKind}\` step runs on the delegated executor "${executor}", which ` +
        `this deployment does not register` +
        (registries.delegatedExecutorRegistry.size > 0
          ? ` (registered: ${registries.delegatedExecutorRegistry.ids().join(', ')}).`
          : '.'),
      'delegated_executor_unwired',
    )
  }
  if (!context.executionId) {
    throw new ConflictError(
      `The \`${context.agentKind}\` step cannot be delegated outside a run: its correlation key ` +
        'is derived from the run id, and an external executor has nothing else to be found by.',
      'delegated_executor_unwired',
    )
  }
  return {
    executor,
    correlationKey: stepJobId(context.executionId, context.agentKind, context.dispatchEpoch),
    poll: definition.poll,
  }
}

/** What an accepted async dispatch hands back to the site that asked for it. */
export interface StartedStepDispatch {
  /** The stamped job id: this dispatch's own, and what the site parks on. */
  jobId: string
  /** The executor's handle, for the facts only the accepting site reads off it. */
  handle: AgentJobHandle
}

/**
 * THE async dispatch: open (and COMMIT) the record this job will be observed through, call the
 * executor, and fold what came back onto the step.
 *
 * One function rather than the three lines written out at each of the eight sites, because every
 * one of them is a place to get the ordering wrong and each failure is silent:
 *
 *  - The CLAIM is the whole idempotency story for a delegated step. Both durable drivers replay,
 *    and an executor asked to start twice produces two external runs and two pull requests for one
 *    task; the platform's half of the bargain is that the claim (`starting`, plus the correlation
 *    key as the step's job id) is on disk BEFORE `start()` is called, so a replay finds it and
 *    re-attaches. Written per site, that held at exactly one of them.
 *  - The container half is the same question, not a second one: a delegated dispatch must NOT
 *    stamp a container (there is none, and a stamped one renders the step as a machine the
 *    platform never started and hands it to the reclaim that kills containers by run), so "claim"
 *    and "cold boot" are two answers to one question, asked once.
 *  - A dispatch that THROWS has to undo the claim it committed, or the run parks on a job that may
 *    never have started and dies on its poll budget reporting a timeout instead of the dispatch
 *    failure that actually happened (see {@link failDelegationDispatch}). Inside this function the
 *    fold cannot be forgotten, and it is PERSISTED before the throw propagates, because the
 *    durable drivers re-read the run from storage when they fail it.
 *
 * It rethrows rather than reporting, so a site that lets its dispatch failures propagate keeps
 * doing so; the one site that classifies them ({@link AgentDispatchController}) catches the same
 * throw and now sees the pre-call refusals too, which used to escape its `try` entirely.
 */
export type StartStepDispatch = (input: {
  workspaceId: string
  instance: ExecutionInstance
  context: AgentRunContext
  step: PipelineStep
  /** The async executor this site resolved; narrowed to the one method this seam calls. */
  executor: Pick<AsyncAgentExecutor, 'startJob'>
}) => Promise<StartedStepDispatch>

/** Bind {@link StartStepDispatch} over the registries, the clock and the engine's persist. */
export function buildStartStepDispatch(deps: {
  agentKindRegistry: AgentKindRegistry
  delegatedExecutorRegistry: DelegatedExecutorRegistry
  clock: Clock
  persistAndEmit: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
  logger?: Logger
}): StartStepDispatch {
  const log = deps.logger ?? noopLogger
  return async ({ workspaceId, instance, context, step, executor }) => {
    const plan = planDelegatedDispatch(context, deps)
    if (plan) {
      claimDelegation(step, { ...plan, startedAt: deps.clock.now() })
    } else {
      // The explicit cold-boot lifecycle: a container dispatch blocks until the per-run container
      // is up and has accepted the job, so emitting `starting` now shows the boot (and then the
      // live phase and the container's id/url) instead of a blank "working" state.
      step.container = { status: 'starting' }
    }
    await deps.persistAndEmit(workspaceId, instance)
    let handle: AgentJobHandle
    try {
      handle = await executor.startJob(context)
    } catch (error) {
      // A DELEGATED dispatch has no container to mark: the claim it committed is what the failure
      // lands on, and whether that claim SURVIVES depends on how far the dispatch got. A throw
      // from the executor's own `start()` leaves work of unknown liveness, so the claim stays open
      // for the teardown to ask about; anything refused before the call settles it, because
      // nothing is running. Either way the job id goes, so the next advance re-dispatches under
      // the same correlation key rather than polling a job that may never have existed.
      if (plan) {
        failDelegationDispatch(step, {
          error: getErrorMessage(error),
          contacted: delegationContactFailed(error),
        })
      } else {
        step.container = { status: 'errored' }
      }
      // Best-effort, and deliberately: the caller's own error is the one worth reporting, and a
      // persist that throws here would replace it with a storage fault. Losing the fold costs the
      // step's execution-surface record, never its recoverability, because the job id it clears is
      // re-derived from the claim's own status on the next advance ({@link liveJobId}).
      await runBestEffort(
        log,
        'startStepDispatch.recordFailure',
        () => deps.persistAndEmit(workspaceId, instance),
        { workspaceId, executionId: instance.id, agentKind: context.agentKind },
      )
      throw error
    }
    return { jobId: recordDispatchedJob(step, handle, context.agentKind), handle }
  }
}

/**
 * Whether a dispatch that threw got as far as CALLING the executor's own system.
 *
 * The delegated executor states it: everything it refuses before the call (no linked repository,
 * no such registration, a step dispatched outside a run) is a conflict of ours, and only a throw
 * from `start()` itself is re-raised as `delegated_executor_failed`. The engine reads that rather
 * than inferring it, because the two answers lead to opposite dispositions and neither is safe as
 * a default: a claim settled when the call may have landed leaves a live external run that no
 * teardown will ever name, and a claim left open when nothing was contacted has the teardown warn
 * a human about work that never started.
 */
export function delegationContactFailed(error: unknown): boolean {
  return error instanceof DomainError && error.details?.['reason'] === 'delegated_executor_failed'
}
