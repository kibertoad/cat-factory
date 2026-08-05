import type {
  Clock,
  GitHubRepo,
  GroupCacheHandle,
  ResolveUserGitHubToken,
} from '@cat-factory/kernel'
import {
  ApiKeyService,
  LocalModelEndpointService,
  OpenRouterCatalogService,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  PublicApiKeyService,
  TEST_SECRETS_CIPHER_INFO,
  TestSecretsService,
  CAPABILITY_CREDENTIALS_CIPHER_INFO,
  CapabilityCredentialsService,
  MCP_OAUTH_CIPHER_INFO,
  McpOAuthService,
  UserSecretService,
  ValidationConfigService,
  type UserSecretKindRegistry,
  usdRateForSpendCurrency,
} from '@cat-factory/integrations'
import { WebCryptoPersonalSecretCipher } from '@cat-factory/server'
import type { D1Database } from '@cloudflare/workers-types'
import type { Env } from './env'
import { baseUrlFor } from './ai/providerEndpoints'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1CapabilityCredentialRepository } from './repositories/D1CapabilityCredentialRepository'
import { D1McpOAuthGrantRepository } from './repositories/D1McpOAuthGrantRepository'
import { D1TestSecretsRepository } from './repositories/D1TestSecretsRepository'
import { D1ValidationConfigRepository } from './repositories/D1ValidationConfigRepository'
import { D1ProviderSubscriptionTokenRepository } from './repositories/D1ProviderSubscriptionTokenRepository'
import { D1ProviderApiKeyRepository } from './repositories/D1ProviderApiKeyRepository'
import { D1PublicApiKeyRepository } from './repositories/D1PublicApiKeyRepository'
import {
  D1PersonalSubscriptionRepository,
  D1SubscriptionActivationRepository,
} from './repositories/D1PersonalSubscriptionRepository'
import { D1LocalModelEndpointRepository } from './repositories/D1LocalModelEndpointRepository'
import { D1UserSecretRepository } from './repositories/D1UserSecretRepository'
import { D1ProviderModelCatalogRepository } from './repositories/D1ProviderModelCatalogRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { CryptoIdGenerator } from './runtime'

// The sealed per-scope credential / subscription / provider-key stores, each keyed on the
// shared ENCRYPTION_KEY (the cipher must exist to seal/unseal). Grouped out of
// `container.ts` as the first per-concern wiring helper of modularisation split #4; every
// builder is a pure move (identical signatures + bodies), re-imported at its original call
// site. Symmetric with the Node facade's `wireCredentialServices.ts`.

/**
 * Build the workspace subscription-token pool service (Claude Code / Codex
 * credentials), or undefined when the shared ENCRYPTION_KEY is absent. Tokens are
 * sealed under a subscriptions-scoped HKDF info of the shared master key.
 */
export function buildSubscriptionService(
  env: Env,
  db: D1Database,
  clock: Clock,
): ProviderSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new ProviderSubscriptionService({
    providerSubscriptionTokenRepository: new D1ProviderSubscriptionTokenRepository({ db }),
    workspaceRepository: new D1WorkspaceRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:provider-subscriptions',
    }),
    idGenerator: new CryptoIdGenerator(),
    clock,
  })
}

/**
 * Build the direct-provider API-key pool service (account/workspace/user-scoped),
 * or undefined when no ENCRYPTION_KEY is configured. Keys are sealed under an
 * api-keys-scoped HKDF info of the shared master key. Shared by the API-key
 * controller, the model-provider resolver, and the LLM proxy's key lease.
 */
export function buildApiKeyService(
  env: Env,
  db: D1Database,
  clock: Clock,
): ApiKeyService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new ApiKeyService({
    providerApiKeyRepository: new D1ProviderApiKeyRepository({ db }),
    workspaceRepository: new D1WorkspaceRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:provider-api-keys',
    }),
    idGenerator: new CryptoIdGenerator(),
    clock,
  })
}

/**
 * Build the INBOUND public-API key store (external callers → `/api/v1`), or undefined when no
 * ENCRYPTION_KEY is configured. The key uses ENCRYPTION_KEY as the HMAC pepper for its one-way
 * secret hash (not the SecretCipher — a public-API key is verified, never decrypted). Shared by
 * the key-management controller and the public API's in-controller authentication.
 */
