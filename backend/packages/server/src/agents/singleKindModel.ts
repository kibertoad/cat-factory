import type {
  BlockRepository,
  HarnessKind,
  LocalModelDeclarations,
  ModelFlavor,
  ModelRef,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { describeError } from '@cat-factory/kernel'
import { ModelRouter, type ModelRouterDependencies } from './ModelRouter.js'
import { logger } from '../observability/logger.js'

// ---------------------------------------------------------------------------
// "Which model does a dispatch at ONE FRAME with no pipeline behind it run?" Today: the AGENT DRY
// RUN's prober. The two other single-job container flows (the env-config repairer, the repo
// bootstrapper) name a REPOSITORY rather than a frame and still read the deployment's env routing
// at wiring; see `StepModelSelection` for why that is a change to their ports rather than to this.
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

export interface SingleKindModelResolverDependencies extends ModelRouterDependencies {
  /** Read the frame's own model pins. `null` (a deleted frame) ⇒ nothing is pinned. */
  blockRepository: Pick<BlockRepository, 'get'>
  /**
   * The route ORDER the preset in force states. Resolved beside the model rather than left out,
   * because the two come from one row: a preset that puts Bedrock ahead of a direct key means it
   * for every dispatch its model reaches, and a single-job flow that skipped it would run the
   * preset's model over a route the preset ranked last.
   */
  resolvePresetProviderPreference?: (
    workspaceId: string,
    modelPresetId?: string,
  ) => Promise<readonly ModelFlavor[] | undefined>
  /**
   * The INITIATOR's local-runner declarations, folded onto a resolved local ref by the shared
   * resolver (a local model has no catalog entry to carry its modality). Threaded for the reason
   * {@link import('./ModelRouter.js').ModelRouter.resolveRef} documents: ONE resolution serves
   * every path, so a workspace preset naming an Ollama model must not resolve to a ref with the
   * modality folded on for a pipeline step and left off for a single-job dispatch at the same
   * frame. Absent ⇒ no local runners are consulted, which is the honest answer for a flow with no
   * identified initiator.
   */
  resolveLocalModelDeclarations?: (
    userId: string,
  ) => Promise<readonly LocalModelDeclarations[] | undefined>
}

/**
 * Build the shared single-job model resolution: the frame's pins and the preset in force, folded
 * through the same {@link ModelRouter} the pipeline dispatch uses, so a dry run and a coder step on
 * the same frame cannot disagree about which model the workspace chose.
 */
export function buildSingleKindModelResolver(
  deps: SingleKindModelResolverDependencies,
): ResolveSingleKindModel {
  const router = new ModelRouter(deps)
  return async (input) => {
    const block = await readFrame(deps, input.workspaceId, input.blockId)
    const providerPreference = deps.resolvePresetProviderPreference
      ? await deps.resolvePresetProviderPreference(input.workspaceId, block?.modelPresetId)
      : undefined
    const localModelDeclarations =
      deps.resolveLocalModelDeclarations && input.initiatedByUserId
        ? await deps.resolveLocalModelDeclarations(input.initiatedByUserId)
        : undefined
    return router.resolveDispatchRef(
      {
        agentKind: input.agentKind,
        workspaceId: input.workspaceId,
        ...(input.initiatedByUserId ? { initiatedByUserId: input.initiatedByUserId } : {}),
        ...(providerPreference?.length ? { providerPreference } : {}),
        ...(localModelDeclarations?.length ? { localModelDeclarations } : {}),
        block: {
          ...(block?.modelId ? { modelId: block.modelId } : {}),
          ...(block?.modelPresetId ? { modelPresetId: block.modelPresetId } : {}),
        },
      },
      input.workspaceId,
    )
  }
}

/**
 * The frame, or NOTHING, on any answer this read can give.
 *
 * A frame that cannot be read pins nothing, which is the same statement as a frame that pins
 * nothing: the workspace's default preset then decides. Deliberately not an error, and swallowed
 * on a THROW as well as on a `null`: the two are the same fact through different channels, and in
 * mothership mode this read crosses `/internal/persistence`, so a transient RPC failure is the
 * likelier of the pair. The read is here to HONOUR a pin; refusing a diagnostic because a
 * projection lagged (or a repository blinked) would trade a resolvable model for a run that failed
 * at `probing` with an environment already standing.
 *
 * Logged rather than silent, because a pin that stopped being honoured is otherwise invisible: the
 * dispatch succeeds on the preset's model and nothing says the frame asked for another.
 */
async function readFrame(
  deps: SingleKindModelResolverDependencies,
  workspaceId: string,
  blockId: string,
): Promise<{ modelId?: string; modelPresetId?: string } | null> {
  try {
    return await deps.blockRepository.get(workspaceId, blockId)
  } catch (error) {
    logger.warn('single-job dispatch: the frame could not be read, so its model pin is ignored', {
      workspaceId,
      blockId,
      ...describeError(error),
    })
    return null
  }
}
