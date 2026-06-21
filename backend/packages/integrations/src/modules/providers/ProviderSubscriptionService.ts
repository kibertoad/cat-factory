import type {
  Clock,
  IdGenerator,
  ProviderSubscriptionTokenRecord,
  ProviderSubscriptionTokenRepository,
  SecretCipher,
  SubscriptionVendor,
} from '@cat-factory/kernel'
import { ConflictError } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import { SUBSCRIPTION_VENDORS } from '@cat-factory/kernel'
import type { WorkspaceRepository } from '@cat-factory/kernel'
import { DEFAULT_USAGE_WINDOW_MS, chooseToken } from './providers.logic.js'

// Every vendor whose subscription harness we support — the single source of truth
// is the SUBSCRIPTION_VENDORS map in the kernel, so adding a vendor there (e.g.
// DeepSeek) automatically widens the unfiltered `listTokens` sweep below. A
// hardcoded subset here silently hides newly-supported vendors' pooled tokens.
const ALL_VENDORS = Object.keys(SUBSCRIPTION_VENDORS) as SubscriptionVendor[]

// Upper bound on live tokens per workspace+vendor. The rotation pool is meant to hold
// a handful of subscriptions for quota headroom; a generous ceiling keeps the feature
// usable while bounding accidental/abusive unbounded growth (every lease lists the
// whole live pool, so an unbounded pool would also bloat that read).
const MAX_TOKENS_PER_VENDOR = 25

// ProviderSubscriptionService: owns a workspace's pool of subscription
// credentials per vendor. Tokens are stored *encrypted* (the raw secret is the
// CLAUDE_CODE_OAUTH_TOKEN string for `claude` or the full auth.json blob for
// `codex`); only metadata + rolling-window usage is exposed back to clients.
// Leasing is usage-aware (see providers.logic): least-loaded token wins, with
// round-robin by lastUsedAt as the tiebreaker. Mirrors RunnerPoolConnectionService.

export interface ProviderSubscriptionServiceDependencies {
  providerSubscriptionTokenRepository: ProviderSubscriptionTokenRepository
  workspaceRepository: WorkspaceRepository
  secretCipher: SecretCipher
  idGenerator: IdGenerator
  clock: Clock
  /** Rolling usage window for rotation; defaults to ~5h. */
  usageWindowMs?: number
}

/** Safe metadata for one pool token (never the secret). */
export interface VendorCredentialSummary {
  id: string
  vendor: SubscriptionVendor
  label: string
  createdAt: number
  lastUsedAt: number | null
  inputTokens: number
  outputTokens: number
  requestCount: number
}

/** A leased credential: the decrypted secret plus the row id (for usage attribution). */
export interface LeasedSubscriptionToken {
  tokenId: string
  vendor: SubscriptionVendor
  secret: string
}

export class ProviderSubscriptionService {
  constructor(private readonly deps: ProviderSubscriptionServiceDependencies) {}

  private get windowMs(): number {
    return this.deps.usageWindowMs ?? DEFAULT_USAGE_WINDOW_MS
  }

  /** Add a token to the workspace's pool for a vendor. */
  async addToken(
    workspaceId: string,
    input: { vendor: SubscriptionVendor; label: string; token: string },
  ): Promise<VendorCredentialSummary> {
    await requireWorkspace(this.deps.workspaceRepository, workspaceId)
    const existing = await this.deps.providerSubscriptionTokenRepository.listByVendor(
      workspaceId,
      input.vendor,
    )
    if (existing.length >= MAX_TOKENS_PER_VENDOR) {
      throw new ConflictError(
        `Workspace '${workspaceId}' already has the maximum of ${MAX_TOKENS_PER_VENDOR} ` +
          `${input.vendor} subscription tokens; remove one before adding another`,
      )
    }
    const tokenCipher = await this.deps.secretCipher.encrypt(input.token)
    const now = this.deps.clock.now()
    const record: ProviderSubscriptionTokenRecord = {
      id: this.deps.idGenerator.next('sub'),
      workspaceId,
      vendor: input.vendor,
      label: input.label,
      tokenCipher,
      createdAt: now,
      lastUsedAt: null,
      windowStartedAt: null,
      inputTokens: 0,
      outputTokens: 0,
      requestCount: 0,
      deletedAt: null,
    }
    await this.deps.providerSubscriptionTokenRepository.add(record)
    return toSummary(record)
  }

  /** All live tokens for a workspace (optionally filtered by vendor), metadata only. */
  async listTokens(
    workspaceId: string,
    vendor?: SubscriptionVendor,
  ): Promise<VendorCredentialSummary[]> {
    const vendors: SubscriptionVendor[] = vendor ? [vendor] : ALL_VENDORS
    const out: VendorCredentialSummary[] = []
    for (const v of vendors) {
      const rows = await this.deps.providerSubscriptionTokenRepository.listByVendor(workspaceId, v)
      for (const row of rows) out.push(toSummary(row))
    }
    return out
  }

  /** Whether the workspace has at least one live token for a vendor. */
  async hasToken(workspaceId: string, vendor: SubscriptionVendor): Promise<boolean> {
    const rows = await this.deps.providerSubscriptionTokenRepository.listByVendor(
      workspaceId,
      vendor,
    )
    return rows.length > 0
  }

  /** Remove a token from the pool. */
  async removeToken(workspaceId: string, id: string): Promise<void> {
    await this.deps.providerSubscriptionTokenRepository.softDelete(
      workspaceId,
      id,
      this.deps.clock.now(),
    )
  }

  /**
   * Lease the least-loaded live token for a vendor and return its decrypted
   * secret. Throws ConflictError when the pool is empty so the dispatch path can
   * surface a clear "connect a token" error rather than dispatching a doomed job.
   *
   * Rotation is best-effort, not transactional: the read → choose → markLeased
   * sequence is not atomic, so two leases that interleave between the read and the
   * mark can pick the same token. That window is benign (worst case one extra job on
   * a token) and self-correcting — markLeased stamps `lastUsedAt` synchronously
   * BEFORE this returns, so the next lease in a burst sees the just-leased token as
   * least-recently-used and rotates to a different one even though real usage (folded
   * in only when the job finishes, minutes later) is still zero across the pool.
   */
  async leaseToken(
    workspaceId: string,
    vendor: SubscriptionVendor,
  ): Promise<LeasedSubscriptionToken> {
    const rows = await this.deps.providerSubscriptionTokenRepository.listByVendor(
      workspaceId,
      vendor,
    )
    const chosen = chooseToken(rows, this.deps.clock.now(), this.windowMs)
    if (!chosen) {
      throw new ConflictError(
        `Workspace '${workspaceId}' has no ${vendor} subscription token connected`,
      )
    }
    await this.deps.providerSubscriptionTokenRepository.markLeased(
      workspaceId,
      chosen.id,
      this.deps.clock.now(),
    )
    const secret = await this.deps.secretCipher.decrypt(chosen.tokenCipher)
    return { tokenId: chosen.id, vendor, secret }
  }

  /** Fold a completed job's usage into the leased token's rolling-window counters. */
  async recordTokenUsage(
    workspaceId: string,
    id: string,
    usage: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    await this.deps.providerSubscriptionTokenRepository.recordUsage(
      workspaceId,
      id,
      usage,
      this.deps.clock.now(),
      this.windowMs,
    )
  }
}

function toSummary(record: ProviderSubscriptionTokenRecord): VendorCredentialSummary {
  return {
    id: record.id,
    vendor: record.vendor,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    requestCount: record.requestCount,
  }
}
