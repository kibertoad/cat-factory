import {
  AiAgentExecutor,
  type AgentKindRegistry,
  inlineWebSearchOptionsFromEnv,
  vendorConcurrencyLimiterFromEnv,
} from '@cat-factory/agents'
import type {
  ApiKeyService,
  LocalModelEndpointService,
  UserSecretKindRegistry,
} from '@cat-factory/integrations'
import type {
  AppCaches,
  LocalModelEndpointRepository,
  ModelProviderResolver,
  PersonalSubscriptionRepository,
  ProviderApiKeyRepository,
  ProviderSubscriptionTokenRepository,
  ResolveUserGitHubToken,
  SubscriptionActivationRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import { type AppConfig, wrapResolverWithLimiter } from '@cat-factory/server'
import { buildTraceSink } from './container-executor-deps.js'
import type { ModelProviderResolverWrapDeps } from './container.js'
import type { DrizzleDb } from './db/client.js'
import { type InlineInstrument, createNodeModelProviderResolver } from './modelProvider.js'
import {
  buildNodeApiKeyService,
  buildNodeLocalModelEndpointService,
  buildNodeOpenRouterCatalogService,
  buildNodePersonalSubscriptionService,
  buildNodePublicApiKeyService,
  buildNodeSubscriptionService,
  buildNodeUserSecretService,
} from './wireCredentialServices.js'

/**
 * The Node model-provider RESOLVER (instrumented when Langfuse is on), shared per
 * `(env, db)`. Builds a per-scope provider from the DB-backed API-key pool plus opt-in
 * Cloudflare-REST / Bedrock registries. Mirrors the Worker's buildModelProviderResolver.
 */
const modelResolverCache = new WeakMap<DrizzleDb, ModelProviderResolver>()
function buildModelProviderResolver(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  apiKeys: ApiKeyService | undefined,
  localModelEndpoints: LocalModelEndpointService | undefined,
  // The shared inline instrument (one trace sink for the proxied path, the core AND the
  // inline calls) so the OTel SDK exporter isn't rebuilt per wiring site.
  instrument: InlineInstrument | undefined,
): ModelProviderResolver {
  // The cache keys on the db handle (one resolver per Drizzle client). Mothership mode has no
  // db, so skip the cache entirely (WeakMap keys must be objects) and build a fresh resolver —
  // a mothership node builds one container, so there is nothing to share it with anyway.
  if (!db) return createNodeModelProviderResolver(env, apiKeys, localModelEndpoints, instrument)
  const cached = modelResolverCache.get(db)
  if (cached) return cached
  const resolver = createNodeModelProviderResolver(env, apiKeys, localModelEndpoints, instrument)
  modelResolverCache.set(db, resolver)
  return resolver
}

/** Inputs {@link buildNodeModelDeps} needs from the composition root. */
export interface NodeModelDepsInput {
  env: NodeJS.ProcessEnv
  config: AppConfig
  db: DrizzleDb
  workspaceRepository: WorkspaceRepository
  idGenerator: IdGenerator
  clock: Clock
  agentKindRegistry: AgentKindRegistry
  userSecretKindRegistry: UserSecretKindRegistry
  resolveWorkspaceModelDefault: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>
  providerApiKeyRepository?: ProviderApiKeyRepository
  localModelEndpointRepository?: LocalModelEndpointRepository
  providerSubscriptionTokenRepository?: ProviderSubscriptionTokenRepository
  personalSubscriptionRepository?: PersonalSubscriptionRepository
  subscriptionActivationRepository?: SubscriptionActivationRepository
  wrapModelProviderResolver?: (
    inner: ModelProviderResolver,
    deps: ModelProviderResolverWrapDeps,
  ) => ModelProviderResolver
  cloudflareModelsEnabled?: boolean
  caches?: AppCaches
}

/**
 * The credential/token stores + the model-provisioning stack of the Node composition root,
 * lifted out of `buildNodeContainer` so that root stays within the file-size budget (the same
 * reason `container-executor-deps.ts` exists). Builds the direct-provider API-key pool, the
 * public-API + local-model-endpoint + user-secret + OpenRouter-catalog + subscription +
 * personal-subscription stores, then the trace sink, the (optionally facade-wrapped +
 * vendor-limited) model-provider resolver, and the inline agent executor.
 */
export function buildNodeModelDeps(input: NodeModelDepsInput) {
  const {
    env,
    config,
    db,
    workspaceRepository,
    idGenerator,
    clock,
    agentKindRegistry,
    userSecretKindRegistry,
    resolveWorkspaceModelDefault,
    providerApiKeyRepository,
    localModelEndpointRepository,
    providerSubscriptionTokenRepository,
    personalSubscriptionRepository,
    subscriptionActivationRepository,
    wrapModelProviderResolver,
    cloudflareModelsEnabled: cloudflareModelsEnabledOverride,
    caches,
  } = input

  // The direct-provider API-key pool + the per-scope model-provider resolver, shared by
  // the inline executor, the inline modules (planner/reviewer/fragment selector), the
  // API-key controller, and the LLM proxy key lease.
  const apiKeys = buildNodeApiKeyService(
    env,
    db,
    workspaceRepository,
    idGenerator,
    clock,
    providerApiKeyRepository,
  )
  // The inbound public-API key store — drives the public `/api/v1` surface's authentication.
  const publicApiKeys = buildNodePublicApiKeyService(env, db, idGenerator, clock)
  // The per-user locally-run model endpoints store (Ollama / LM Studio / …), shared by
  // the local-runner controller, the per-user model catalog, the inline model provider,
  // and the LLM proxy.
  const localModelEndpoints = buildNodeLocalModelEndpointService(
    env,
    db,
    clock,
    localModelEndpointRepository,
  )
  // The per-user generic secret store (a GitHub PAT today), shared by the user-secret
  // controller and the run-initiator PAT resolver below.
  const userSecrets = buildNodeUserSecretService(
    env,
    db,
    clock,
    userSecretKindRegistry,
    caches?.viewerRepos,
  )
  // Resolve the run initiator's stored GitHub PAT (when set) — preferred over the
  // App/env token by the container push-token mint + the engine GitHub client.
  const resolveUserGitHubToken: ResolveUserGitHubToken | undefined = userSecrets
    ? (userId) => userSecrets.resolve(userId, 'github_pat')
    : undefined
  // The per-workspace OpenRouter dynamic-catalog store — shared by the catalog controller,
  // the per-workspace model catalog's dynamic OpenRouter entries, and the spend overlay.
  const openRouterCatalog = buildNodeOpenRouterCatalogService(
    env,
    db,
    clock,
    apiKeys,
    config.spend.currency,
  )
  // The subscription-token pool (Claude Code / Codex credentials), shared by the
  // container executor (lease + usage feedback) and the vendor-credential controller.
  // Built HERE (before the model-provider wrap below) so its lease closures can be handed
  // to `wrapModelProviderResolver` — the local facade's inline-harness wrap serves an
  // inline subscription ref through a warm container on a LEASED credential, so it needs the
  // same lease seams the container executor uses (built once, shared by both).
  const subscriptions = buildNodeSubscriptionService(
    env,
    db,
    workspaceRepository,
    idGenerator,
    clock,
    providerSubscriptionTokenRepository,
  )
  // The per-user individual-usage subscription store (Claude), shared by the
  // container executor's personal lease, the personal-subscription controller, and the
  // inline-harness wrap's per-run personal lease.
  const personalSubscriptions = buildNodePersonalSubscriptionService(
    env,
    db,
    idGenerator,
    clock,
    personalSubscriptionRepository,
    subscriptionActivationRepository,
  )
  // The ONE external trace sink for this container (memoised per config): the core, the
  // container executor AND the inline model-provider instrumentation all share this single
  // instance, so the OTel SDK exporter's batch processors/timers exist exactly once (and its
  // shutdown is wired below). Its `recordPrompts` matches the proxied path's gating.
  const traceSink = buildTraceSink(config)
  const baseModelProviderResolver = buildModelProviderResolver(
    env,
    db,
    apiKeys,
    localModelEndpoints,
    traceSink ? { traceSink, recordPrompts: config.observability.recordPrompts } : undefined,
  )
  const wrappedModelProviderResolver = wrapModelProviderResolver
    ? wrapModelProviderResolver(baseModelProviderResolver, {
        ...(personalSubscriptions
          ? {
              leasePersonalSubscriptionToken: (executionId, userId, vendor) =>
                personalSubscriptions.leaseForRun(executionId, userId, vendor),
            }
          : {}),
        ...(subscriptions
          ? {
              leaseSubscriptionToken: (workspaceId, vendor) =>
                subscriptions.leaseToken(workspaceId, vendor),
            }
          : {}),
      })
    : baseModelProviderResolver
  // Cap concurrent inline calls to a subscription vendor, OUTERMOST so it sits outside the
  // local facade's subscription-inline harness wrap above (and therefore sees the un-degraded
  // subscription ref). One limiter per container = per process for a stock node, per tenant in
  // mothership mode; a pass-through when nothing is capped. Symmetric with the Worker's wrap in
  // `buildModelProviderResolver` (see "Keep the runtimes symmetric").
  const modelProviderResolver = wrapResolverWithLimiter(
    wrappedModelProviderResolver,
    vendorConcurrencyLimiterFromEnv((key) => env[key]),
  )
  // Cloudflare Workers AI is opt-in on Node: enabled when the REST creds are present.
  const cloudflareModelsEnabled =
    cloudflareModelsEnabledOverride ?? !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_API_TOKEN)

  const inline = new AiAgentExecutor({
    modelProviderResolver,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault,
    // In local mode this keeps an ambient-eligible subscription harness ref so the inline
    // design/research kinds run on the developer's Claude Code / Codex CLI; undefined on
    // stock Node (no inline harness), where such a ref degrades to the routing default.
    ...(config.agents.inlineHarnessRef ? { runsInline: config.agents.inlineHarnessRef } : {}),
    // Opt-in provider web search for the inline design/research kinds (no-op unless
    // INLINE_WEB_SEARCH_ENABLED and an Anthropic/OpenAI model).
    webSearch: inlineWebSearchOptionsFromEnv(env),
    agentKindRegistry,
  })

  return {
    apiKeys,
    publicApiKeys,
    localModelEndpoints,
    userSecrets,
    resolveUserGitHubToken,
    openRouterCatalog,
    subscriptions,
    personalSubscriptions,
    traceSink,
    modelProviderResolver,
    cloudflareModelsEnabled,
    inline,
  }
}
