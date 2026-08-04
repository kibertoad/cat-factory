import type { InlineBlockModelDeps } from '../inlineBlockModel.js'
import { resolvePresetModelForKind } from '../modules/modelPresets/ModelPresetService.js'
import type { CoreDependencies } from './dependencies.js'

/**
 * The model-resolution slice every INLINE caller is wired with: the routing-default ref, the
 * deployment-aware block-model resolver, the local-mode inline-harness predicate, and the two
 * preset-derived facts — the workspace's per-kind default MODEL and the ROUTE order that same
 * preset states.
 *
 * One factory rather than the ternary copied at each call site, because the last field is the
 * reason: the model and the route order come from ONE preset row, so a site that wires the first
 * and forgets the second resolves the preset's model onto the deployment's default route. That is
 * silent — the run works, on the wrong provider — which is exactly what a compliance preset pinned
 * to a residency-guaranteed route must never do. Wiring them together makes forgetting one
 * impossible.
 *
 * Every field degrades exactly as it did before presets existed: no repository ⇒ block pin plus
 * routing default, no inline-harness predicate ⇒ a subscription ref degrades.
 */
export function inlineModelResolutionDeps(deps: CoreDependencies): InlineBlockModelDeps {
  return {
    // The dedicated reviewer ref, else the document planner's (both the agents' default).
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    // Honour a block's pinned model with the direct/Cloudflare fallback, like the executor.
    resolveBlockModel: deps.requirementReviewResolveModel,
    // In local mode, run inline through the ambient Claude Code / Codex CLI on a subscription
    // model instead of degrading to the routing default.
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    // Honour the workspace's model presets, so an inline caller resolves its model exactly like a
    // pipeline step does.
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
    ...(deps.modelPresetRepository ? { modelPresets: deps.modelPresetRepository } : {}),
  }
}
