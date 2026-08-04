// Pricing tables and spend metering/gating for @cat-factory.

export {
  SpendService,
  type SpendServiceDependencies,
  type RecordUsageInput,
  type BudgetTierScope,
} from './SpendService.js'
export {
  type ModelPrice,
  type ResolvedModelPrice,
  type InputTokenClassUsage,
  type SpendPricing,
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  DEFAULT_MODEL_PRICES,
  DEFAULT_MONTHLY_LIMIT_EUR,
  DEFAULT_SPEND_PRICING,
  budgetCapsOverlay,
  effectiveTierLimit,
  priceFor,
  ratesFor,
  modelCostResolver,
  estimateCost,
  estimateClassedCost,
  withDynamicPrices,
  startOfMonthUtc,
} from './pricing.js'
