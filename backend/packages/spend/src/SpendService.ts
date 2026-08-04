import type { BudgetCaps, OpenRouterModelMeta, SpendStatus } from '@cat-factory/contracts'
import type { AgentTokenUsage } from '@cat-factory/kernel'
import type { ModelRef } from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type {
  AccountRepository,
  BudgetLimitCacheValue,
  GroupCacheHandle,
  ScopedSpendWindow,
  TokenUsageRepository,
  UsageBilling,
  UsageBreakdownRow,
  UserSettingsRepository,
  WorkspaceSettingsCacheValue,
  WorkspaceSettingsRepository,
} from '@cat-factory/kernel'
import { readCachedWorkspaceSettings } from '@cat-factory/kernel'
import {
  BURN_RATE_WINDOW_MS,
  type SpendAlertState,
  type SpendForecast,
  forecastSpend,
  spendAlertState,
} from './forecast.logic.js'
import {
  type InputTokenClassUsage,
  type SpendPricing,
  effectiveTierLimit,
  estimateClassedCost,
  estimateCost,
  mergeSpendPricing,
  startOfMonthUtc,
  startOfNextMonthUtc,
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
  /**
   * The shared {@link AppCaches.workspaceSettings} slice, through which the hot
   * {@link SpendService.resolvePricing} read resolves a workspace's budget overrides —
   * folding what used to be a per-service homebrew TTL `Map` into the app cache seam, so a
   * budget edit invalidates coherently across replicas (the `Map` served stale peers for
   * its TTL). Absent ⇒ the settings row is read live per call (standalone tests).
   */
  workspaceSettingsCache?: GroupCacheHandle<WorkspaceSettingsCacheValue>
  /** The shared {@link AppCaches.accountBudgetLimit} slice (see `workspaceSettingsCache`). */
  accountBudgetLimitCache?: GroupCacheHandle<BudgetLimitCacheValue>
  /** The shared {@link AppCaches.userBudgetLimit} slice (see `workspaceSettingsCache`). */
  userBudgetLimitCache?: GroupCacheHandle<BudgetLimitCacheValue>
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
  /**
   * The call's token counts, with `inputTokens` the TOTAL input across every billed class.
   * It stays the volume figure the ledger stores and the rollups report; {@link
   * RecordUsageInput.inputClasses} is what PRICES it when the producer knows the split.
   */
  usage: AgentTokenUsage
  /**
   * The three orthogonal input classes behind `usage.inputTokens`, from a producer that can
   * report them (the LLM proxy, which reconciles the provider shapes through
   * `readInputTokenClasses`). Present ⇒ the row is priced per class, so a cache read costs
   * ~0.1x fresh input instead of 1x.
   *
   * ABSENT is a real state, not a zeroed one: it says the producer reported a single lumped
   * count, and the row is then priced entirely at the fresh rate. That OVER-states a cached
   * call and never under-states one, which is the only safe direction for a budget gate.
   */
  inputClasses?: InputTokenClassUsage
  /**
   * Metered (a real per-token cost the budget gate sums) or subscription (a flat-rate
   * quota harness call, recorded for the usage report but excluded from spend). Absent ⇒
   * `'metered'` (the inline/proxy metered path).
   */
  billing?: UsageBilling
  /** The subscription vendor for a `'subscription'` row (claude/codex/glm/kimi/deepseek). */
  vendor?: string | null
}

/**
 * One scope's forward-looking spend position: where it stands, where it is heading, and which
 * alert state that puts it in. Returned by {@link SpendService.forecastWorkspaces} /
 * {@link SpendService.forecastAccounts}.
 *
 * `costLimit` and `currency` travel WITH the figures, never resolved again by a consumer: a
 * workspace can override both, so a caller pairing an amount with the deployment's currency (or
 * with another tier's limit) would put a wrong label on a right number.
 */
