import type { OpenRouterModelMeta, SpendStatus } from '@cat-factory/contracts'
import type { AgentTokenUsage } from '@cat-factory/kernel'
import type { ModelRef } from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'
import type { TokenUsageRepository } from '@cat-factory/kernel'
import { type SpendPricing, estimateCost, startOfMonthUtc, withDynamicPrices } from './pricing.js'

export interface SpendServiceDependencies {
  tokenUsageRepository: TokenUsageRepository
  idGenerator: IdGenerator
  clock: Clock
  pricing: SpendPricing
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

/**
 * The spend safeguard. It meters token usage into a persistent ledger, prices
 * each call into a single currency, and reports the current billing period's
 * spend against the configured budget. The execution engine consults
 * {@link isOverBudget} before every agent step and pauses when the budget is
 * exhausted; the worker surfaces {@link status} so the frontend can warn.
 */
export class SpendService {
  private readonly tokenUsageRepository: TokenUsageRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly pricing: SpendPricing
  private readonly dynamicPricesFor?: (workspaceId: string) => Promise<OpenRouterModelMeta[]>

  constructor({
    tokenUsageRepository,
    idGenerator,
    clock,
    pricing,
    dynamicPricesFor,
  }: SpendServiceDependencies) {
    this.tokenUsageRepository = tokenUsageRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.pricing = pricing
    this.dynamicPricesFor = dynamicPricesFor
  }

  /** Parse a `provider:model` identifier into a {@link ModelRef}. */
  private parseModel(model: string): ModelRef {
    const idx = model.indexOf(':')
    if (idx === -1) return { provider: model, model: '' }
    return { provider: model.slice(0, idx), model: model.slice(idx + 1) }
  }

  /** Meter and persist one LLM call; returns its estimated cost. */
  async record(input: RecordUsageInput): Promise<number> {
    const ref = this.parseModel(input.model)
    // Price a dynamic OpenRouter gateway model at its real per-model rate (overlaid onto
    // the base table) rather than the bare-`openrouter` fallback, when the resolver is wired.
    const pricing =
      ref.provider === 'openrouter' && this.dynamicPricesFor
        ? withDynamicPrices(this.pricing, await this.dynamicPricesFor(input.workspaceId))
        : this.pricing
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

  /** The current billing period's spend against the configured budget. */
  async status(): Promise<SpendStatus> {
    const periodStart = startOfMonthUtc(this.clock.now())
    const totals = await this.tokenUsageRepository.totalsSince(periodStart)
    return {
      periodStart,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costSpent: totals.costEstimate,
      costLimit: this.pricing.monthlyLimit,
      currency: this.pricing.currency,
      exceeded: totals.costEstimate >= this.pricing.monthlyLimit,
    }
  }

  /** Whether this period's spend has reached the budget (runs should pause). */
  async isOverBudget(): Promise<boolean> {
    const periodStart = startOfMonthUtc(this.clock.now())
    const totals = await this.tokenUsageRepository.totalsSince(periodStart)
    return totals.costEstimate >= this.pricing.monthlyLimit
  }
}
