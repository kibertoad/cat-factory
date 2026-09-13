import type { AgentKindRegistry } from '@cat-factory/agents'
import { delegatedExecutorFor } from '@cat-factory/agents'
import {
  ConflictError,
  stepJobId,
  type AgentRunContext,
  type DelegatedExecutorRegistry,
  type DelegatedPollPolicy,
} from '@cat-factory/kernel'

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
