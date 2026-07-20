import {
  ACCOUNT_SETTINGS_CIPHER_INFO,
  AccountSettingsService,
  RegistrySubscriptionQuotaProvider,
  TEST_SECRETS_CIPHER_INFO,
  TestSecretsService,
  defaultSubscriptionQuotaRegistry,
} from '@cat-factory/integrations'
import type { AppCaches, Clock, IdGenerator, WebSearchAvailability } from '@cat-factory/kernel'
import {
  AgentContextObservabilityService,
  LlmObservabilityService,
  PACKAGE_REGISTRY_CIPHER_INFO,
  SearchQueryObservabilityService,
  makeHarnessCallRecorder,
  resolvePackageRegistriesForDispatch,
} from '@cat-factory/orchestration'
import {
  type AppConfig,
  WebCryptoSecretCipher,
  createDefaultWebSearchUpstream,
  createWebSearchUpstream,
} from '@cat-factory/server'
import type { createDrizzleRepositories } from './repositories/drizzle.js'

type NodeRepositories = ReturnType<typeof createDrizzleRepositories>

/** Inputs {@link buildNodeRunServices} needs from the composition root. */
export interface NodeRunServicesInput {
  env: NodeJS.ProcessEnv
  config: AppConfig
  repos: NodeRepositories
  idGenerator: IdGenerator
  clock: Clock
  caches?: AppCaches
}

/**
 * The per-run agent-observability + web-search + sealed-secret services of the Node
 * composition root, lifted out of `buildNodeContainer` so that root stays within the
 * file-size budget. Builds the agent-context / search-query / harness-call telemetry sinks,
 * the deployment-wide web-search upstream + availability resolver, the package-registry +
 * test-secret dispatch resolvers, and the modeled subscription-quota provider.
 */
