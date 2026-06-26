import type { OpenRouterModelMeta, SpendStatus } from '@cat-factory/contracts'
import type { AgentTokenUsage } from '@cat-factory/kernel'
import type { ModelRef } from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { TokenUsageRepository, WorkspaceSettingsRepository } from '@cat-factory/kernel'
import {
  type SpendPricing,
  estimateCost,
  mergeSpendPricing,
  startOfMonthUtc,
  withDynamicPrices,
} from './pricing.js'

export interface SpendServiceDependencies {
  tokenUsageRepository: TokenUsageRepository
  idGenerator: IdGenerator
  clock: Clock
  /** The base (built-in) pricing table + the deployment fallback budget/currency. */
  pricing: SpendPricing
  /**
   * Per-workspace budget overrides (currency / monthly limit / per-model prices),
   * persisted on the workspace settings row. When wired, {@link SpendService}
   * resolves each workspace's effective pricing by overlaying its overrides onto the
   * base table; absent ⇒ every workspace uses the base table (tests/conformance).
   */
  workspaceSettingsRepository?: WorkspaceSettingsRepository
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
  executionId: string | null
  agentKind: string
  /** Model identifier as `provider:model` (as produced by AgentRunResult.model). */
  model: string
  usage: AgentTokenUsage
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
 * Budgets are per-workspace: each workspace's currency/monthly-limit/price overrides
 * (on its settings row) are overlaid onto the built-in base table. Resolution is
 * cached briefly so the hot {@link isOverBudget} gate doesn't re-read settings per step.
 */
export class SpendService {
  private readonly tokenUsageRepository: TokenUsageRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly pricing: SpendPricing
  private readonly workspaceSettingsRepository?: WorkspaceSettingsRepository
  private readonly dynamicPricesFor?: (workspaceId: string) => Promise<OpenRouterModelMeta[]>
  private readonly pricingCache = new Map<string, { value: SpendPricing; expiresAt: number }>()

  constructor({
    tokenUsageRepository,
    idGenerator,
    clock,
    pricing,
    workspaceSettingsRepository,
    dynamicPricesFor,
  }: SpendServiceDependencies) {
    this.tokenUsageRepository = tokenUsageRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.pricing = pricing
    this.workspaceSettingsRepository = workspaceSettingsRepository
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

  /** The current billing period's spend against the workspace's budget. */
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

  /** Whether this period's spend has reached the workspace's budget (runs should pause). */
  async isOverBudget(workspaceId: string): Promise<boolean> {
    const pricing = await this.resolvePricing(workspaceId)
    const periodStart = startOfMonthUtc(this.clock.now())
    const totals = await this.tokenUsageRepository.totalsSinceForWorkspace(workspaceId, periodStart)
    return totals.costEstimate >= pricing.monthlyLimit
  }
}
