import { computed, type Ref } from 'vue'
import type { Decision, ExecutionInstance, PipelineStep, StepApproval } from '~/types/domain'

/**
 * The read-only projections of what across every cached run is awaiting a human: the open
 * decisions and approval gates, their per-block indexes, and the two badge counts.
 *
 * Created once in the `execution` store setup over its `instances` ref, so the derivations stay
 * behaviourally identical to the former in-closure computeds — a size-only extraction mirroring
 * {@link createExecutionCommands}, not a new seam.
 */
export function createPendingGateSelectors(instances: Ref<ExecutionInstance[]>) {
  /** How many decisions anywhere are awaiting a human. */
  const pendingDecisionCount = computed(() =>
    instances.value.reduce(
      (n, e) => n + e.steps.filter((s) => s.decision && !s.decision.chosen).length,
      0,
    ),
  )

  /** All currently-unresolved decisions across all runs (for the toolbar/queue). */
  const openDecisions = computed(() => {
    const out: {
      instanceId: string
      blockId: string
      decision: Decision
      agentKind: PipelineStep['agentKind']
    }[] = []
    for (const e of instances.value) {
      for (const s of e.steps) {
        if (s.decision && !s.decision.chosen) {
          out.push({
            instanceId: e.id,
            blockId: e.blockId,
            decision: s.decision,
            agentKind: s.agentKind,
          })
        }
      }
    }
    return out
  })

  /** All currently-pending approval gates across all runs (board badges/queue). */
  const openApprovals = computed(() => {
    const out: {
      instanceId: string
      blockId: string
      approval: StepApproval
      agentKind: PipelineStep['agentKind']
      /**
       * Whether the gate's proposal is a RENDERING of an artifact the step already committed
       * (`step.outputIsRendered`). Projected here because a surface that reviews the proposal
       * WITHOUT the step in hand — the initiative tracker's plan-approval rail — otherwise has
       * no way to tell a rendered document from the agent's raw transcript summary, and would
       * present a one-line summary as though it were the artifact.
       */
      outputIsRendered: boolean
    }[] = []
    for (const e of instances.value) {
      for (const s of e.steps) {
        if (s.approval?.status === 'pending') {
          out.push({
            instanceId: e.id,
            blockId: e.blockId,
            approval: s.approval,
            agentKind: s.agentKind,
            outputIsRendered: s.outputIsRendered === true,
          })
        }
      }
    }
    return out
  })

  /**
   * Open decisions/approvals grouped by the block they belong to, so a board card
   * resolves its own + its tasks' pending gates with O(1) lookups instead of
   * re-filtering the global lists once per frame on every execution event.
   */
  function groupByBlock<T extends { blockId: string }>(items: T[]): Map<string, T[]> {
    const map = new Map<string, T[]>()
    for (const item of items) {
      const list = map.get(item.blockId)
      if (list) list.push(item)
      else map.set(item.blockId, [item])
    }
    return map
  }
  const decisionsByBlock = computed(() => groupByBlock(openDecisions.value))
  const approvalsByBlock = computed(() => groupByBlock(openApprovals.value))

  /** How many approval gates anywhere are awaiting a human. */
  const pendingApprovalCount = computed(() =>
    instances.value.reduce(
      (n, e) => n + e.steps.filter((s) => s.approval?.status === 'pending').length,
      0,
    ),
  )

  return {
    pendingDecisionCount,
    openDecisions,
    openApprovals,
    decisionsByBlock,
    approvalsByBlock,
    pendingApprovalCount,
  }
}
