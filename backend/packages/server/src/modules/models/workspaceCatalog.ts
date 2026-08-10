import type { ModelCatalog } from '@cat-factory/contracts'
import {
  effectiveCatalogWith,
  localSelectableModels,
  openRouterSelectableModels,
} from '@cat-factory/kernel'
import { modelCostResolver, withDynamicPrices } from '@cat-factory/spend'
import type { ServerContainer } from '../../http/env.js'
import { resolveWorkspaceCapabilities } from '../../agents/providerCapabilities.js'

/**
 * The workspace's effective model catalog: which models this workspace could actually dispatch to,
 * and why each unavailable one is unavailable.
 *
 * Its own function because TWO surfaces have to answer the same question and must not answer it
 * differently: the SPA's picker (`GET /workspaces/:ws/models`) and the public
 * `GET /api/v1/models`, which a headless caller reads to learn whether a run can dispatch at all
 * before it pays for one. The composition is four reads folded together (configured provider keys
 * and subscriptions via the capability resolver, the caller's own locally-run endpoints, the
 * workspace's OpenRouter gateway models, and the live prices those carry), so a second copy would
 * be a second set of selectability rules that drift silently: the public read would keep reporting
 * a model as available for exactly as long as it took someone to notice.
 *
 * `userId` is optional and its absence is MEANINGFUL rather than a default: locally-run models live
 * on one developer's machine, so a call with no user resolves the catalog without them instead of
 * attributing someone else's endpoints to the caller. A public-API key has no user, which is
 * precisely the case that must not inherit them.
 */
export async function resolveWorkspaceModelCatalog(
  container: ServerContainer,
  workspaceId: string,
  userId?: string,
): Promise<ModelCatalog> {
  const presets = container.modelPresets?.service
  // Spread the container (it structurally supplies apiKeys/subscriptions/localModels/…), then add
  // the model-policy inputs: the account-settings SERVICE (the container exposes it as a
  // `{ service }` module), the workspace→account resolver, and the deployment's support flag. The
  // account read is cached via `container.caches.accountModelPolicy`.
  //
  // No preset id is passed, so the catalog renders under the WORKSPACE DEFAULT preset's route
  // order. That is the honest answer for a workspace-wide read: the picker is asked "which route
  // would this model take here", and a task that has selected another preset resolves under it at
  // dispatch, where the block is in hand.
  const caps = await resolveWorkspaceCapabilities(
    {
      ...container,
      accountSettings: container.accountSettings?.service,
      workspaceAccountOf: (ws) => container.workspaceService.accountOf(ws),
      modelPolicySupported: container.config.infrastructure?.modelPolicy?.supported ?? false,
      ...(presets
        ? { resolvePresetProviderPreference: (ws: string) => presets.providerPreferenceFor(ws) }
        : {}),
    },
    workspaceId,
    userId,
  )
  const local =
    userId && container.localModelEndpoints
      ? await container.localModelEndpoints.capabilitiesFor(userId)
      : []
  const openRouter = container.openRouterCatalog
    ? await container.openRouterCatalog.capabilitiesFor(workspaceId)
    : []
  const costFor = modelCostResolver(withDynamicPrices(container.config.spend, openRouter))
  return effectiveCatalogWith(
    [...localSelectableModels(local), ...openRouterSelectableModels(openRouter)],
    caps,
    costFor,
  )
}