export interface ScopedSpendForecast {
  /** Metered spend so far this period, in `currency`. */
  costSpent: number
  /** The scope's effective limit for the period, in `currency`. */
  costLimit: number
  /** ISO 4217 currency both amounts are expressed in. */
  currency: string
  forecast: SpendForecast
  alert: SpendAlertState
}

/** Which budget tiers to check when gating a run (the caller passes what ids it has). */
export interface BudgetTierScope {
  accountId?: string | null
  userId?: string | null
}

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
 * The workspace-pricing and per-tier-limit reads resolve through the app cache seam
 * ({@link AppCaches}) so the hot {@link isOverBudget} gate doesn't re-read settings per
 * step; a budget edit invalidates the relevant slice so it takes effect immediately.
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
  private readonly workspaceSettingsCache?: GroupCacheHandle<WorkspaceSettingsCacheValue>
  private readonly accountBudgetLimitCache?: GroupCacheHandle<BudgetLimitCacheValue>
  private readonly userBudgetLimitCache?: GroupCacheHandle<BudgetLimitCacheValue>

  constructor({
    tokenUsageRepository,
    idGenerator,
    clock,
    pricing,
    workspaceSettingsRepository,
    accountRepository,
    userSettingsRepository,
    dynamicPricesFor,
    workspaceSettingsCache,
    accountBudgetLimitCache,
    userBudgetLimitCache,
  }: SpendServiceDependencies) {
    this.tokenUsageRepository = tokenUsageRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.pricing = pricing
    this.workspaceSettingsRepository = workspaceSettingsRepository
    this.accountRepository = accountRepository
    this.userSettingsRepository = userSettingsRepository
    this.dynamicPricesFor = dynamicPricesFor
    this.workspaceSettingsCache = workspaceSettingsCache
    this.accountBudgetLimitCache = accountBudgetLimitCache
    this.userBudgetLimitCache = userBudgetLimitCache
  }

  /** Parse a `provider:model` identifier into a {@link ModelRef}. */
  private parseModel(model: string): ModelRef {
    const idx = model.indexOf(':')
    if (idx === -1) return { provider: model, model: '' }
    return { provider: model.slice(0, idx), model: model.slice(idx + 1) }
  }

  /**
   * The workspace's effective pricing (base table overlaid with its budget overrides).
   * The underlying settings row is read through the shared `workspaceSettings` cache slice
   * (invalidated by `WorkspaceSettingsService.update`, so a budget edit takes effect on the
   * next call). Falls back to the base table when no settings repository is wired.
   */
  private async resolvePricing(workspaceId: string): Promise<SpendPricing> {
    if (!this.workspaceSettingsRepository) return this.pricing
    const settings = await readCachedWorkspaceSettings(
      this.workspaceSettingsCache,
      this.workspaceSettingsRepository,
      workspaceId,
    )
    return mergeSpendPricing(this.pricing, settings)
  }

  /**
   * Invalidate a cached account effective limit (called after an account-budget edit, via
   * `AccountService`'s budget-change callback). A no-op when no cache is wired.
   */
  async invalidateAccountLimit(accountId: string): Promise<void> {
    await this.accountBudgetLimitCache?.invalidate(accountId, accountId)
  }

  /**
   * Invalidate a cached user effective limit (called after a user-budget edit, via
   * `UserSettingsService`'s budget-change callback). A no-op when no cache is wired.
   */
  async invalidateUserLimit(userId: string): Promise<void> {
    await this.userBudgetLimitCache?.invalidate(userId, userId)
  }

  /**
   * The account tier's effective monthly limit: the configured account limit clamped by
   * the operator env cap. `Infinity` when the tier is inactive (neither set). The configured
   * limit is read through the shared `accountBudgetLimit` cache slice.
   */
  private async resolveAccountLimit(accountId: string): Promise<number> {
    const cap = this.pricing.accountMonthlyLimitCap
    const repository = this.accountRepository
    if (!repository) return effectiveTierLimit(null, cap)
    const load = async (): Promise<BudgetLimitCacheValue> => ({
      limit: (await repository.get(accountId))?.spendMonthlyLimit ?? null,
    })
    const { limit } = this.accountBudgetLimitCache
      ? await this.accountBudgetLimitCache.get(accountId, accountId, load)
      : await load()
    return effectiveTierLimit(limit, cap)
  }

  /** The user tier's effective monthly limit (configured user limit clamped by the env cap). */
  private async resolveUserLimit(userId: string): Promise<number> {
    const cap = this.pricing.userMonthlyLimitCap
    const repository = this.userSettingsRepository
    if (!repository) return effectiveTierLimit(null, cap)
    const load = async (): Promise<BudgetLimitCacheValue> => ({
      limit: (await repository.get(userId))?.spendMonthlyLimit ?? null,
    })
    const { limit } = this.userBudgetLimitCache
      ? await this.userBudgetLimitCache.get(userId, userId, load)
      : await load()
    return effectiveTierLimit(limit, cap)
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
    // Priced for both billing kinds: a subscription row's cost is illustrative (the
    // equivalent metered-API cost), never summed into a budget — the metered filter on
    // the totals rollups is what keeps subscription usage out of the spend gate.
    //
    // Per CLASS wherever the producer reported the split, because the classes are priced
    // more than an order of magnitude apart: pricing a cache-read-dominated run's whole
    // input at the fresh rate metered it at roughly ten times its real cost and exhausted
    // budgets that were nowhere near spent.
    const costEstimate = input.inputClasses
      ? estimateClassedCost(pricing, ref, {
          ...input.inputClasses,
          outputTokens: input.usage.outputTokens,
        })
      : estimateCost(pricing, ref, input.usage)
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
      billing: input.billing ?? 'metered',
      vendor: input.vendor ?? null,
      createdAt: this.clock.now(),
    })
    return costEstimate
  }

  /**
   * The current billing period's usage report for a workspace: one aggregated row per
   * `(billing, vendor, provider, model)` group, covering BOTH metered API/proxy calls and
   * subscription harness usage. Powers the "Usage" settings tab. This is reporting, not
   * gating — subscription rows are included here but excluded from {@link status} /
   * {@link isOverBudget}. Returned rows are the repository's single GROUP BY (no N+1).
   */
  async usageBreakdown(
    workspaceId: string,
  ): Promise<{ periodStart: number; currency: string; rows: UsageBreakdownRow[] }> {
    const pricing = await this.resolvePricing(workspaceId)
    const periodStart = startOfMonthUtc(this.clock.now())
    const rows = await this.tokenUsageRepository.usageBreakdownForWorkspace(
      workspaceId,
      periodStart,
    )
    return { periodStart, currency: pricing.currency, rows }
  }

  /**
   * The workspace's period as ONE read: the metered budget position AND the breakdown behind it,
   * resolved against a SINGLE `periodStart` and a single pricing lookup.
   *
   * This exists because {@link status} and {@link usageBreakdown} each derive their own period
   * from the clock. Calling both to serve one resource is correct almost always and wrong exactly
   * once a month: a pair of calls straddling the period roll would report a budget from one month
   * beside a breakdown from the next, under whichever `periodStart` the caller happened to pick —
   * the "read a period-roll apart" failure that serving them as one resource is meant to prevent.
   * The two aggregates still issue concurrently, so it costs one round trip's latency, not two.
   */
  async periodUsage(workspaceId: string): Promise<{
    periodStart: number
    currency: string
    budget: Omit<SpendStatus, 'periodStart' | 'currency'>
    rows: UsageBreakdownRow[]
  }> {
    const pricing = await this.resolvePricing(workspaceId)
    const periodStart = startOfMonthUtc(this.clock.now())
    const [totals, rows] = await Promise.all([
      this.tokenUsageRepository.totalsSinceForWorkspace(workspaceId, periodStart),
      this.tokenUsageRepository.usageBreakdownForWorkspace(workspaceId, periodStart),
    ])
    return {
      periodStart,
      currency: pricing.currency,
      budget: {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        costSpent: totals.costEstimate,
        costLimit: pricing.monthlyLimit,
        exceeded: totals.costEstimate >= pricing.monthlyLimit,
      },
      rows,
    }
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

  /**
   * The forward-looking position of many WORKSPACES at once: burn rate, projected period
   * total, and the alert state each is in. Advisory only: nothing here can pause a run.
   *
   * Batched because the alert sweep asks about every workspace in the deployment on every
   * pass: two grouped ledger reads (period-to-date and the trailing burn-rate window) serve
   * the whole set, where a per-workspace point read would be the banned N+1 run every few
   * minutes across every tenant. Workspaces with no metered spend this period are absent from
   * the result: they have nothing to forecast, and skipping them is what keeps a deployment
   * full of quiet boards cheap to sweep. Their pricing is never resolved either, so the
   * per-workspace settings read is paid only for boards that actually spent something.
   */
  async forecastWorkspaces(
    workspaceIds: string[],
    now: number,
  ): Promise<Map<string, ScopedSpendForecast>> {
    const periodStart = startOfMonthUtc(now)
    const windowStart = now - BURN_RATE_WINDOW_MS
    const [period, window] = await Promise.all([
      this.tokenUsageRepository.meteredSpendByWorkspaceSince(workspaceIds, periodStart),
      this.tokenUsageRepository.meteredSpendByWorkspaceSince(workspaceIds, windowStart),
    ])
    const out = new Map<string, ScopedSpendForecast>()
    for (const [workspaceId, spent] of period) {
      const pricing = await this.resolvePricing(workspaceId)
      out.set(
        workspaceId,
        this.buildForecast({
          costSpent: spent.costEstimate,
          costLimit: pricing.monthlyLimit,
          currency: pricing.currency,
          window: window.get(workspaceId),
          windowStart,
          periodStart,
          now,
        }),
      )
    }
    return out
  }

  /** The same for the ACCOUNT tier, priced in the base currency (an account spans workspaces). */
  async forecastAccounts(
    accountIds: string[],
    now: number,
  ): Promise<Map<string, ScopedSpendForecast>> {
    const periodStart = startOfMonthUtc(now)
    const windowStart = now - BURN_RATE_WINDOW_MS
    const [period, window] = await Promise.all([
      this.tokenUsageRepository.meteredSpendByAccountSince(accountIds, periodStart),
      this.tokenUsageRepository.meteredSpendByAccountSince(accountIds, windowStart),
    ])
    const out = new Map<string, ScopedSpendForecast>()
    for (const [accountId, spent] of period) {
      const costLimit = await this.resolveAccountLimit(accountId)
      // An inactive tier (no configured limit, no operator cap) is skipped outright rather
      // than forecast against `Infinity`: there is no ceiling to warn about approaching.
      if (!Number.isFinite(costLimit)) continue
      out.set(
        accountId,
        this.buildForecast({
          costSpent: spent.costEstimate,
          costLimit,
          currency: this.pricing.currency,
          window: window.get(accountId),
          windowStart,
          periodStart,
          now,
        }),
      )
    }
    return out
  }

  /** Assemble one scope's forecast + alert state from the reads above (pure beyond this point). */
  private buildForecast(input: {
    costSpent: number
    costLimit: number
    currency: string
    window: ScopedSpendWindow | undefined
    windowStart: number
    periodStart: number
    now: number
  }): ScopedSpendForecast {
    const forecast = forecastSpend({
      costSpent: input.costSpent,
      costLimit: input.costLimit,
      windowCost: input.window?.costEstimate ?? 0,
      windowFirstSeenAt: input.window?.firstSeenAt ?? null,
      windowStart: input.windowStart,
      periodStart: input.periodStart,
      periodEnd: startOfNextMonthUtc(input.periodStart),
      now: input.now,
    })
    return {
      costSpent: input.costSpent,
      costLimit: input.costLimit,
      currency: input.currency,
      forecast,
      alert: spendAlertState(forecast, input.periodStart, input.costLimit),
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
