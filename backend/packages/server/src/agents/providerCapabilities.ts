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
  // Local runners are per-user: a model is usable when the resolving user has that
  // runner configured with ≥1 enabled model.
  const localProviders = new Set<string>(
    userId && services.localModelEndpoints
      ? (await services.localModelEndpoints.capabilitiesFor(userId)).map((c) => c.provider)
      : [],
  )
  return {
    directProviders,
    subscriptionVendors,
    cloudflareEnabled: services.cloudflareModelsEnabled ?? false,
    localProviders,
  }
}
