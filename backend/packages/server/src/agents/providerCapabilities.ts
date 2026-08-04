import type {
  AccountSettingsService,
  ApiKeyService,
  LocalModelEndpointService,
  OpenRouterCatalogService,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
} from '@cat-factory/integrations'
import {
  ALL_SUBSCRIPTION_VENDORS,
  type AppCaches,
  type ModelFamilyPolicy,
  type ModelFlavor,
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
   * The deployment's Bedrock allow-list (`BEDROCK_MODELS`), VERBATIM and in declared order,
   * and ONLY when the `bedrock` resolver is actually registered: a list with no
   * `BEDROCK_REGION` behind it (or, on the Worker, no registered registry serving the
   * provider) would offer routes that throw at dispatch. This is a
   * deployment-level capability, not a per-workspace one: Bedrock is reached with the
   * deployment's own AWS credentials, so there is no key to lease per scope.
   */
  bedrockModels?: Set<string>
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
  /**
   * The account-settings service, read to resolve the owning account's model-family policy.
   * Wired only on facades that {@link modelPolicySupported support it}.
   */
  accountSettings?: AccountSettingsService
  /** Resolve a workspace's owning account id (`undefined`/`null` ⇒ unscoped/legacy board). */
  workspaceAccountOf?: (workspaceId: string) => Promise<string | null | undefined>
  /**
   * Whether this deployment enforces the account-wide model-family policy (Cloudflare /
   * remote Node / mothership — never plain local mode). When false the policy is neither
   * read nor applied here, mirroring the availability the SPA sees via `/auth/config`.
   */
  modelPolicySupported?: boolean
  /**
   * App caches — the account policy read goes through `caches.accountModelPolicy` (a
   * slow-moving, admin-changed, per-account read on the `/models` + start-guard hot paths;
   * invalidated by the account-settings write). Absent ⇒ the read runs live each time.
   */
  caches?: AppCaches
  /**
   * The route order the MODEL PRESET in force states, from the preset library
   * (`resolvePresetProviderPreference`). Called with the preset the caller is resolving under —
   * a block's selected one, or `undefined` for the workspace default preset. Absent (tests /
   * unwired facades) ⇒ the deployment's default order.
   */
  resolvePresetProviderPreference?: (
    workspaceId: string,
    modelPresetId?: string,
  ) => Promise<readonly ModelFlavor[] | undefined>
}

// Direct providers whose AI-SDK resolver works without an explicit base URL (the SDK
// has a built-in default). Every OTHER direct provider is OpenAI-compatible and needs a
// base URL (see `buildDirectResolver`), so it is unusable until that URL resolves.
const BASE_URL_OPTIONAL = new Set(['openai', 'anthropic'])

/**
 * The account-wide model-family policy in force for a workspace, or undefined for no restriction.
 * A `null`/legacy account and an `off` policy both mean the latter.
 *
 * Read THROUGH the per-account cache (slow-moving, admin-changed, on the `/models` + start-guard
 * hot paths): the load reads only the non-secret config, and wraps the result so the common "no
 * policy" case caches as a value rather than a re-loaded null.
 *
 * Its own function rather than a block inside {@link resolveWorkspaceCapabilities} because it is
 * the only capability with three optional collaborators, a cache and a swallow — everything else
 * there is one read per field.
 */
async function resolveAccountModelPolicy(
  services: CapabilityServices,
  workspaceId: string,
): Promise<ModelFamilyPolicy | undefined> {
  const accountSettings = services.accountSettings
  if (!services.modelPolicySupported || !accountSettings || !services.workspaceAccountOf) {
    return undefined
  }
  try {
    const accountId = await services.workspaceAccountOf(workspaceId)
    if (!accountId) return undefined
    const load = async () => ({
      policy: (await accountSettings.read(accountId)).config.modelPolicy ?? null,
    })
    const cached = services.caches?.accountModelPolicy
    const { policy } = cached ? await cached.get(accountId, accountId, load) : await load()
    return policy && policy.mode !== 'off' ? policy : undefined
  } catch {
    // Account settings aren't always readable — mothership mode delegates org state over an RPC
    // whose allow-list doesn't yet include the account-settings read (the same limitation the
    // binary-storage infra probe degrades on). Treat an unreadable policy as "no restriction"
    // rather than failing run start / the model catalog.
    return undefined
  }
}

export async function resolveWorkspaceCapabilities(
  services: CapabilityServices,
  workspaceId: string,
  userId?: string | null,
  modelPresetId?: string,
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
  const modelPolicy = await resolveAccountModelPolicy(services, workspaceId)
  // The route order the preset in force states. It rides the capability set (rather than a
  // parameter each resolution site would have to remember) so the catalog the picker renders and
  // the guard that admits the run walk the SAME order. A read failure is NOT swallowed: unlike the
  // account policy above, which degrades to "no restriction", an unreadable preference has no safe
  // default — every route stays reachable either way, so the honest thing is to let the caller see
  // the failure rather than admit a compliance-motivated run on the wrong route.
  const providerPreference = await services.resolvePresetProviderPreference?.(
    workspaceId,
    modelPresetId,
  )
  return {
    directProviders,
    subscriptionVendors,
    cloudflareEnabled: services.cloudflareModelsEnabled ?? false,
    localModels,
    openRouterModels,
    ...(services.bedrockModels?.size ? { bedrockModels: services.bedrockModels } : {}),
    ...(modelPolicy ? { modelPolicy } : {}),
    ...(providerPreference?.length ? { providerPreference } : {}),
  }
}