export function buildPublicApiKeyService(
  env: Env,
  db: D1Database,
  clock: Clock,
): PublicApiKeyService | undefined {
  const pepper = env.ENCRYPTION_KEY?.trim()
  if (!pepper) return undefined
  return new PublicApiKeyService({
    repository: new D1PublicApiKeyRepository({ db }),
    pepper,
    idGenerator: new CryptoIdGenerator(),
    clock,
  })
}

/**
 * Build the per-USER individual-usage subscription service (Claude), or undefined when
 * no ENCRYPTION_KEY is configured. Uses the system SecretCipher (master key, scoped
 * info) for the outer layer and the password-derived PersonalSecretCipher for the inner
 * layer of the double-encrypted credential. Shared by the personal-subscription
 * controller and the container executor's personal lease.
 */
export function buildPersonalSubscriptionService(
  env: Env,
  db: D1Database,
  clock: Clock,
): PersonalSubscriptionService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new PersonalSubscriptionService({
    personalSubscriptionRepository: new D1PersonalSubscriptionRepository({ db }),
    subscriptionActivationRepository: new D1SubscriptionActivationRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:personal-subscriptions',
    }),
    personalCipher: new WebCryptoPersonalSecretCipher(),
    idGenerator: new CryptoIdGenerator(),
    clock,
  })
}

/**
 * The per-USER locally-run model endpoints store (Ollama / LM Studio / …), or undefined
 * when no ENCRYPTION_KEY is configured (the optional bearer key is sealed with the system
 * cipher). Shared by the local-runner controller, the per-user model catalog, and the LLM
 * proxy's base-URL/key resolution for a locally-run model.
 */
export function buildLocalModelEndpointService(
  env: Env,
  db: D1Database,
  clock: Clock,
): LocalModelEndpointService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new LocalModelEndpointService({
    localModelEndpointRepository: new D1LocalModelEndpointRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64,
      info: 'cat-factory:local-model-endpoints',
    }),
    clock,
    // Loopback-only unless the operator opts into LAN reach (SEC-3). RFC1918 is
    // unroutable from workerd anyway, so on this facade the flag mostly governs what
    // the write boundary accepts; kept symmetric with the Node facade regardless.
    allowPrivateLanHosts: env.LOCAL_MODELS_ALLOW_LAN?.trim() === 'true',
  })
}

/**
 * The per-USER generic secret store (a GitHub PAT today), or undefined when no
 * ENCRYPTION_KEY is configured. Single system-cipher; also backs `ResolveUserGitHubToken`.
 */
export function buildUserSecretService(
  env: Env,
  db: D1Database,
  clock: Clock,
  // The app-owned secret-kind registry. Optional: the resolve-only throwaway services (the
  // PAT resolver) never consult the kind registry, so they omit it (default); only the
  // container-wired service that serves describe/test needs the injected instance.
  userSecretKindRegistry?: UserSecretKindRegistry,
  // The per-user viewer-repos cache (`AppCaches.viewerRepos`). A `github_pat` write/removal drops
  // the user's cached PAT repo enumeration. Pass-through on the Worker's isolate-safe profile, so
  // this invalidation is a no-op there — wired for parity with Node, where it caches.
  viewerReposCache?: GroupCacheHandle<GitHubRepo[]>,
): UserSecretService | undefined {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64) return undefined
  return new UserSecretService({
    userSecretRepository: new D1UserSecretRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({ masterKeyBase64, info: 'cat-factory:user-secret' }),
    clock,
    ...(userSecretKindRegistry ? { userSecretKindRegistry } : {}),
    ...(viewerReposCache
      ? {
          onSecretChanged: (userId, kind) =>
            kind === 'github_pat' ? viewerReposCache.invalidateGroup(userId) : undefined,
        }
      : {}),
  })
}

/**
 * Resolve the run initiator's stored GitHub PAT (when set), or undefined when the secret
 * store isn't configured. Preferred over the App token by the container push-token mint +
 * the engine GitHub client (CI gate / merge), so runs are attributed to the initiator.
 */
export function buildResolveUserGitHubToken(
  env: Env,
  db: D1Database,
  clock: Clock,
): ResolveUserGitHubToken | undefined {
  const userSecrets = buildUserSecretService(env, db, clock)
  return userSecrets ? (userId) => userSecrets.resolve(userId, 'github_pat') : undefined
}

