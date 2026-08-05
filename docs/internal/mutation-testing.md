# Mutation testing (Stryker)

Coverage answers "did a test execute this line". Mutation testing answers the question that
actually matters: **did a test NOTICE when the line changed behaviour.** Stryker rewrites the
source under test one mutant at a time (a `>` becomes `>=`, a condition is negated, a block is
emptied, a `??` fallback is dropped) and re-runs the suite. A mutant the suite still passes on is a
behaviour nothing pins, which is the exact shape of the bugs this repo's rules keep naming: a
threshold compared at the wrong boundary, a refusal that quietly became a pass-through, an
`ignoreStatic`-style default nothing forces.

**It is nightly-only and non-blocking.** Never part of `pnpm test:run`, never part of a merge gate,
never expected on a developer's laptop.

## How it runs

|                  |                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow         | [`.github/workflows/mutation.yml`](../../.github/workflows/mutation.yml): nightly cron, `workflow_dispatch` (optionally one package), plus any PR touching the flow's own files |
| Blocking?        | No. A separate workflow contributes no check to `ci.yml`'s aggregated `Build` / `Test` gates                                                                                    |
| Per package      | `pnpm exec turbo run test:mutation --filter=<package>` (the package script is `stryker run`)                                                                                    |
| Shared policy    | [`scripts/stryker-base.mjs`](../../scripts/stryker-base.mjs)                                                                                                                    |
| Target discovery | [`scripts/mutation-targets.mjs`](../../scripts/mutation-targets.mjs)                                                                                                            |
| Score table      | [`scripts/mutation-summary.mjs`](../../scripts/mutation-summary.mjs), appended to the run summary                                                                               |
| Report           | Uploaded per package as the `mutation-report-<slug>` artifact (HTML + JSON, 14 days)                                                                                            |

Each job runs one package, so a red package names itself and the others still finish.

The PR trigger is scoped to the flow's own files (this workflow, the shared config, the two scripts,
any package's `stryker.config.mjs`). It exists because `workflow_dispatch` only works once a workflow
is on the default branch, so a change to the flow could otherwise be proven only after merging it.

### Do not run it locally

A run is minutes of CPU per package even on a large machine, and local development is slow enough
already. The nightly is where this belongs; to measure a branch before it merges, dispatch the
workflow on that branch (`Actions` → `Mutation` → `Run workflow`) rather than paying for it on your
own machine.

If you are actively hunting one package's survivors and want a local loop anyway, that is
`pnpm exec turbo run test:mutation --filter=@cat-factory/spend`. Expect to wait, and expect it to
saturate every core.

## What is in scope, and why

| Package               | Mutated                          | Mutants | Score (total / covered) | Floor |
| --------------------- | -------------------------------- | ------- | ----------------------- | ----- |
| `@cat-factory/kernel` | `src/domain/**`, `src/shared/**` | 5,805   | 54.63% / 74.65%         | 52%   |
| `@cat-factory/gates`  | all of `src/`                    | 654     | 38.84% / 57.34%         | 36%   |
| `@cat-factory/spend`  | all of `src/`                    | 400     | 54.75% / 69.75%         | 52%   |

These three are pure logic with fast, database-free unit suites, which is the only shape mutation
testing can afford: the suite runs once per surviving mutant, so a package whose tests need
Postgres, `workerd` or a browser would turn a nightly into a week. Kernel's `src/ports/**` is out
of scope on a different ground: 131 files of interface declarations with a few default
implementations mixed in, where mutating everything would bury the signal under `NoCoverage`.

**A package joins the set by adding one file.** `stryker.config.mjs` beside its `package.json`
(copy `backend/packages/spend/stryker.config.mjs`), the two `@stryker-mutator/*` devDependencies,
and a `"test:mutation": "stryker run"` script. The workflow discovers it from the config file's
presence, so there is no second edit to forget: a list in the workflow would be silently a no-op
when a package was added without touching it, and the nightly would keep reporting green over a
package it never ran.

Candidates for the next slice, in rough order of value: `@cat-factory/contracts` (the pure rules
both sides agree about, e.g. `binaryFormatCoverage`), `@cat-factory/workspaces`,
`@cat-factory/consensus`, and kernel's tested `ports/**` helpers.

## Reading the numbers

Two scores, both in the summary table and in Stryker's own output:

- **score** = detected / (detected + undetected), over EVERY mutant in scope.
- **covered-code score** = detected / (detected + survived), over the mutants a test actually ran.

where detected = `Killed` + `Timeout` and undetected = `Survived` + `NoCoverage`. The gap between
the two is untested code inside the scope, not weak assertions: kernel sits at ~55% total and ~75%
covered because `domain/` holds modules with no tests at all beside modules tested thoroughly. The
covered-code score is the fair read on the tests that exist; the total is the honest read on the
scope.

`Ignored`, `CompileError` and `RuntimeError` are excluded from both denominators.

