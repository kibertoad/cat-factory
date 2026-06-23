import type {
  ApiKeyService,
  LocalModelEndpointService,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
} from '@cat-factory/integrations'
import {
  ALL_SUBSCRIPTION_VENDORS,
  type ProviderCapabilities,
  type SubscriptionVendor,
} from '@cat-factory/kernel'

// Resolve what a workspace (+ its owning account + a given user) actually has
// configured, so the catalog and the pipeline-start guard agree on selectability.
// Shared by the per-workspace /models endpoint and the ExecutionService start guard.

export interface CapabilityServices {
  apiKeys?: ApiKeyService
  subscriptions?: ProviderSubscriptionService
  personalSubscriptions?: PersonalSubscriptionService
  /** Whether the opt-in Cloudflare Workers AI lib is registered for this deployment. */
  cloudflareModelsEnabled?: boolean
  /** Per-user locally-run model endpoints (resolved by the requesting/initiating user). */
  localModelEndpoints?: LocalModelEndpointService
}

export async function resolveWorkspaceCapabilities(
  services: CapabilityServices,
  workspaceId: string,
  userId?: string | null,
): Promise<ProviderCapabilities> {
  const directProviders = new Set<string>(
    services.apiKeys ? await services.apiKeys.configuredProviders(workspaceId, { userId }) : [],
  )
  const subscriptionVendors = new Set<SubscriptionVendor>()
  for (const vendor of ALL_SUBSCRIPTION_VENDORS) {
    const pooled = services.subscriptions
      ? await services.subscriptions.hasToken(workspaceId, vendor)
      : false
    const personal =
      !pooled && userId && services.personalSubscriptions
        ? await services.personalSubscriptions.has(userId, vendor)
        : false
    if (pooled || personal) subscriptionVendors.add(vendor)
  }
  // Local runners are per-user: a model is usable when the resolving user has enabled it.
  // Keyed by the dynamic model id (`"<provider>:<model>"`) so usability is model-granular
  // (a runner configured but with this model un-enabled must not pass).
  const localModels = new Set<string>()
  if (userId && services.localModelEndpoints) {
    for (const cap of await services.localModelEndpoints.capabilitiesFor(userId)) {
      for (const model of cap.models) localModels.add(`${cap.provider}:${model}`)
    }
  }
  return {
    directProviders,
    subscriptionVendors,
    cloudflareEnabled: services.cloudflareModelsEnabled ?? false,
    localModels,
  }
}
