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
  // Measured 97.73% total / 97.73% covered over 396 mutants, less the two-point margin. The two
  // scores are equal because nothing in scope is untested: spend has no `NoCoverage` mutants left.
  //
  // This is the package's CEILING, not a rung: all nine remaining survivors were checked one by one
  // and every one is behaviour-preserving (the worked list is in
  // docs/internal/mutation-testing.md). So the floor is raised to lock in what is real.
  //
  // Read a dip against the DENOMINATOR before reading it as a regression. The margin is two
  // PERCENT, and on the smallest package in the set that is 11 mutants: 387 killed stays above 95%
  // only while the scope holds no more than 407. `mutate` is all of `src/`, so one new spend helper
  // landing ahead of its tests can trip this on its own, which is a nudge to write that test and
  // not a statement that anything stopped being pinned. The report says which of the two it is.
  minimumScore: 95,
})
