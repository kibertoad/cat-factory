import type { Block, ExecutionRepository, Pipeline, SubscriptionVendor } from '@cat-factory/kernel'
import {
  resolveIndividualVendors,
  type HasPersonalSubscription,
} from './individualVendors.logic.js'

export type { HasPersonalSubscription }

/**
 * The INDIVIDUAL-USAGE VENDOR question, asked three ways: what personal subscriptions would a run
 * started here lease? Each entry point is a different way of naming the steps that will run — a
 * pipeline id, one agent kind, or a failed run's stored steps — and every one of them ends at the
 * same precedence rule (a resolvable block model pin decides alone; only an unpinned run falls
 * through to the workspace per-kind defaults).
 *
 * Its own module because the family grew a third member with the single-kind run door, and the
 * three have to agree: a start path that skips this is a run that leases a personal credential
 * without ever asking the person for it.
 */
export interface RunVendorGateDeps {
  requireBlock: (workspaceId: string, blockId: string) => Promise<Block>
  blockOf: (workspaceId: string, blockId: string) => Promise<Block | null>
  executionRepository: ExecutionRepository
  /** `PipelineAdoption.resolveDefinition` — the READ-ONLY resolve; see `forBlock` for why. */
  resolveDefinition: (workspaceId: string, pipelineId: string) => Promise<Pipeline | null>
  resolveWorkspaceModelDefault?: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
}

export interface RunVendorGate {
  forBlock: (
    workspaceId: string,
    blockId: string,
    pipelineId: string,
    hasPersonalSubscription?: HasPersonalSubscription,
  ) => Promise<SubscriptionVendor[]>
  forAgentKind: (
    workspaceId: string,
    blockId: string,
    agentKind: string,
    hasPersonalSubscription?: HasPersonalSubscription,
  ) => Promise<SubscriptionVendor[]>
  forRun: (
    workspaceId: string,
    executionId: string,
    hasPersonalSubscription?: HasPersonalSubscription,
  ) => Promise<SubscriptionVendor[]>
  /** The shared reduction the three entry points converge on, exposed for the dispatch path. */
  forSteps: (
    workspaceId: string,
    blockModelId: string | undefined,
    modelPresetId: string | undefined,
    agentKinds: string[],
    hasPersonalSubscription: HasPersonalSubscription,
  ) => Promise<SubscriptionVendor[]>
}

const NO_PERSONAL_SUBSCRIPTION: HasPersonalSubscription = () => false

export function createRunVendorGate(deps: RunVendorGateDeps): RunVendorGate {
  /**
   * The set of individual-usage vendors the given steps resolve to. Delegates to the pure kernel
   * reduction, which mirrors the dispatch-time precedence: a resolvable block pin decides the set
   * alone (NONE for a non-subscription model), and only an unpinned run falls to the workspace
   * per-kind defaults.
   */
  const forSteps: RunVendorGate['forSteps'] = (
    workspaceId,
    blockModelId,
    modelPresetId,
    agentKinds,
    hasPersonalSubscription,
  ) => {
    const resolveDefault = deps.resolveWorkspaceModelDefault
    return resolveIndividualVendors(
      blockModelId,
      agentKinds,
      resolveDefault ? (kind) => resolveDefault(workspaceId, kind, modelPresetId) : undefined,
      hasPersonalSubscription,
    )
  }

  return {
    forSteps,

    async forBlock(workspaceId, blockId, pipelineId, has = NO_PERSONAL_SUBSCRIPTION) {
      const block = await deps.requireBlock(workspaceId, blockId)
      // Through adoption's READ-ONLY resolve, not the bare row: this runs on the start REQUEST,
      // and a board that has not adopted the pipeline yet has no row, so a row-only read answered
      // "no agent kinds" and the gate concluded the run needed no personal credential. It would
      // then adopt and start ungated.
      const pipeline = await deps.resolveDefinition(workspaceId, pipelineId)
      return forSteps(
        workspaceId,
        block.modelId,
        block.modelPresetId,
        pipeline?.agentKinds ?? [],
        has,
      )
    },

    async forAgentKind(workspaceId, blockId, agentKind, has = NO_PERSONAL_SUBSCRIPTION) {
      const block = await deps.requireBlock(workspaceId, blockId)
      return forSteps(workspaceId, block.modelId, block.modelPresetId, [agentKind], has)
    },

    async forRun(workspaceId, executionId, has = NO_PERSONAL_SUBSCRIPTION) {
      const run = await deps.executionRepository.get(workspaceId, executionId)
      if (!run) return []
      const block = await deps.blockOf(workspaceId, run.blockId)
      if (!block) return []
      return forSteps(
        workspaceId,
        block.modelId,
        block.modelPresetId,
        run.steps.map((s) => s.agentKind),
        has,
      )
    },
  }
}