### The floor is a ratchet

`minimumScore` in each package's config becomes Stryker's `thresholds.break`: below it, `stryker
run` exits non-zero and the nightly job goes red.

The floors above are the measured scores (kernel 54.63, gates 38.84, spend 54.75) less a two-point
margin, because those numbers were measured on a developer machine and the first nightly is the
first Linux baseline. **Raise each floor to its measured value once that baseline exists**: the
margin exists to keep day one from failing over a platform difference, not as permanent slack.

**Measure on an idle machine, one package at a time.** A `Timeout` counts as DETECTED, and a test
process starved of CPU trips the timeout exactly like a mutant that hangs, so a saturated machine
reports a HIGHER score than the code deserves: gates first measured 40.98% with 19 timeouts while a
second Stryker run was competing for the same cores, and 38.84% with zero timeouts on its own. The
inflated number was the wrong one. This is also why `timeoutMS` is well above the default and why
nothing in CI runs two of these jobs on one runner.

Raise a floor when a change earns the win. The ONE legitimate lowering is a deliberate expansion of
the mutate scope that pulls in code which had no tests, and the PR that does it says so: everything
else that lowers the number is a test that stopped asserting something.

A red job is not a merge stop. It is a statement that some behaviour in that package is now
unpinned, and the HTML artifact says exactly which line.

## Fixing a survivor

The HTML report lists each surviving mutant against its source line with the mutator that produced
it. Three dispositions, in order of how often they are right:

1. **Add the missing assertion.** The usual case: the test drove the code but never checked the
   value the mutant changed.
2. **Delete the code.** A mutant that no test can distinguish is sometimes a branch nothing needs
   (a defensive `if` for a state the type system already excludes, a `?? fallback` behind a
   required field). Deleting beats asserting, per the governing principle.
3. **Silence it at the source**, with `// Stryker disable next-line <mutator>: <why>`. This is for
   a mutant that is genuinely not a behaviour, e.g. a log message's wording. Prefer 1 and 2; a
   disable comment with no reason is worse than a survivor, because it hides one.

Equivalent mutants exist (a rewrite that cannot change observable behaviour), which is why 100% is
not the goal and the floors are set from measurement rather than aspiration.

## Environment traps

Three things about this repo's toolchain break Stryker's defaults. All three are handled in
`scripts/stryker-base.mjs`, with the reasoning inline there; they are recorded here because each
one presents as a crash that names something else.

- **TypeScript 7 breaks Stryker's tsconfig rewriting.** Stryker rewrites a copied tsconfig's
  `extends` / `references` for its sandbox using `ts.parseConfigFileTextToJson`, which the pinned
  TypeScript 7 no longer exposes from its JS entry point, so a run dies with
  `ts.parseConfigFileTextToJson is not a function` before the first mutant. Keeping tsconfigs out
  of the sandbox (`ignorePatterns`) removes the rewrite, and the sandbox then picks up the
  package's REAL tsconfig through vite's upward search, extends chain intact.
- **pnpm's isolated layout breaks Stryker's plugin glob.** The default `plugins: ['@stryker-mutator/*']`
  is expanded by reading the directory `@stryker-mutator/core` itself sits in, which under pnpm
  holds core's own dependencies and nothing else. The run then dies in the test-runner child with
  `Cannot find TestRunner plugin "vitest"`. Naming the runner explicitly resolves it the normal
  Node way.
- **A stale `dist` aborts the whole run, not one mutant.** Stryker's first act is an ordinary run
  of the package's suite, and the suite resolves its workspace dependencies through their built
  `dist`. Against a stale one the initial run fails and Stryker exits with
  `There were failed tests in the initial test run` rather than a test-shaped error. The Turbo
  `^build` edge on `test:mutation` is what prevents it.

Two more Stryker behaviours worth knowing before reading a report:

- **Static mutants are ignored.** A mutant in code that only runs while the module loads (a
  top-level constant, the ~50-entry default price table) cannot be attributed to a test under
  per-test coverage, so Stryker would re-run the whole suite for each one. `ignoreStatic: true`
  leaves them out of the score instead of counting them as survived: "not measured" is honest,
  where a survived verdict would blame tests that structurally cannot kill it.
- **Vitest coverage is off during mutation runs.** Stryker's vitest runner overrides
  `coverage.enabled`, so kernel's coverage-threshold ratchet does not fire inside a mutation run.
  The two ratchets answer different questions and do not interfere: coverage asks whether the code
  is tested at all, mutation asks whether the test asserts anything.

## If the nightly gets too long

The lever is Stryker's `--incremental` (a cached `stryker-incremental.json` restored between runs,
so only mutants affected by the diff are re-tested), not a narrower scope: dropping files from
`mutate` buys wall-clock by measuring less, which is the opposite of the point. Sharding a single
package across matrix jobs by directory is the other option, and worth it only for kernel.
