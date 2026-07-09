import {
  ApiKeyService,
  LocalModelEndpointService,
  OpenRouterCatalogService,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  PublicApiKeyService,
  UserSecretService,
  type UserSecretKindRegistry,
  usdRateForSpendCurrency,
} from '@cat-factory/integrations'
import type {
  Clock,
  LocalModelEndpointRepository,
  PersonalSubscriptionRepository,
  ProviderApiKeyRepository,
  ProviderSubscriptionTokenRepository,
  SubscriptionActivationRepository,
} from '@cat-factory/kernel'
import type { CoreDependencies } from '@cat-factory/orchestration'
import { WebCryptoPersonalSecretCipher, WebCryptoSecretCipher } from '@cat-factory/server'
import type { DrizzleDb } from './db/client.js'
import { baseUrlForNode } from './modelProvider.js'
import { DrizzleProviderSubscriptionTokenRepository } from './repositories/providerSubscription.js'
import { DrizzleProviderApiKeyRepository } from './repositories/providerApiKey.js'
import { DrizzlePublicApiKeyRepository } from './repositories/publicApiKey.js'
import {
  DrizzlePersonalSubscriptionRepository,
  DrizzleSubscriptionActivationRepository,
} from './repositories/personalSubscription.js'
import { DrizzleLocalModelEndpointRepository } from './repositories/localModelEndpoint.js'
import { DrizzleUserSecretRepository } from './repositories/userSecret.js'
import { DrizzleProviderModelCatalogRepository } from './repositories/providerModelCatalog.js'

// The sealed per-scope credential / subscription / provider-key stores for the Node/local
// facade (Postgres-backed, with local-sqlite override seams for mothership mode), each keyed
// on the shared ENCRYPTION_KEY. Grouped out of `container.ts` as the first per-concern wiring
// helper of modularisation split #4; every builder is a pure move (identical signatures +
// bodies), re-imported at its original call site. Symmetric with the Worker facade's
// `wireCredentialServices.ts`.

/**
 * Build the workspace subscription-token pool service for the Node/local facade
 * (Postgres-backed), or undefined when the shared ENCRYPTION_KEY is absent. Tokens
 * are sealed under a subscriptions-scoped HKDF info of the shared master key.
 */
export function buildNodeSubscriptionService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  workspaceRepository: CoreDependencies['workspaceRepository'],
  idGenerator: CoreDependencies['idGenerator'],
  clock: Clock,
  // Mothership mode injects the local `node:sqlite` credential store here, so the pooled
  // subscription tokens stay on the laptop (the LOCAL container executor leases + decrypts
  // them). Else the Drizzle repo over `db`, and the service turns off without either.
  repositoryOverride?: ProviderSubscriptionTokenRepository,
): ProviderSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  const providerSubscriptionTokenRepository =
    repositoryOverride ?? (db ? new DrizzleProviderSubscriptionTokenRepository(db) : undefined)
  if (!providerSubscriptionTokenRepository) return undefined
  return new ProviderSubscriptionService({
    providerSubscriptionTokenRepository,
    workspaceRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:provider-subscriptions',
    }),
    idGenerator,
    clock,
  })
}

/**
 * Build the direct-provider API-key pool (account/workspace/user) for the Node/local
 * facade (Postgres-backed), or undefined when the shared ENCRYPTION_KEY is absent.
 * Keys are sealed under an api-keys-scoped HKDF info of the shared master key. Mirrors
 * the Worker's buildApiKeyService.
 */
export function buildNodeApiKeyService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  workspaceRepository: CoreDependencies['workspaceRepository'],
  idGenerator: CoreDependencies['idGenerator'],
  clock: Clock,
  // Mothership mode injects the local `node:sqlite` credential store here, so the key pool
  // stays on the laptop (the mothership's key never reaches it). Else the Drizzle repo over `db`.
  repositoryOverride?: ProviderApiKeyRepository,
): ApiKeyService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  const providerApiKeyRepository =
    repositoryOverride ?? (db ? new DrizzleProviderApiKeyRepository(db) : undefined)
  if (!providerApiKeyRepository) return undefined
  return new ApiKeyService({
    providerApiKeyRepository,
    workspaceRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:provider-api-keys',
    }),
    idGenerator,
    clock,
  })
}

/**
 * Build the INBOUND public-API key store for the Node/local facade (Postgres-backed), or
 * undefined when the shared ENCRYPTION_KEY is absent. Uses ENCRYPTION_KEY as the HMAC pepper for
 * the one-way secret hash (a public-API key is verified, never decrypted). Mirrors the Worker's
 * buildPublicApiKeyService.
 */
