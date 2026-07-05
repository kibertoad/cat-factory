import type { BudgetCaps, OpenRouterModelMeta, SpendStatus } from '@cat-factory/contracts'
import type { AgentTokenUsage } from '@cat-factory/kernel'
import type { ModelRef } from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type {
  AccountRepository,
  TokenUsageRepository,
  UserSettingsRepository,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import {
  type SpendPricing,
  effectiveTierLimit,
  estimateCost,
  mergeSpendPricing,
  startOfMonthUtc,
  withDynamicPrices,
} from './pricing.js'

export interface SpendServiceDependencies {
  tokenUsageRepository: TokenUsageRepository
  idGenerator: IdGenerator
  clock: Clock
  /** The base (built-in) pricing table + the deployment fallback budget/currency + env caps. */
  pricing: SpendPricing
  /**
   * Per-workspace budget overrides (currency / monthly limit / per-model prices),
   * persisted on the workspace settings row. When wired, {@link SpendService}
   * resolves each workspace's effective pricing by overlaying its overrides onto the
   * base table; absent ⇒ every workspace uses the base table (tests/conformance).
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
  /**
   * Account tenancy repository, read for the ACCOUNT budget tier (an account's
   * configured `spendMonthlyLimit`). Absent ⇒ the account tier is inert unless the
   * operator env cap alone activates it.
   */
  accountRepository?: AccountRepository
  /**
   * Per-user settings repository, read for the USER budget tier (a user's configured
   * `spendMonthlyLimit`). Absent ⇒ the user tier is inert unless the operator env cap
   * alone activates it.
   */
  userSettingsRepository?: UserSettingsRepository
  /**
   * Optional resolver for a workspace's dynamic gateway model prices (the enabled
   * OpenRouter catalog). When wired, a metered `openrouter:<slug>` call is priced at the
   * model's real per-1M rate (overlaid onto the base table) instead of the bare-`openrouter`
   * fallback — so budgets meter dynamic models as accurately as the curated ones. Absent →
   * the static table is used (the fallback price applies to uncatalogued slugs).
   */
  dynamicPricesFor?: (workspaceId: string) => Promise<OpenRouterModelMeta[]>
}

/** Details of a single metered LLM call, handed in by the execution engine. */
export interface RecordUsageInput {
  workspaceId: string
  /** The owning account of `workspaceId` (denormalized for the account rollup). */
  accountId?: string | null
  /** The user who initiated the run (denormalized for the user rollup). */
  userId?: string | null
  executionId: string | null
  agentKind: string
  /** Model identifier as `provider:model` (as produced by AgentRunResult.model). */
  model: string
  usage: AgentTokenUsage
}

/** Which budget tiers to check when gating a run (the caller passes what ids it has). */
export interface BudgetTierScope {
  accountId?: string | null
  userId?: string | null
}

/** How long a workspace's resolved pricing is cached before reloading (ms). */
const PRICING_CACHE_TTL_MS = 30_000

/**
 * The spend safeguard. It meters token usage into a persistent ledger, prices
 * each call into a single currency, and reports the current billing period's
 * spend against the workspace's budget. The execution engine consults
 * {@link isOverBudget} before every agent step and pauses when the budget is
 * exhausted; the worker surfaces {@link status} so the frontend can warn.
 *
 * Budgets are tiered — workspace, account, and user. The workspace tier overlays the
 * workspace's currency/monthly-limit overrides onto the built-in base table; the account
 * and user tiers compare their own rollup against a configured limit clamped by the
 * operator env cap. A run is over budget when ANY applicable tier is exhausted.
 * Resolutions are cached briefly so the hot {@link isOverBudget} gate doesn't re-read
 * settings per step.
 */
export class SpendService {
  private readonly tokenUsageRepository: TokenUsageRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly pricing: SpendPricing
  private readonly workspaceSettingsRepository?: WorkspaceSettingsRepository
  private readonly accountRepository?: AccountRepository
  private readonly userSettingsRepository?: UserSettingsRepository
  private readonly dynamicPricesFor?: (workspaceId: string) => Promise<OpenRouterModelMeta[]>
  private readonly pricingCache = new Map<string, { value: SpendPricing; expiresAt: number }>()
  private readonly accountLimitCache = new Map<
    string,
    { value: number | null; expiresAt: number }
  >()
  private readonly userLimitCache = new Map<string, { value: number | null; expiresAt: number }>()

  constructor({
    tokenUsageRepository,
    idGenerator,
    clock,
    pricing,
    workspaceSettingsRepository,
    accountRepository,
    userSettingsRepository,
    dynamicPricesFor,
  }: SpendServiceDependencies) {
    this.tokenUsageRepository = tokenUsageRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.pricing = pricing
    this.workspaceSettingsRepository = workspaceSettingsRepository
    this.accountRepository = accountRepository
    this.userSettingsRepository = userSettingsRepository
    this.dynamicPricesFor = dynamicPricesFor
  }

  /** Parse a `provider:model` identifier into a {@link ModelRef}. */
  private parseModel(model: string): ModelRef {
    const idx = model.indexOf(':')
    if (idx === -1) return { provider: model, model: '' }
    return { provider: model.slice(0, idx), model: model.slice(idx + 1) }
  }

  /**
   * The workspace's effective pricing (base table overlaid with its budget overrides),
   * cached for {@link PRICING_CACHE_TTL_MS}. Falls back to the base table when no
   * settings repository is wired.
   */
  private async resolvePricing(workspaceId: string): Promise<SpendPricing> {
    if (!this.workspaceSettingsRepository) return this.pricing
    const cached = this.pricingCache.get(workspaceId)
    const now = this.clock.now()
    if (cached && cached.expiresAt > now) return cached.value
    const settings = await this.workspaceSettingsRepository.get(workspaceId)
    const value = mergeSpendPricing(this.pricing, settings)
    this.pricingCache.set(workspaceId, { value, expiresAt: now + PRICING_CACHE_TTL_MS })
    return value
  }

  /** Invalidate a workspace's cached pricing (called after a budget edit). */
  invalidatePricing(workspaceId: string): void {
    this.pricingCache.delete(workspaceId)
  }

  /** Invalidate a cached account effective limit (called after an account-budget edit). */
  invalidateAccountLimit(accountId: string): void {
    this.accountLimitCache.delete(accountId)
  }

  /** Invalidate a cached user effective limit (called after a user-budget edit). */
  invalidateUserLimit(userId: string): void {
    this.userLimitCache.delete(userId)
  }

  /**
   * The account tier's effective monthly limit: the configured account limit clamped by
   * the operator env cap. `Infinity` when the tier is inactive (neither set). Cached for
   * {@link PRICING_CACHE_TTL_MS}.
   */
  private async resolveAccountLimit(accountId: string): Promise<number> {
    const cap = this.pricing.accountMonthlyLimitCap
    if (!this.accountRepository) return effectiveTierLimit(null, cap)
    const now = this.clock.now()
    const cached = this.accountLimitCache.get(accountId)
    let configured: number | null
    if (cached && cached.expiresAt > now) {
      configured = cached.value
    } else {
      const account = await this.accountRepository.get(accountId)
      configured = account?.spendMonthlyLimit ?? null
      this.accountLimitCache.set(accountId, {
        value: configured,
        expiresAt: now + PRICING_CACHE_TTL_MS,
      })
    }
    return effectiveTierLimit(configured, cap)
  }

  /** The user tier's effective monthly limit (configured user limit clamped by the env cap). */
  private async resolveUserLimit(userId: string): Promise<number> {
    const cap = this.pricing.userMonthlyLimitCap
    if (!this.userSettingsRepository) return effectiveTierLimit(null, cap)
    const now = this.clock.now()
    const cached = this.userLimitCache.get(userId)
    let configured: number | null
    if (cached && cached.expiresAt > now) {
      configured = cached.value
    } else {
      const settings = await this.userSettingsRepository.get(userId)
      configured = settings?.spendMonthlyLimit ?? null
      this.userLimitCache.set(userId, { value: configured, expiresAt: now + PRICING_CACHE_TTL_MS })
    }
    return effectiveTierLimit(configured, cap)
  }

  /** Meter and persist one LLM call; returns its estimated cost. */
  async record(input: RecordUsageInput): Promise<number> {
    const ref = this.parseModel(input.model)
    const base = await this.resolvePricing(input.workspaceId)
    // Price a dynamic OpenRouter gateway model at its real per-model rate (overlaid onto
    // the resolved table) rather than the bare-`openrouter` fallback, when the resolver is wired.
    const pricing =
      ref.provider === 'openrouter' && this.dynamicPricesFor
        ? withDynamicPrices(base, await this.dynamicPricesFor(input.workspaceId))
        : base
    const costEstimate = estimateCost(pricing, ref, input.usage)
    await this.tokenUsageRepository.record({
      id: this.idGenerator.next('tok'),
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      userId: input.userId ?? null,
      executionId: input.executionId,
      agentKind: input.agentKind,
      provider: ref.provider,
      model: ref.model,
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      costEstimate,
      createdAt: this.clock.now(),
    })
    return costEstimate
  }

  /** The current billing period's spend against the WORKSPACE budget. */
  async status(workspaceId: string): Promise<SpendStatus> {
    const pricing = await this.resolvePricing(workspaceId)
    const periodStart = startOfMonthUtc(this.clock.now())
    const totals = await this.tokenUsageRepository.totalsSinceForWorkspace(workspaceId, periodStart)
    return {
      periodStart,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costSpent: totals.costEstimate,
      costLimit: pricing.monthlyLimit,
      currency: pricing.currency,
      exceeded: totals.costEstimate >= pricing.monthlyLimit,
    }
  }

  /**
   * The ACCOUNT tier's status, or null when the tier is inactive (no configured limit
   * and no operator cap). `costLimit` is the effective limit (configured clamped by the
   * env cap); costs are in the base pricing currency.
   */
  async accountStatus(accountId: string): Promise<SpendStatus | null> {
    const limit = await this.resolveAccountLimit(accountId)
    if (!Number.isFinite(limit)) return null
    const periodStart = startOfMonthUtc(this.clock.now())
    const totals = await this.tokenUsageRepository.totalsSinceForAccount(accountId, periodStart)
    return {
      periodStart,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costSpent: totals.costEstimate,
      costLimit: limit,
      currency: this.pricing.currency,
      exceeded: totals.costEstimate >= limit,
    }
  }

  /**
   * The USER tier's status, or null when the tier is inactive (no limit and no cap).
   * `preloaded` lets a caller that already holds the user's settings (e.g. the snapshot
   * assembly, which reads the same row for the editable `userSettings` field) pass the
   * configured limit in, so this doesn't re-read the `user_settings` row.
   */
  async userStatus(
    userId: string,
    preloaded?: { configuredLimit: number | null },
  ): Promise<SpendStatus | null> {
    const limit = preloaded
      ? effectiveTierLimit(preloaded.configuredLimit, this.pricing.userMonthlyLimitCap)
      : await this.resolveUserLimit(userId)
    if (!Number.isFinite(limit)) return null
    const periodStart = startOfMonthUtc(this.clock.now())
    const totals = await this.tokenUsageRepository.totalsSinceForUser(userId, periodStart)
    return {
      periodStart,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costSpent: totals.costEstimate,
      costLimit: limit,
      currency: this.pricing.currency,
      exceeded: totals.costEstimate >= limit,
    }
  }

  /** The operator hard ceilings on the account/user tiers, for the SPA budget screens. */
  budgetCaps(): BudgetCaps {
    return {
      accountMonthlyLimitMax: this.pricing.accountMonthlyLimitCap ?? null,
      userMonthlyLimitMax: this.pricing.userMonthlyLimitCap ?? null,
      currency: this.pricing.currency,
    }
  }

  /**
   * Whether this period's spend has reached ANY applicable budget tier (runs should
   * pause). Always checks the workspace tier; also checks the account/user tiers when
   * the caller supplies those ids (they resolve to inactive tiers cheaply otherwise).
   */
  async isOverBudget(workspaceId: string, scope: BudgetTierScope = {}): Promise<boolean> {
    const periodStart = startOfMonthUtc(this.clock.now())
    const pricing = await this.resolvePricing(workspaceId)
    const workspaceTotals = await this.tokenUsageRepository.totalsSinceForWorkspace(
      workspaceId,
      periodStart,
    )
    if (workspaceTotals.costEstimate >= pricing.monthlyLimit) return true
    if (scope.accountId) {
      const limit = await this.resolveAccountLimit(scope.accountId)
      if (Number.isFinite(limit)) {
        const totals = await this.tokenUsageRepository.totalsSinceForAccount(
          scope.accountId,
          periodStart,
        )
        if (totals.costEstimate >= limit) return true
      }
    }
    if (scope.userId) {
      const limit = await this.resolveUserLimit(scope.userId)
      if (Number.isFinite(limit)) {
        const totals = await this.tokenUsageRepository.totalsSinceForUser(scope.userId, periodStart)
        if (totals.costEstimate >= limit) return true
      }
    }
    return false
  }
}
