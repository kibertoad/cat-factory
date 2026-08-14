import { defineMutationConfig } from '../../../scripts/stryker-base.mjs'

// The built-in polling gates. A gate is a verdict machine (`wired()` / `probe()` / helper
// escalation / `onExhausted`), so its bugs are precisely what mutation testing finds: a probe that
// reports green on a state it should have escalated, an attempt counter compared with the wrong
// boundary, a "skip unless needed" short-circuit that stopped skipping.
//
// The whole package is in scope, `index.ts` included: it registers the built-ins through the same
// public seam a deployment uses and has its own suite, so it is behaviour rather than a barrel.
export default defineMutationConfig({
  mutate: ['src/**/*.ts', '!src/**/*.test.ts'],
  // Measured 90.78% total / 92.06% covered over 651 mutants, less the two-point margin. The two
  // columns moved by wildly different amounts on the same tests: the human-review gate's
  // resolve-nothing rounds plus `onExhausted` took the package's `NoCoverage` from 27 to 9 and the
  // total up 2.6 points, while the covered score moved 0.07 (91.99% to 92.06%). That is the
  // asymmetry docs/internal/mutation-testing.md describes: a FIRST test enlarges the covered
  // denominator at the same time as it kills, so nearly all of its win lands in the total.
  minimumScore: 88,
})
