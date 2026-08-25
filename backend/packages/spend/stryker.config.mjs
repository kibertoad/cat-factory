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
  // Measured 97.25% total / 97.49% covered over 400 mutants, UNDER STRYKER 10.0.0, less the
  // two-point margin. The floor is UNCHANGED across that major.
  //
  // The two scores are no longer equal, and that is the whole story of the bump here: Stryker 10's
  // `emptyExpressionMutator` gave spend its FIRST `NoCoverage` mutant, on the `effectiveTierLimit`
  // call inside the no-repository account-limit loop in SpendService.ts. Worth an assertion when
  // someone is next in that file, but a single mutant, and the covered score barely moved.
  //
  // This is close to the package's CEILING rather than a rung: the nine survivors measured under
  // 9.6.1 were checked one by one and every one is behaviour-preserving (the worked list is in
  // docs/internal/mutation-testing.md). Stryker 10 adds a tenth, of the new mutator's kind, on the
  // `out.set(id, this.pricing)` in the batched no-overrides pricing loop.
  //
  // Read a dip against the DENOMINATOR before reading it as a regression. The margin is two
  // PERCENT, and on the smallest package in the set that is 11 mutants: 389 killed stays above 95%
  // only while the scope holds no more than 409. `mutate` is all of `src/`, so one new spend helper
  // landing ahead of its tests can trip this on its own, which is a nudge to write that test and
  // not a statement that anything stopped being pinned. The report says which of the two it is.
  minimumScore: 95,
})
