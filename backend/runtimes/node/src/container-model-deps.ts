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
  LlmCallMetricRepository,
  LocalModelEndpointRepository,
  ModelProviderResolver,
  PersonalSubscriptionRepository,
  ProviderApiKeyRepository,
  ProviderSubscriptionTokenRepository,
  ResolveUserGitHubToken,
  SubscriptionActivationRepository,
  WorkspaceRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import type {
  AgentContextRecorder,
  Clock,
  IdGenerator,
  ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'
import {
  type AppConfig,
  createInlineInstrumentation,
  logger,
  wrapResolverWithTelemetry,
} from '@cat-factory/server'
import { buildTraceSink } from './container-executor-deps.js'
import type { ModelProviderResolverWrapDeps } from './container.js'
import type { DrizzleDb } from './db/client.js'
import { createNodeModelProviderResolver } from './modelProvider.js'
import { cloudflareRestCredentials } from './providerEndpoints.js'
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
 * The Node BASE model-provider resolver, shared per `(env, db)`. Builds a per-scope provider
 * from the DB-backed API-key pool plus opt-in Cloudflare-REST / Bedrock registries. Mirrors the
 * Worker's buildModelProviderResolver.
 *
 * Deliberately un-instrumented, and cached that way: the telemetry wrap and the facade's own
 * wraps are composed per container in {@link buildNodeModelDeps} (they close over that
 * container's trace sink, metric store and subscription-lease seams, none of which may leak
 * across two containers sharing a Drizzle client).
 */
const modelResolverCache = new WeakMap<DrizzleDb, ModelProviderResolver>()
function buildModelProviderResolver(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  apiKeys: ApiKeyService | undefined,
  localModelEndpoints: LocalModelEndpointService | undefined,
): ModelProviderResolver {
  // The cache keys on the db handle (one resolver per Drizzle client). Mothership mode has no
  // db, so skip the cache entirely (WeakMap keys must be objects) and build a fresh resolver —
  // a mothership node builds one container, so there is nothing to share it with anyway.
  if (!db) return createNodeModelProviderResolver(env, apiKeys, localModelEndpoints)
  const cached = modelResolverCache.get(db)
  if (cached) return cached
  const resolver = createNodeModelProviderResolver(env, apiKeys, localModelEndpoints)
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
  /**
   * The workspace-settings store, read by the inline LLM path's per-workspace
   * `storeAgentContext` body gate. Threaded here (like `workspaceRepository`) rather than
   * rebuilt from `db`, so mothership mode's routed repository is the one consulted.
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /**
   * The LLM-call telemetry store the inline metric recorder writes to. Threaded from the
   * composition root's repository set (not rebuilt from `db`) so mothership mode's routed
   * local-first telemetry store is the one written. Absent ⇒ no inline metric recording,
   * and inline calls fall back to the trace sink alone.
   */
  llmCallMetricRepository?: LlmCallMetricRepository
  /**
   * The account's binary-artifact store, for the design pictures an inline dispatch attaches to
   * its model call. Absent ⇒ an inline kind's prompt states that the pictures could not be
   * delivered rather than pretending the task holds none.
   */
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /**
   * The agent-context observability sink, so an INLINE dispatch files the provided-context
   * snapshot its container sibling has always filed. Absent ⇒ no inline snapshots, as on a
   * deployment retaining no telemetry.
   */
  agentContextRecorder?: AgentContextRecorder
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
    workspaceSettingsRepository,
    llmCallMetricRepository,
    resolveBinaryArtifactStore,
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
  // shutdown is wired below). Its `recordPrompts` matches the proxied path's gating — as
  // does the per-workspace `storeAgentContext` gate beside it, which is the half the inline
  // path used to lack entirely (observability-logging-gaps.md, C2).
  const traceSink = buildTraceSink(config)
  // Persist inline (non-proxied) calls to the SAME `llm_call_metrics` store the proxy writes
  // for Pi and the executor writes for a subscription harness, so an inline agent kind
  // (`doc-researcher`, the judges, consensus, the requirements writer) shows up in
  // `ObservabilityPanel`, in a step's token rollup and in `/api/v1/debug/*` instead of only in
  // an external trace backend. The metric repository is threaded from the composition root
  // (not rebuilt off `db`), so in mothership mode this writes the routed local-first telemetry
  // store. Composed through the shared factory so the recorder's service and the provider's
  // fallback sink cannot be handed two DIFFERENT instances — the service fans out a recorded
  // call itself, so a mismatch would split the trace and wiring both to the provider would
  // double every inline generation.
  const instrument = createInlineInstrumentation({
    ...(llmCallMetricRepository ? { llmCallMetricRepository } : {}),
    ...(traceSink ? { traceSink } : {}),
    recordPrompts: config.observability.recordPrompts,
    ...(workspaceSettingsRepository ? { workspaceSettingsRepository } : {}),
    ...(caches?.workspaceSettings ? { workspaceSettingsCache: caches.workspaceSettings } : {}),
    idGenerator,
    clock,
  })
  const baseModelProviderResolver = buildModelProviderResolver(
    env,
    db,
    apiKeys,
    localModelEndpoints,
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
        // Hand the wrap the SAME recorder the instrumentation above is built with, so a model it
        // SUBSTITUTES can file the per-call telemetry the middleware structurally cannot see. Local
        // mode's inline harness is the case: one `generateText` there is a whole CLI tool loop, so
        // the middleware could only ever report it as one lumped call, only once the subprocess had
        // exited, and — a rejection carrying no usage — as zeros whenever the run was killed. Such a
        // model stands the middleware down (`reportsOwnLlmCalls`), which is why this must be that
        // one recorder and not a second: the service behind it owns the trace fan-out.
        //
        // Not a conditional spread: the field is required-but-nullable precisely so omitting it here
        // is a typecheck failure rather than a deployment that silently reports no model activity.
        recordInlineCall: instrument?.recordCall,
        // And whether that model's runner should assemble prompt/response BODIES at all. A harness
        // CLI's per-call bodies are RECONSTRUCTED (the growing request transcript, re-serialised per
        // call, held in this process), so a prompts-off deployment must not pay for what the store
        // is about to drop — the same reason every other body reaches the recorder as a thunk.
        recordInlineBodies: config.observability.recordPrompts,
      })
    : baseModelProviderResolver
  // Observe inline calls and cap their concurrency, both applied on top of the facade wrap above
  // — never beneath it. That wrap SUBSTITUTES the resolved model for a subscription harness ref
  // (local mode answers one with its own `CliInlineLanguageModel` rather than delegating), so
  // instrumenting underneath it left every inline step on a host `claude`/`codex` CLI — the
  // default local shape — recording nothing at all while the same step on a metered API model
  // recorded fine. The composer owns that order (and keeps the limiter outermost, so a queue wait
  // is not generation time and it sees the un-degraded subscription ref); passing the
  // already-wrapped resolver in is this facade's only remaining obligation. One limiter per
  // container = per process for a stock node, per tenant in mothership mode; a pass-through when
  // nothing is capped. Symmetric with the Worker's `buildModelProviderResolver` (see "Keep the
  // runtimes symmetric").
  const modelProviderResolver = wrapResolverWithTelemetry(wrappedModelProviderResolver, {
    ...(instrument ? { instrument } : {}),
    limiter: vendorConcurrencyLimiterFromEnv((key) => env[key]),
  })
  // Cloudflare Workers AI is opt-in on Node: enabled when the REST creds are present. Read through
  // the SAME credential resolver the inline registry and the container proxy's REST upstream use,
  // so this gate cannot offer models a dispatch then refuses (a whitespace-only account id read as
  // configured here and as absent there).
  const cloudflareModelsEnabled =
    cloudflareModelsEnabledOverride ?? !!cloudflareRestCredentials(env)

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
    ...(resolveBinaryArtifactStore ? { resolveBinaryArtifactStore } : {}),
    // Symmetric with the Worker's `selectAgentExecutor`: the inline executor files its provided
    // context to the same sink the container executor does. A required key, so this facade cannot
    // drop it back to nothing without failing to typecheck.
    agentContextRecorder: input.agentContextRecorder,
    logger,
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
