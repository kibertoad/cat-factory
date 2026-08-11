// Shared Stryker configuration for every mutation-tested package.
//
// Mutation testing answers the one question coverage cannot: a line that RAN is not a line that
// was ASSERTED. Stryker rewrites the source under test (a `>` becomes `>=`, a condition is
// negated, a block is emptied, a string is replaced) and re-runs the suite. A mutant the tests
// still pass on is a behaviour NOTHING pins, which is exactly the shape of the bugs this repo's
// rules keep naming: a threshold comparison off by a boundary, a refusal that silently became a
// pass-through, a `?? fallback` no test ever forces.
//
// It is deliberately NOT part of `pnpm test:run` and NOT part of any blocking CI gate. A run is
// minutes of CPU per package, so it lives in its own nightly workflow
// (`.github/workflows/mutation.yml`) and is never expected on a developer's laptop. Full model,
// including how a package joins the set: `docs/internal/mutation-testing.md`.
//
// Every mutation-tested package's `stryker.config.mjs` is this function plus its own `mutate`
// scope and score floor, so the policy below (how coverage is analysed, where reports land, what
// is measured versus ignored) is ONE decision rather than a per-package copy that drifts.

/**
 * Build a package's Stryker config.
 *
 * @param {object} options
 * @param {string[]} options.mutate
 *   The glob set to mutate, package-relative. Scope it to the modules whose tests you intend to
 *   MEASURE: mutation score is a statement about test quality, so pointing it at code with no
 *   tests only restates what the vitest coverage floor already guards, and buries the signal
 *   under `NoCoverage` mutants.
 * @param {number} options.minimumScore
 *   The score ratchet, as a percentage. `stryker run` exits non-zero below it. Like the
 *   file-size and coverage ratchets it may only go UP: raise it when a change earns the win,
 *   never lower it to make a run green.
 * @returns {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export function defineMutationConfig({ mutate, minimumScore }) {
  return {
    packageManager: 'pnpm',
    testRunner: 'vitest',

    // Name the runner plugin EXPLICITLY. Stryker's default is the glob `@stryker-mutator/*`,
    // which it expands by reading the directory its own `core` package sits in: under pnpm's
    // isolated layout that directory holds core's own dependencies and nothing else, so the glob
    // matches zero plugins and the run dies in the test-runner child with `Cannot find TestRunner
    // plugin "vitest"`. A bare specifier is imported through normal Node resolution instead,
    // which finds it.
    plugins: ['@stryker-mutator/vitest-runner'],

    // Stryker runs the suite once up front, records which test touched which line, and then
    // runs ONLY the covering tests per mutant. It is what makes a run minutes instead of hours,
    // and it means a mutant no test covers is reported (as `NoCoverage`) without running
    // anything at all.
    coverageAnalysis: 'perTest',

    // A STATIC mutant lives in code that only executes while the module is loading (a top-level
    // constant, a pricing table, a frozen default). Per-test coverage cannot attribute it to a
    // test, so Stryker would otherwise re-run the WHOLE suite for each one. Ignoring them leaves
    // them out of the score rather than counting them as survived: "not measured" is the honest
    // report, where a survived verdict would blame tests that structurally cannot kill it.
    ignoreStatic: true,

    mutate,

    // Keep every tsconfig OUT of the sandbox. Stryker copies the package into a sandbox and
    // rewrites each copied tsconfig's `extends` / `references` so paths that pointed outside it
    // still resolve, and that rewrite calls `ts.parseConfigFileTextToJson`: an API TypeScript 7
    // (this repo's pinned compiler) no longer exposes from the JS entry point, so the run dies
    // before the first mutant with `ts.parseConfigFileTextToJson is not a function`. Excluding
    // the files removes the rewrite AND lands on the behaviour we want: the sandbox sits inside
    // the package directory, so vite's upward tsconfig search reaches the package's REAL
    // tsconfig.json, extends chain intact, and mutants transpile under the same compiler options
    // as an ordinary `vitest run`.
    ignorePatterns: ['tsconfig*.json'],

    // `break` is the ratchet; `high`/`low` only colour the report, and are kept absolute (not
    // derived from the floor) so the colours mean the same thing in every package's report.
    thresholds: { high: 80, low: 60, break: minimumScore },

    // `progress` self-downgrades to `progress-append-only` on a non-interactive console, so this
    // one list is right both locally and in CI. `json` is what a later trend/dashboard step would
    // read; `clear-text` prints the surviving mutants, which is the part a human acts on.
    reporters: ['progress', 'clear-text', 'html', 'json'],
    htmlReporter: { fileName: 'reports/mutation/index.html' },
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },

    // Vitest transpiles per file with no type-checking, and Stryker prefixes each mutated file
    // with `@ts-nocheck` (`disableTypeChecks`, on by default) so a mutant that would not compile
    // still runs. The trade is that type-impossible mutants show up as survivors instead of
    // being discarded; adding `checkers: ['typescript']` would remove them at the cost of
    // roughly doubling the run, which is not worth paying on a nightly.

    // Remove the sandbox even when the run ended badly (the default keeps it for debugging). It is
    // a full copy of the package's source and tests INSIDE the package directory, and vitest's
    // default excludes do not cover it: a leftover sandbox makes the next ordinary `vitest run`
    // collect every spec twice, against mutated source. The crash evidence is the log, not the copy.
    cleanTempDir: 'always',

    // The test process gets a longer leash than Stryker's 5s default: a mutant that turns a loop
    // bound into an infinite loop is caught by the timeout (and counts as killed), but so is a
    // cold vitest transform on a loaded CI runner, and that one would be a false kill.
    timeoutMS: 20_000,
  }
}