/**
 * The per-WORKSPACE OpenRouter dynamic-catalog service (browse/enable gateway models), or
 * undefined when the API-key pool isn't wired (no ENCRYPTION_KEY) — refresh leases the
 * workspace's pooled OpenRouter key. Shared by the catalog controller, the per-workspace
 * model catalog, and the spend price overlay.
 */
export function buildOpenRouterCatalogService(
  env: Env,
  db: D1Database,
  clock: Clock,
  apiKeys: ApiKeyService | undefined,
  spendCurrency: string,
): OpenRouterCatalogService | undefined {
  if (!apiKeys) return undefined
  return new OpenRouterCatalogService({
    providerModelCatalogRepository: new D1ProviderModelCatalogRepository({ db }),
    apiKeys,
    clock,
    baseUrl: baseUrlFor('openrouter', env) ?? undefined,
    // OpenRouter quotes USD; convert to the deployment's spend currency so persisted prices
    // (and the spend overlay) match the rest of the budget table.
    usdToCurrencyRate: usdRateForSpendCurrency(spendCurrency),
  })
}
/**
 * Build the SENSITIVE per-service test-credential store (sealed), or undefined when the shared
 * encryption key is absent (the cipher must exist to seal/unseal). Backs the test-secrets CRUD
 * controller, the engine's prompt refs (non-secret key + description), and the executor's
 * out-of-band value injection into the Tester container. Stateless, so building a fresh instance
 * per call site is safe (mirrors `buildResolvePackageRegistries`).
 */
export function buildTestSecretsService(
  env: Env,
  db: D1Database,
  clock: Clock,
): TestSecretsService | undefined {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return undefined
  return new TestSecretsService({
    testSecretsRepository: new D1TestSecretsRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: TEST_SECRETS_CIPHER_INFO,
    }),
    blockRepository: new D1BlockRepository({ db }),
    clock,
  })
}

/**
 * Build the PER-WORKSPACE CAPABILITY-CREDENTIAL store (sealed), or undefined when the shared
 * encryption key is absent. Backs the credential CRUD controller AND the dispatch-time resolver
 * the executor composes in FRONT of the deployment-environment one — a tenant's own value must
 * win over a variable the whole deployment shares.
 *
 * Stateless, so building a fresh instance per call site is safe (mirrors the two above); the
 * executor and the controller each build their own.
 */
export function buildCapabilityCredentialsService(
  env: Env,
  db: D1Database,
  clock: Clock,
): CapabilityCredentialsService | undefined {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return undefined
  return new CapabilityCredentialsService({
    capabilityCredentialRepository: new D1CapabilityCredentialRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: CAPABILITY_CREDENTIALS_CIPHER_INFO,
    }),
    clock,
  })
}

/**
 * Build the PER-WORKSPACE MCP OAUTH GRANT store (sealed), or undefined when the shared encryption
 * key is absent. Backs the tool-server connect/disconnect routes, the inventory's connection
 * state, AND the dispatch-time token source the executor mints an `Authorization` header from.
 *
 * Absent is a real deployment shape rather than a broken one: a Worker with no ENCRYPTION_KEY has
 * nowhere to keep a grant, so every OAuth-declaring server is stated to its agent as
 * `oauth_not_connected` instead of dispatched without a token. Stateless, so building a fresh
 * instance per call site is safe (mirrors the sealed stores above).
 */
export function buildMcpOAuthService(
  env: Env,
  db: D1Database,
  clock: Clock,
): McpOAuthService | undefined {
  const encryptionKey = env.ENCRYPTION_KEY?.trim()
  if (!encryptionKey) return undefined
  return new McpOAuthService({
    mcpOAuthGrantRepository: new D1McpOAuthGrantRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: encryptionKey,
      info: MCP_OAUTH_CIPHER_INFO,
    }),
    clock,
  })
}

/**
 * Build the per-service PRE-PR VALIDATION CHECK store — the commands the executor-harness runs
 * against the checkout before opening a PR. Backs the validation-check CRUD controller and the
 * engine's dispatch resolution (the commands ride the coding job body). Unlike the sealed stores
 * beside it this needs no encryption key: the commands are operator-authored shell strings that
 * run inside the run's own container, so there is nothing to seal and it is always wired.
 * Stateless, so building a fresh instance per call site is safe.
 */
export function buildValidationConfigService(
  db: D1Database,
  clock: Clock,
): ValidationConfigService {
  return new ValidationConfigService({
    validationConfigRepository: new D1ValidationConfigRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    clock,
  })
}
