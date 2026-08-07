import { defineMutationConfig } from '../../../scripts/stryker-base.mjs'

// Spend is money arithmetic and threshold comparisons (budget caps, tier limits, burn-rate
// forecasting, alert escalation), which is the highest-value shape there is for mutation testing:
// every one of its bugs is an off-by-a-boundary or an inverted comparison that a coverage-shaped
// test walks straight past.
//
// `pricing.ts` is IN scope for its resolution logic (`priceFor`, `estimateCost`, the cache
// multipliers), not for the ~50-entry default price table beside it: that table is a top-level
// constant, so its mutants are static and left unmeasured by `ignoreStatic` (see the base config).
export default defineMutationConfig({
  mutate: ['src/**/*.ts', '!src/**/*.test.ts', '!src/index.ts'],
  // Measured 90.25% total / 90.70% covered over 400 mutants, less the two-point margin.
  minimumScore: 88,
})
