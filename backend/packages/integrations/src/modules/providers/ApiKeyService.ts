import type {
  ApiKeyProvider,
  ApiKeyScope,
  ApiKeyScopeRef,
  Clock,
  IdGenerator,
  ProviderApiKeyRecord,
  ProviderApiKeyRepository,
  SecretCipher,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import { DEFAULT_USAGE_WINDOW_MS } from './providers.logic.js'

// ApiKeyService: owns the direct-provider API-key pool (OpenAI/Anthropic/Qwen/
// DeepSeek/Moonshot). Keys are onboarded via the UI and stored *encrypted* (a
// SecretCipher envelope — never plaintext), replacing the old deployment-env
// onboarding. A key lives at one of three SCOPES — account, workspace, or user.
//
// When a run in a workspace needs a provider key, the candidate pool is the UNION
// of the workspace's keys, its owning account's keys, and the run initiator's own
// user keys; leasing is usage-aware (least-loaded wins, see providers.logic).
// Mirrors ProviderSubscriptionService, with a scope dimension instead of a vendor.

// Upper bound on live keys per (scope, scopeId, provider). The rotation pool is
// meant to hold a handful of keys for quota headroom; a generous ceiling keeps the
// feature usable while bounding accidental/abusive unbounded growth.
const MAX_KEYS_PER_PROVIDER = 25

export interface ApiKeyServiceDependencies {
  providerApiKeyRepository: ProviderApiKeyRepository
  workspaceRepository: WorkspaceRepository
  secretCipher: SecretCipher
  idGenerator: IdGenerator
  clock: Clock
  /** Rolling usage window for rotation; defaults to ~5h. */
  usageWindowMs?: number
}

/** Safe metadata for one pool key (never the secret). */
export interface ApiKeySummary {
  id: string
  scope: ApiKeyScope
  scopeId: string
  provider: ApiKeyProvider
  label: string
  createdAt: number
  lastUsedAt: number | null
  inputTokens: number
  outputTokens: number
  requestCount: number
}

/** A leased key: the decrypted secret plus the row id (for usage attribution). */
export interface LeasedApiKey {
  keyId: string
  provider: ApiKeyProvider
  secret: string
}

/** The extra scope segments to merge into a workspace's pool for a run. */
export interface PoolScopeOpts {
  /** The workspace's owning account id (resolved automatically when omitted). */
  accountId?: string | null
  /** The run initiator's `usr_*` id, to also draw from their personal keys. */
  userId?: string | null
}

export class ApiKeyService {
  constructor(private readonly deps: ApiKeyServiceDependencies) {}

  private get windowMs(): number {
    return this.deps.usageWindowMs ?? DEFAULT_USAGE_WINDOW_MS
  }

  /** Add a key to a scope's pool. */
  async addKey(
    scope: ApiKeyScope,
    scopeId: string,
    input: { provider: ApiKeyProvider; label: string; key: string },
  ): Promise<ApiKeySummary> {
    const existing = await this.deps.providerApiKeyRepository.listByScope(
      scope,
      scopeId,
      input.provider,
    )
    if (existing.length >= MAX_KEYS_PER_PROVIDER) {
      throw new ConflictError(
        `This ${scope} already has the maximum of ${MAX_KEYS_PER_PROVIDER} ` +
          `${input.provider} API keys; remove one before adding another`,
      )
    }
    const keyCipher = await this.deps.secretCipher.encrypt(input.key)
    const now = this.deps.clock.now()
    const record: ProviderApiKeyRecord = {
      id: this.deps.idGenerator.next('apikey'),
      scope,
      scopeId,
      provider: input.provider,
      label: input.label,
      keyCipher,
      createdAt: now,
      lastUsedAt: null,
      windowStartedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      deletedAt: null,
    }
    await this.deps.providerApiKeyRepository.add(record)
    return toSummary(record)
  }

  /** All live keys for a scope (optionally filtered by provider), metadata only. */
  async listKeys(
    scope: ApiKeyScope,
    scopeId: string,
    provider?: ApiKeyProvider,
  ): Promise<ApiKeySummary[]> {
    const rows = await this.deps.providerApiKeyRepository.listByScope(scope, scopeId, provider)
    return rows.map(toSummary)
  }

  /** Remove a key from its scope's pool. */
  async removeKey(scope: ApiKeyScope, scopeId: string, id: string): Promise<void> {
    await this.deps.providerApiKeyRepository.softDelete(scope, scopeId, id, this.deps.clock.now())
  }

  /**
   * The merged candidate scope segments for a run: the workspace, its owning
   * account (resolved when not supplied), and the initiator's user, in that order.
   */
  private async poolScopes(workspaceId: string, opts?: PoolScopeOpts): Promise<ApiKeyScopeRef[]> {
    const scopes: ApiKeyScopeRef[] = [{ scope: 'workspace', scopeId: workspaceId }]
    const accountId =
      opts?.accountId === undefined
        ? await this.deps.workspaceRepository.accountOf(workspaceId)
        : opts.accountId
    if (accountId) scopes.push({ scope: 'account', scopeId: accountId })
    if (opts?.userId) scopes.push({ scope: 'user', scopeId: opts.userId })
    return scopes
  }

  /** Whether the merged pool has at least one live key for a provider. */
  async hasKey(
    workspaceId: string,
    provider: ApiKeyProvider,
    opts?: PoolScopeOpts,
  ): Promise<boolean> {
    const scopes = await this.poolScopes(workspaceId, opts)
    const rows = await this.deps.providerApiKeyRepository.listForPool(scopes, provider)
    return rows.length > 0
  }

  /** Distinct providers with at least one live key across the merged pool. */
  async configuredProviders(workspaceId: string, opts?: PoolScopeOpts): Promise<ApiKeyProvider[]> {
    const scopes = await this.poolScopes(workspaceId, opts)
    return this.deps.providerApiKeyRepository.listConfiguredProviders(scopes)
  }

  /**
   * Lease the least-loaded live key for a provider across the merged pool and
   * return its decrypted secret. Throws ConflictError when the pool is empty so the
   * caller can surface a clear "add an API key" error rather than failing deep in
   * the SDK. Rotation is best-effort, not transactional (see ProviderSubscriptionService).
   */
  async lease(
    workspaceId: string,
    provider: ApiKeyProvider,
    opts?: PoolScopeOpts,
  ): Promise<LeasedApiKey> {
    const scopes = await this.poolScopes(workspaceId, opts)
    // Atomic select-and-mark: the repo picks the least-loaded key AND stamps it leased in a
    // single transaction (the previous read→chooseToken→markLeased was non-transactional, so
    // two concurrent dispatches could both grab the same key before either recorded usage).
    const chosen = await this.deps.providerApiKeyRepository.leaseLeastUsed(
      scopes,
      provider,
      this.deps.clock.now(),
      this.windowMs,
    )
    if (!chosen) {
      throw new ConflictError(
        `No ${provider} API key is configured for this workspace, its account, or your user`,
      )
    }
    let secret: string
    try {
      secret = await this.deps.secretCipher.decrypt(chosen.keyCipher)
    } catch (e) {
      // Name the credential that failed to decrypt so the failure (e.g. an inline reviewer
      // that leases keys before any LLM call) points at the offending provider key rather
      // than surfacing the cipher's opaque error with no context. The cipher already
      // explains the likely encryption-key mismatch; prepend which key it was.
      throw new Error(
        `Could not decrypt the leased '${provider}' API key '${chosen.id}': ${
          e instanceof Error ? e.message : String(e)
        }`,
        { cause: e },
      )
    }
    return { keyId: chosen.id, provider, secret }
  }

  /** Fold a completed call's usage into the leased key's rolling-window counters. */
  async recordUsage(
    keyId: string,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    await this.deps.providerApiKeyRepository.recordUsage(
      keyId,
      usage,
      this.deps.clock.now(),
      this.windowMs,
    )
  }
}

function toSummary(record: ProviderApiKeyRecord): ApiKeySummary {
  return {
    id: record.id,
    scope: record.scope,
    scopeId: record.scopeId,
    provider: record.provider,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    requestCount: record.requestCount,
  }
}
