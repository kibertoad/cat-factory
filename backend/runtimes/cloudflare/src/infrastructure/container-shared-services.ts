// The deployment-wide stores and sinks every controller and the engine share, lifted out of the
// `buildContainer` composition root so that root — and this file — stay within their size
// budgets. Same shape as the sibling `container-assembly.ts` carve-out: it reads the builders
// back from `./container.js`, which is safe because nothing here runs at module-eval time.
import type { D1Database } from '@cloudflare/workers-types'
import {
  AgentContextObservabilityService,
  SearchQueryObservabilityService,
} from '@cat-factory/orchestration'
import { createAppCaches } from '@cat-factory/caching'
import { makeResolveBinaryArtifactStore } from '@cat-factory/server'
import type { AppConfig } from './config'
import type { Env } from './env'
import { CryptoIdGenerator, SystemClock } from './runtime'
import { resolveWorkerRegistries } from './container-registries.js'
import { buildAccountSettings } from './container-account-settings.js'
import { cloudflareContentStorage } from './container-artifact-storage.js'
import { buildResolvePackageRegistries, selectEventPublisher } from './container.js'
import {
  buildApiKeyService,
  buildLocalModelEndpointService,
  buildOpenRouterCatalogService,
  buildPersonalSubscriptionService,
  buildPublicApiKeyService,
  buildSubscriptionService,
  buildCapabilityCredentialsService,
  buildTestSecretsService,
  buildUserSecretService,
  buildValidationConfigService,
} from './wireCredentialServices'
import { buildDefaultWebSearchUpstream } from './container-executor-deps.js'
import { D1AgentContextSnapshotRepository } from './repositories/D1AgentContextSnapshotRepository'
import { D1AgentSearchQueryRepository } from './repositories/D1AgentSearchQueryRepository'
import { D1WorkspaceSettingsRepository } from './repositories/D1WorkspaceSettingsRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { D1BinaryArtifactMetadataStore } from './repositories/D1BinaryArtifactMetadataStore'
import { CfGitHubWebhookIngest } from './gateways/GitHubGateways'
import { logger } from './observability/logger'
import { buildNotificationWebhookSupportForWorker } from './container-notification-deps'

export interface WorkerSharedServicesInput {
  env: Env
  config: AppConfig
  db: D1Database
  telemetryDb: D1Database
  clock: SystemClock
  idGenerator: CryptoIdGenerator
  caches: ReturnType<typeof createAppCaches>
  userSecretKindRegistry: ReturnType<typeof resolveWorkerRegistries>['userSecretKindRegistry']
  contentStorageCapability: ReturnType<typeof cloudflareContentStorage>['capability']
  buildCfBlobBackend: ReturnType<typeof cloudflareContentStorage>['buildBlobBackend']
  cloudflareModelsEnabledOverride: boolean | undefined
}

