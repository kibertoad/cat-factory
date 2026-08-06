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
  // Measured 78.03% total / 85.67% covered over 651 mutants, less the two-point margin.
  minimumScore: 76,
})
