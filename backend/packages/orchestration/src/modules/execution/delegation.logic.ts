import type { AgentKindRegistry } from '@cat-factory/agents'
import { delegatedExecutorFor } from '@cat-factory/agents'
import {
  ConflictError,
  DomainError,
  stepJobId,
  type AgentRunContext,
  type Clock,
  type DelegatedExecutorRegistry,
  type DelegatedPollPolicy,
  type ExecutionInstance,
  type PipelineStep,
} from '@cat-factory/kernel'
import { claimDelegation } from './step-fold.logic.js'

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

/**
 * What every ASYNC dispatch site calls immediately before it contacts anything: open the record
 * this dispatch will be observed through, and COMMIT it.
 *
 * One function rather than the rule written out at each site, because the rule is the whole
 * idempotency story for a delegated step and a site that forgets it fails silently. Both durable
 * drivers replay, and an executor asked to start twice produces two external runs and two pull
 * requests for one task; the platform's half of the bargain is that the claim (`starting`, plus
 * the correlation key as the step's job id) is on disk BEFORE `start()` is called, so a replay
 * finds the job id and re-attaches. Written per site, that held at exactly one of the six.
 *
 * The container half is here for the same reason it is not a separate decision: a delegated
 * dispatch must NOT stamp a container (there is none, and a stamped one renders the step as a
 * machine the platform never started and hands it to the reclaim that kills containers by run),
 * so "claim" and "cold boot" are two answers to one question, asked once.
 *
 * It PERSISTS, and that is the load-bearing half: an in-memory claim a replay cannot see is no
 * claim at all.
 */
export type OpenStepDispatch = (input: {
  workspaceId: string
  instance: ExecutionInstance
  context: AgentRunContext
  step: PipelineStep
}) => Promise<DelegatedDispatchPlan | undefined>

/** Bind {@link OpenStepDispatch} over the registries, the clock and the engine's persist. */
export function buildOpenStepDispatch(deps: {
  agentKindRegistry: AgentKindRegistry
  delegatedExecutorRegistry: DelegatedExecutorRegistry
  clock: Clock
  persistAndEmit: (workspaceId: string, instance: ExecutionInstance) => Promise<void>
}): OpenStepDispatch {
  return async ({ workspaceId, instance, context, step }) => {
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
    return plan
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
