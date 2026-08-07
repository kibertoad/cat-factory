import { defineMutationConfig } from '../../../scripts/stryker-base.mjs'

// Kernel's `domain/` and `shared/` are the platform's pure logic: gate verdicts, judge
// dispositions, estimate gating, the host-markdown escapes, `redactSecrets`, the mount-layout
// projection. Every one of them is a rule other packages CONCLUDE from, and most are guarded by a
// single `.test.ts` beside them, which makes "does that test actually pin the rule" the highest-
// value question mutation testing can answer here.
//
// `src/ports/**` is deliberately OUT of scope: it is 131 files of interface declarations with a
// handful of default implementations mixed in, so mutating it would add a wall of `NoCoverage`
// mutants that says nothing about the tests that do exist. Bringing the tested port helpers in is
// a scope extension for a later slice, not a reason to widen the glob now.
//
// Kernel's vitest config enables v8 coverage with a threshold ratchet of its own. Stryker's vitest
// runner overrides `coverage.enabled` to false for its runs, so the two ratchets never interfere:
// the coverage floor answers "is this tested at all", this one answers "is the test asserting
// anything".
export default defineMutationConfig({
  mutate: ['src/domain/**/*.ts', 'src/shared/**/*.ts', '!src/**/*.test.ts'],
  // Measured 78.79% total / 83.43% covered over 6,115 mutants. The floor is the truncated total
  // less the two-point margin every floor here carries (docs/internal/mutation-testing.md says
  // what the margin absorbs); kernel is the package that needs it most, since ONE new `domain/`
  // module arriving with no tests moves the total by more than a point on its own.
  minimumScore: 76,
})