export function buildNodeRunServices(input: NodeRunServicesInput) {
  const { env, config, repos, idGenerator, clock, caches } = input

  // Agent-context observability sink: records the complete, redacted context provided
  // to each container agent (composed prompts + folded-in fragments + injected files).
  // Gated by the deployment prompt-recording switch + the workspace storeAgentContext
  // setting. Wired into the executor (write) AND createCore (read). The telemetry rows
  // live in the `telemetry` Postgres schema (see schema.ts).
  const agentContextObservability = new AgentContextObservabilityService({
    agentContextSnapshotRepository: repos.agentContextSnapshotRepository,
    workspaceSettingsRepository: repos.workspaceSettingsRepository,
    idGenerator,
    clock,
    recordPrompts: config.observability.recordPrompts,
  })
  // Agent-search-query observability sink: records each web search a container agent
  // performed through the search proxy. Same double gate + retention window as the
  // agent-context sink. Wired into the search proxy (write, via the container) AND
  // createCore (read). Telemetry rows live in the `telemetry` Postgres schema.
  const searchQueryObservability = new SearchQueryObservabilityService({
    agentSearchQueryRepository: repos.agentSearchQueryRepository,
    workspaceSettingsRepository: repos.workspaceSettingsRepository,
    idGenerator,
    clock,
    recordPrompts: config.observability.recordPrompts,
  })
  // Record a subscription harness's (Claude Code / Codex) per-call telemetry into the
  // SAME `llm_call_metrics` store the LLM proxy writes for Pi — those harnesses bypass
  // the proxy, so the executor lifts the metrics off the CLI stream and feeds them here.
  const recordHarnessCalls = makeHarnessCallRecorder(
    new LlmObservabilityService({
      llmCallMetricRepository: repos.llmCallMetricRepository,
      idGenerator,
      clock,
      recordPrompts: config.observability.recordPrompts,
    }),
  )
  // A deployment-wide trusted web-search upstream, built from this facade's own `WEB_SEARCH_*`
  // env, used by the search proxy as a fallback when a run's account has no web-search config
  // (local mode defaults `WEB_SEARCH_SEARXNG_URL` to its self-hosted SearXNG). Distinct from the
  // harness's own `SEARXNG_URL`/`BRAVE_SEARCH_API_KEY` runner-pool autodetect — those are for
  // self-hosted pool containers; these keys stay on the backend. Surfaced on the ServerContainer
  // below and read by `WebSearchProxyController`.
  const defaultWebSearchUpstream = createDefaultWebSearchUpstream({
    braveApiKey: env.WEB_SEARCH_BRAVE_API_KEY,
    searxngUrl: env.WEB_SEARCH_SEARXNG_URL,
    searxngApiKey: env.WEB_SEARCH_SEARXNG_API_KEY,
  })
  // Web-search keys live per-account; advertise Pi's `web_search` tool to a run only when a
  // usable upstream exists — either the deployment default above (⇒ always on) or the run's
  // account has its own keys (else the tool would just fail/return nothing). The per-account
  // check runs off a dedicated account-settings instance (short-TTL cache).
  const webSearchAccountKey = env.ENCRYPTION_KEY?.trim()
  const webSearchAccountSettings = webSearchAccountKey
    ? new AccountSettingsService({
        accountSettingsRepository: repos.accountSettingsRepository,
        secretCipher: new WebCryptoSecretCipher({
          masterKeyBase64: webSearchAccountKey,
          info: ACCOUNT_SETTINGS_CIPHER_INFO,
        }),
        clock,
        ...(caches ? { settingsCache: caches.accountSettings } : {}),
      })
    : undefined
  const resolveWebSearchAvailability =
    defaultWebSearchUpstream || webSearchAccountSettings
      ? async (workspaceId: string): Promise<WebSearchAvailability> => {
          // Mirror the proxy's own resolution (`accountUpstream ?? defaultWebSearchUpstream`):
          // the run's account keys WIN and the deployment default is only the fallback, so the
          // surfaced provider matches the one that will actually serve the run's searches. Build
          // the account upstream the SAME way the proxy does before falling back to the default.
          if (webSearchAccountSettings) {
            const accountId = await repos.workspaceRepository.accountOf(workspaceId)
            if (accountId) {
              const accountUpstream = createWebSearchUpstream(
                (await webSearchAccountSettings.resolve(accountId)).webSearch ?? {},
              )
              if (accountUpstream) return { available: true, provider: accountUpstream.provider }
            }
          }
          if (defaultWebSearchUpstream)
            return { available: true, provider: defaultWebSearchUpstream.provider }
          return { available: false, provider: null }
        }
      : undefined
  // Private package registries (npm private orgs, GitHub Packages): sealed per-workspace
  // entries decrypted only at container dispatch, rendered by the harness into ~/.npmrc.
  // The cipher is shared by the dispatch resolver here and the management service below.
  const packageRegistryEncryptionKey = env.ENCRYPTION_KEY?.trim()
  const packageRegistrySecretCipher = packageRegistryEncryptionKey
    ? new WebCryptoSecretCipher({
        masterKeyBase64: packageRegistryEncryptionKey,
        info: PACKAGE_REGISTRY_CIPHER_INFO,
      })
    : undefined
  const resolvePackageRegistries = packageRegistrySecretCipher
    ? (workspaceId: string) =>
        resolvePackageRegistriesForDispatch(
          repos.packageRegistryConnectionRepository,
          packageRegistrySecretCipher,
          workspaceId,
        )
    : undefined
  // Sensitive per-service test credentials (sealed): the service backs the CRUD controller, the
  // engine's prompt refs (via `resolveTestSecretRefs`) and the executor's out-of-band value
  // injection (via `resolveTestSecrets`). Guarded by ENCRYPTION_KEY like the other sealed stores.
  const testSecretsEncryptionKey = env.ENCRYPTION_KEY?.trim()
  const testSecretsService = testSecretsEncryptionKey
    ? new TestSecretsService({
        testSecretsRepository: repos.testSecretsRepository,
        secretCipher: new WebCryptoSecretCipher({
          masterKeyBase64: testSecretsEncryptionKey,
          info: TEST_SECRETS_CIPHER_INFO,
        }),
        blockRepository: repos.blockRepository,
        clock,
      })
    : undefined
  const resolveTestSecrets = testSecretsService
    ? (workspaceId: string, blockId: string) =>
        testSecretsService.resolveValuesForBlock(workspaceId, blockId)
    : undefined
  const resolveTestSecretRefs = testSecretsService
    ? (workspaceId: string, blockId: string) =>
        testSecretsService.resolveRefsForBlock(workspaceId, blockId)
    : undefined
  // Modeled subscription quota-cycle provider (usage-and-quota-tracking, Part B): folds a
  // finished subscription run's tokens into rolling windows (real reads land in B2). The
  // registry of REAL vendor adapters is empty today, so every vendor reports modeled.
  const subscriptionQuotaProvider = new RegistrySubscriptionQuotaProvider({
    subscriptionQuotaCycleRepository: repos.subscriptionQuotaCycleRepository,
    idGenerator,
    clock,
    registry: defaultSubscriptionQuotaRegistry,
  })

  return {
    agentContextObservability,
    searchQueryObservability,
    recordHarnessCalls,
    defaultWebSearchUpstream,
    resolveWebSearchAvailability,
    packageRegistrySecretCipher,
    resolvePackageRegistries,
    testSecretsService,
    resolveTestSecrets,
    resolveTestSecretRefs,
    subscriptionQuotaProvider,
  }
}