export function buildNodePublicApiKeyService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  idGenerator: CoreDependencies['idGenerator'],
  clock: Clock,
): PublicApiKeyService | undefined {
  const pepper = env.ENCRYPTION_KEY?.trim()
  if (!pepper || !db) return undefined
  return new PublicApiKeyService({
    repository: new DrizzlePublicApiKeyRepository(db),
    pepper,
    idGenerator,
    clock,
  })
}

/**
 * Build the per-USER individual-usage subscription service (Claude) for the Node/local
 * facade (Postgres-backed), or undefined when the shared ENCRYPTION_KEY is absent.
 * Double-encrypts the credential (password layer inside the system layer). Mirrors the
 * Worker's buildPersonalSubscriptionService.
 */
export function buildNodeLocalModelEndpointService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  clock: Clock,
  // The symmetric local-sqlite credential seam (mothership mode); else Drizzle over `db`.
  repositoryOverride?: LocalModelEndpointRepository,
): LocalModelEndpointService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  const localModelEndpointRepository =
    repositoryOverride ?? (db ? new DrizzleLocalModelEndpointRepository(db) : undefined)
  if (!localModelEndpointRepository) return undefined
  return new LocalModelEndpointService({
    localModelEndpointRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:local-model-endpoints',
    }),
    clock,
  })
}

/**
 * Build the per-USER generic secret service (a GitHub PAT today), or undefined when the
 * shared ENCRYPTION_KEY is absent. Single system-cipher (no password layer); also backs
 * `ResolveUserGitHubToken`. Mirror of the Worker's `buildUserSecretService`.
 */
export function buildNodeUserSecretService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  clock: Clock,
  userSecretKindRegistry: UserSecretKindRegistry,
): UserSecretService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  // No Postgres (mothership mode): the per-user secret store is not yet a local-sqlite
  // bucket (PR 3), so it is off.
  if (!masterKeyBase64 || !db) return undefined
  return new UserSecretService({
    userSecretRepository: new DrizzleUserSecretRepository(db),
    secretCipher: new WebCryptoSecretCipher({ masterKeyBase64, info: 'cat-factory:user-secret' }),
    clock,
    userSecretKindRegistry,
  })
}

/**
 * The per-WORKSPACE OpenRouter dynamic-catalog service, or undefined when the API-key pool
 * isn't wired (no ENCRYPTION_KEY) — refresh leases the workspace's pooled OpenRouter key.
 * Mirror of the Worker's `buildOpenRouterCatalogService`.
 */
export function buildNodeOpenRouterCatalogService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  clock: Clock,
  apiKeys: ApiKeyService | undefined,
  spendCurrency: string,
): OpenRouterCatalogService | undefined {
  // The dynamic-catalog projection is Postgres-only for now (PR 3), so it is off without a db
  // even though the API-key pool (which it leases through) may be local-sqlite-backed.
  if (!apiKeys || !db) return undefined
  return new OpenRouterCatalogService({
    providerModelCatalogRepository: new DrizzleProviderModelCatalogRepository(db),
    apiKeys,
    clock,
    baseUrl: baseUrlForNode('openrouter', env),
    // OpenRouter quotes USD; convert to the deployment's spend currency so persisted prices
    // (and the spend overlay) match the rest of the budget table.
    usdToCurrencyRate: usdRateForSpendCurrency(spendCurrency),
  })
}

export function buildNodePersonalSubscriptionService(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
  idGenerator: CoreDependencies['idGenerator'],
  clock: Clock,
  // Mothership mode injects the local `node:sqlite` credential store for BOTH repos (they stay on
  // the laptop — the double-encrypted personal credential + its per-run activation are leased +
  // decrypted by the LOCAL container executor). Both must come from the same store, so both are
  // overridden together; else the Drizzle repos over `db`, and the service is off without either.
  personalOverride?: PersonalSubscriptionRepository,
  activationOverride?: SubscriptionActivationRepository,
): PersonalSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  const personalSubscriptionRepository =
    personalOverride ?? (db ? new DrizzlePersonalSubscriptionRepository(db) : undefined)
  const subscriptionActivationRepository =
    activationOverride ?? (db ? new DrizzleSubscriptionActivationRepository(db) : undefined)
  if (!personalSubscriptionRepository || !subscriptionActivationRepository) return undefined
  return new PersonalSubscriptionService({
    personalSubscriptionRepository,
    subscriptionActivationRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:personal-subscriptions',
    }),
    personalCipher: new WebCryptoPersonalSecretCipher(),
    idGenerator,
    clock,
  })
}
