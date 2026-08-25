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
  // `*.fixtures.ts` is excluded on the same ground `*.test.ts` is: it is a factory the suites
  // call, so its literals are scaffolding rather than behaviour, and mutating them would report
  // survivors nothing should be asked to pin while enlarging the denominator the floor is read off.
  mutate: [
    'src/domain/**/*.ts',
    'src/shared/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.fixtures.ts',
  ],
  // Measured 82.37% total / 85.56% covered over 7,908 mutants, UNDER STRYKER 10.0.0. The floor is
  // the truncated total less the two-point margin every floor here carries
  // (docs/internal/mutation-testing.md says what the margin absorbs); kernel is the package that
  // needs it most, since ONE new `domain/` module arriving with no tests moves the total by more
  // than a point on its own.
  //
  // LOWERED from 82, and this is the rarer of the two legitimate lowerings: not a widened `mutate`
  // scope, but Stryker 10 adding `emptyExpressionMutator` to the DEFAULT set, which is the same
  // event through a different door. The population went 7,316 -> 7,908 and the total 84.23 ->
  // 82.37, because the new mutants land on call statements and `throw new X()`, which kernel's
  // suites assert around far less often than they assert returned values. Nothing here stopped
  // being pinned; the denominator grew with behaviour no test was ever written against.
  //
  // Left at 82 the floor was not a ratchet at all: 82.37 against a break of 82 is 0.37 points, and
  // the arithmetic above says one ordinary untested module costs ~1.6. The next one would have
  // turned the nightly red for scope growth while reading as a regression, which is the failure
  // the two-point margin exists to prevent. This is NOT licence for a test regression: the number
  // to compare against from here is 82.37, and covered (85.56, essentially unmoved from 85.79) is
  // what says the existing tests still assert what they did.
  minimumScore: 80,
})
