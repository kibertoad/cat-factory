import type {
  ApiKeyService,
  LocalModelEndpointService,
  OpenRouterCatalogService,
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
  /**
   * The deployment's base-URL resolver (the same one the model-provider resolver uses).
   * OpenAI-compatible providers (everything but `openai`/`anthropic`) cannot resolve
   * without a base URL — most carry a built-in default, but an operator-hosted gateway
   * like LiteLLM has none until `LITELLM_BASE_URL` is set. When this resolver is wired, a
   * configured key for such a provider is treated as selectable ONLY once its base URL
   * resolves, so the catalog + start guard don't offer a model that fails at dispatch.
   */
  baseUrlFor?: (provider: string) => string | null | undefined
  /** Per-user locally-run model endpoints (resolved by the requesting/initiating user). */
  localModelEndpoints?: LocalModelEndpointService
  /** Per-workspace enabled OpenRouter models (the dynamic catalog subset). */
  openRouterCatalog?: OpenRouterCatalogService
}

// Direct providers whose AI-SDK resolver works without an explicit base URL (the SDK
// has a built-in default). Every OTHER direct provider is OpenAI-compatible and needs a
// base URL (see `buildDirectResolver`), so it is unusable until that URL resolves.
const BASE_URL_OPTIONAL = new Set(['openai', 'anthropic'])

export async function resolveWorkspaceCapabilities(
  services: CapabilityServices,
  workspaceId: string,
  userId?: string | null,
): Promise<ProviderCapabilities> {
  const configured = services.apiKeys
    ? await services.apiKeys.configuredProviders(workspaceId, { userId })
    : []
  const baseUrlFor = services.baseUrlFor
  const directProviders = new Set<string>(
    // Drop a key whose provider needs a base URL the deployment hasn't configured: it
    // would pass the catalog/start guard but throw "No base URL configured" at dispatch.
    baseUrlFor ? configured.filter((p) => BASE_URL_OPTIONAL.has(p) || !!baseUrlFor(p)) : configured,
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
  // Dynamic OpenRouter catalog (per-workspace): the enabled slugs gate the dynamic
  // `openrouter:<slug>` models, in addition to the key being in `directProviders`.
  const openRouterModels = new Set<string>()
  if (services.openRouterCatalog) {
    for (const m of await services.openRouterCatalog.capabilitiesFor(workspaceId)) {
      openRouterModels.add(m.id)
    }
  }
  return {
    directProviders,
    subscriptionVendors,
    cloudflareEnabled: services.cloudflareModelsEnabled ?? false,
    localModels,
    openRouterModels,
  }
}
