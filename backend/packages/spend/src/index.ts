// Pricing tables and spend metering/gating for @cat-factory.

export {
  SpendService,
  type SpendServiceDependencies,
  type RecordUsageInput,
  type BudgetTierScope,
} from './SpendService.js'
export {
  type ModelPrice,
  type SpendPricing,
  DEFAULT_MODEL_PRICES,
  DEFAULT_MONTHLY_LIMIT_EUR,
  DEFAULT_SPEND_PRICING,
  budgetCapsOverlay,
  effectiveTierLimit,
  priceFor,
  modelCostResolver,
  estimateCost,
  withDynamicPrices,
  startOfMonthUtc,
} from './pricing.js'
