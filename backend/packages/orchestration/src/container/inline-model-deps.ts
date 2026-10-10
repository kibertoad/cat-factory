import type { InlineBlockModelDeps } from '../inlineBlockModel.js'
import { resolvePresetRouting } from '../modules/modelPresets/ModelPresetService.js'
import type { CoreDependencies } from './dependencies.js'

/**
 * The model-resolution slice every INLINE caller is wired with: the routing-default ref, the
 * deployment-aware block-model resolver, the local-mode inline-harness predicate, and the
 * preset-derived routing — the workspace's per-kind default MODEL together with the ROUTE order
 * that same preset states.
 *
 * One factory rather than the ternary copied at each call site, and one `resolvePresetRouting`
 * rather than a model resolver beside a preset repository, for the same reason: the model and the
 * route order are two columns of ONE preset row. Wired apart, a site could take the first and miss
 * the second — resolving a preset's model onto the deployment's default route, silently, with the
 * run working on the wrong provider, which is exactly what a compliance preset pinned to a
 * residency-guaranteed route must never do. Wired together they cost one read and cannot disagree.
 *
 * Every field degrades exactly as it did before presets existed: no repository ⇒ block pin plus
 * routing default, no inline-harness predicate ⇒ a subscription ref degrades.
 */
export function inlineModelResolutionDeps(deps: CoreDependencies): InlineBlockModelDeps {
  const presets = deps.modelPresetRepository
  return {
    // The dedicated reviewer ref, else the document planner's (both the agents' default).
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    // Honour a block's pinned model with the direct/Cloudflare fallback, like the executor.
    resolveBlockModel: deps.requirementReviewResolveModel,
    // In local mode, run inline through the ambient Claude Code / Codex CLI on a subscription
    // model instead of degrading to the routing default.
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    // Honour the workspace's model presets, so an inline caller resolves its model AND its routes
    // exactly like a pipeline step does. Read through the shared cache slice, since the run path
    // resolves this row on every inline call.
    ...(presets
      ? {
          resolvePresetRouting: (workspaceId, agentKind, modelPresetId) =>
            resolvePresetRouting(
              presets,
              workspaceId,
              agentKind,
              modelPresetId,
              deps.caches?.modelPreset,
            ),
        }
      : {}),
  }
}
