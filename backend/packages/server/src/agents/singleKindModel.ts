import type {
  BlockRepository,
  HarnessKind,
  ModelFlavor,
  ModelRef,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { ModelRouter, type ModelRouterDependencies } from './ModelRouter.js'

// ---------------------------------------------------------------------------
// "Which model does a SINGLE-JOB container flow run?" A dry run's prober, and anything else the
// platform dispatches at one frame with no pipeline behind it.
//
// The answer has to be the SAME precedence a pipeline step gets (block pin > the workspace's model
// preset for the kind > the deployment's env routing), and it is one composition rather than one
// per facade because getting it wrong is silent: a flow that reads the env routing directly gets
// whatever that deployment's default happens to name, which on the Node family is Qwen. A
// workspace whose preset says Claude then has its dry run dispatched at a model nobody chose, with
// no key configured for it, and the first sign of it is a `502 No API key configured for provider
// 'qwen'` from the LLM proxy, after the run has already stood a real environment up.
//
// The BLOCK read is what makes it a step-equivalent resolution: the frame carries the same
// `modelId` / `modelPresetId` pins a task does, and the preset in force decides both the model and
// the order its routes are tried in. Read here rather than passed in by orchestration for the
// reason the probe port already states: the model, the harness and the credential that opens it are
// one facade concern, and orchestration is deliberately free of all three.
// ---------------------------------------------------------------------------

/** What one single-job dispatch runs: the model, the harness for it, and the vendor it leases. */
export interface SingleKindModel {
  ref: ModelRef
  harness: HarnessKind
  subscriptionVendor?: SubscriptionVendor
}

/** Resolve {@link SingleKindModel} for one dispatch. */
export type ResolveSingleKindModel = (input: {
  workspaceId: string
  /** The frame (board block) the job runs against: whatever it pins, and its preset. */
  blockId: string
  /** The kind whose preset entry decides the model, and whose spend the calls are filed under. */
  agentKind: string
  /** Whoever started it: whose personal (individual-usage) subscription may be leased. */
  initiatedByUserId?: string | null
}) => Promise<SingleKindModel>

export interface SingleKindModelResolverDependencies extends Omit<
  ModelRouterDependencies,
  'resolveWorkspaceModelDefault'
> {
  /** Read the frame's own model pins. `null` (a deleted frame) ⇒ nothing is pinned. */
  blockRepository: Pick<BlockRepository, 'get'>
  /**
   * Resolve the workspace's per-agent-kind default model id from the preset in force. Optional
   * for the reason it is on the step path: absent ⇒ the env routing for the kind decides.
   */
  resolveWorkspaceModelDefault?: ModelRouterDependencies['resolveWorkspaceModelDefault']
  /**
   * The route ORDER that same preset states. Resolved beside the model rather than left out,
   * because the two come from one row: a preset that puts Bedrock ahead of a direct key means it
   * for every dispatch its model reaches, and a single-job flow that skipped it would run the
   * preset's model over a route the preset ranked last.
   */
  resolvePresetProviderPreference?: (
    workspaceId: string,
    modelPresetId?: string,
  ) => Promise<readonly ModelFlavor[] | undefined>
}

/**
 * Build the shared single-job model resolution: the frame's pins and the preset in force, folded
 * through the same {@link ModelRouter} the pipeline dispatch uses, so a dry run and a coder step on
 * the same frame cannot disagree about which model the workspace chose.
 */
export function buildSingleKindModelResolver(
  deps: SingleKindModelResolverDependencies,
): ResolveSingleKindModel {
  const router = new ModelRouter({
    agentRouting: deps.agentRouting,
    resolveBlockModel: deps.resolveBlockModel,
    ...(deps.resolveWorkspaceModelDefault
      ? { resolveWorkspaceModelDefault: deps.resolveWorkspaceModelDefault }
      : {}),
    ...(deps.hasSubscriptionToken ? { hasSubscriptionToken: deps.hasSubscriptionToken } : {}),
    ...(deps.hasPersonalSubscription
      ? { hasPersonalSubscription: deps.hasPersonalSubscription }
      : {}),
  })
  return async (input) => {
    // A frame that cannot be read pins nothing, which is the same statement as a frame that pins
    // nothing: the workspace's default preset then decides. Deliberately not an error: the block
    // read is here to HONOUR a pin, and refusing a diagnostic because a projection lagged would
    // trade a resolvable model for a failed run.
    const block = await deps.blockRepository.get(input.workspaceId, input.blockId)
    const providerPreference = deps.resolvePresetProviderPreference
      ? await deps.resolvePresetProviderPreference(input.workspaceId, block?.modelPresetId)
      : undefined
    return router.resolveDispatchRef(
      {
        agentKind: input.agentKind,
        workspaceId: input.workspaceId,
        ...(input.initiatedByUserId ? { initiatedByUserId: input.initiatedByUserId } : {}),
        ...(providerPreference?.length ? { providerPreference } : {}),
        block: {
          ...(block?.modelId ? { modelId: block.modelId } : {}),
          ...(block?.modelPresetId ? { modelPresetId: block.modelPresetId } : {}),
        },
      },
      input.workspaceId,
    )
  }
}