export function buildWorkerSharedServices(input: WorkerSharedServicesInput) {
  const {
    env,
    config,
    db,
    telemetryDb,
    clock,
    idGenerator,
    caches,
    userSecretKindRegistry,
    contentStorageCapability,
    buildCfBlobBackend,
  } = input

  // The subscription-token pool (Claude Code / Codex credentials) — built once and
  // shared by the container executor (lease + usage feedback) and the
  // vendor-credential controller, so both read the same pool.
  const subscriptions = buildSubscriptionService(env, db, clock)

  // The sensitive per-service test-credential store (sealed) — shared by the test-secrets
  // CRUD controller and the engine's prompt refs (the executor builds its own value resolver).
  const testSecretsService = buildTestSecretsService(env, db, clock)
  const capabilityCredentialsService = buildCapabilityCredentialsService(env, db, clock)

  const validationConfigService = buildValidationConfigService(db, clock)

  // The per-user individual-usage subscription store (Claude) — shared by the
  // personal-subscription controller and the container executor's personal lease.
  const personalSubscriptions = buildPersonalSubscriptionService(env, db, clock)

  // The direct-provider API-key pool (account/workspace/user) — shared by the
  // API-key controller, the model-provider resolver, and the LLM proxy key lease.
  const apiKeys = buildApiKeyService(env, db, clock)

  // The inbound public-API key store — drives the public `/api/v1` surface's authentication.
  const publicApiKeys = buildPublicApiKeyService(env, db, clock)

  // The per-user locally-run model endpoints store (Ollama / LM Studio / …) — shared by
  // the local-runner controller, the per-user model catalog, and the LLM proxy.
  const localModelEndpoints = buildLocalModelEndpointService(env, db, clock)

  // The per-user generic secret store (a GitHub PAT today) — shared by the user-secret
  // controller; also backs the run-initiator PAT resolver used by the executor + gates.
  const userSecrets = buildUserSecretService(
    env,
    db,
    clock,
    userSecretKindRegistry,
    caches.viewerRepos,
  )

  // The per-workspace OpenRouter dynamic-catalog store — shared by the catalog controller,
  // the per-workspace model catalog's dynamic OpenRouter entries, and the spend overlay.
  const openRouterCatalog = buildOpenRouterCatalogService(
    env,
    db,
    clock,
    apiKeys,
    config.spend.currency,
  )

  // Cloudflare Workers AI is opt-in: enabled when the `AI` binding is present. A caller
  // (the cross-runtime conformance suite) may force it off to assert key-driven
  // selectability + the provider guard uniformly across runtimes.
  const cloudflareModelsEnabled = input.cloudflareModelsEnabledOverride ?? !!env.AI

  // Built once so the consensus executor and the engine share the same publisher (live
  // consensus transcript pushes ride the same hub as run/board events).
  const eventPublisher = selectEventPublisher(env, db)

  // Agent-context observability sink: records the complete, redacted context provided
  // to each container agent (composed prompts + folded-in fragments + injected files).
  // Gated by the deployment prompt-recording switch + the workspace storeAgentContext
  // setting. Wired into the executor (write) AND createCore (read). Telemetry rows live
  // in the dedicated TELEMETRY_DB database.
  const agentContextObservability = new AgentContextObservabilityService({
    agentContextSnapshotRepository: new D1AgentContextSnapshotRepository({ db: telemetryDb }),
    workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
    idGenerator,
    clock,
    recordPrompts: config.observability.recordPrompts,
  })

  // Agent-search-query observability sink: records each web search a container agent
  // performed through the search proxy. Same double gate + retention window as the
  // agent-context sink. Wired into the search proxy (write, via the container) AND
  // createCore (read). Telemetry rows live in the dedicated TELEMETRY_DB database.
  const searchQueryObservability = new SearchQueryObservabilityService({
    agentSearchQueryRepository: new D1AgentSearchQueryRepository({ db: telemetryDb }),
    workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
    idGenerator,
    clock,
    recordPrompts: config.observability.recordPrompts,
  })

  // Per-account deployment settings (Slack OAuth + web-search keys + content-storage). Built
  // once so the service's short-TTL cache is shared across requests; the Slack OAuth +
  // content-storage resolvers are derived from it in the domain composition root.
  const accountSettings = buildAccountSettings(
    env,
    db,
    clock,
    contentStorageCapability,
    caches.accountSettings,
  )

  // The deployment-wide trusted web-search upstream (built from this facade's own `WEB_SEARCH_*`
  // env), read by `WebSearchProxyController` as the fallback when a run's account has no keys.
  // Kept symmetric with the Node facade; absent unless the operator sets a `WEB_SEARCH_*` var.
  const defaultWebSearchUpstream = buildDefaultWebSearchUpstream(env)

  // Resolve the binary-artifact store for a workspace's account from its content-storage
  // settings (the blob backend is per-account; the metadata is the shared D1 store). Without
  // `accountSettings` (no encryption key) every workspace falls back to the runtime default
  // (R2 when bound), with no per-account override. Caches per account, so an R2→S3 switch
  // rebuilds and the many workspaces under one account share a store.
  const resolveBinaryArtifactStore = makeResolveBinaryArtifactStore({
    accountSettings,
    accountOf: (workspaceId) => new D1WorkspaceRepository({ db }).accountOf(workspaceId),
    metadata: new D1BinaryArtifactMetadataStore({ db }),
    idGenerator,
    clock,
    buildBlobBackend: buildCfBlobBackend,
    defaultBackend: contentStorageCapability.defaultBackend,
    logger,
  })

  // GitHub webhook/resync/backfill ingest via the sync Queue (absent → inline handling). Built
  // once so the engine's skill-freshness fan-out (slice 4) enqueues through the SAME seam the
  // gateway exposes, rather than reaching for the queue binding a second time.
  const githubWebhookIngest = new CfGitHubWebhookIngest(env.GITHUB_SYNC_QUEUE)

  // The outbound notification webhook: management service + delivery channel from ONE builder, so
  // the surface that reports an endpoint as configured and the channel that delivers to it can
  // never end up on different repositories/ciphers.
  const notificationWebhookSupport = buildNotificationWebhookSupportForWorker(
    env,
    config,
    db,
    clock,
  )

  return {
    cloudflareModelsEnabled,
    subscriptions,
    testSecretsService,
    capabilityCredentialsService,
    validationConfigService,
    personalSubscriptions,
    apiKeys,
    publicApiKeys,
    localModelEndpoints,
    userSecrets,
    openRouterCatalog,
    eventPublisher,
    agentContextObservability,
    searchQueryObservability,
    accountSettings,
    // The executor's own two handles. `webSearchAccountSettings` is a SECOND, deliberately
    // uncached account-settings reader (see `WorkerExecutorDeps`); building both here keeps the
    // module graph one-way — `container-executor-deps.ts` never imports the root.
    executorPackageRegistries: buildResolvePackageRegistries(env, db),
    webSearchAccountSettings: buildAccountSettings(env, db, clock),
    defaultWebSearchUpstream,
    resolveBinaryArtifactStore,
    githubWebhookIngest,
    notificationWebhookSupport,
  }
}
