# Mutation testing (Stryker)

Coverage answers "did a test execute this line". Mutation testing answers the question that
actually matters: **did a test NOTICE when the line changed behaviour.** Stryker rewrites the
source under test one mutant at a time (a `>` becomes `>=`, a condition is negated, a block is
emptied, a `??` fallback is dropped) and re-runs the suite. A mutant the suite still passes on is a
behaviour nothing pins, which is the exact shape of the bugs this repo's rules keep naming: a
threshold compared at the wrong boundary, a refusal that quietly became a pass-through, an
`ignoreStatic`-style default nothing forces.

**It runs nightly and it is non-blocking.** Never part of `pnpm test:run`, never part of a merge
gate, never expected on a developer's laptop. The one other trigger is a PR that changes the mutation
flow itself, so the flow is provable before it merges.

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

`scripts/stryker-base.mjs` types its return value against `@stryker-mutator/api`, which is why that
package sits in the ROOT `devDependencies` even though nothing at the root executes Stryker. The only
reference is a JSDoc `import()` type, so a dependency sweep reads it as dead weight. It is not:
dropping it while the reference stands is what knip's `unlisted` rule fails the build on.

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
| `@cat-factory/kernel` | `src/domain/**`, `src/shared/**` | 6,152   | 81.78% / 84.51%         | 79%   |
| `@cat-factory/gates`  | all of `src/`                    | 651     | 88.17% / 91.99%         | 86%   |
| `@cat-factory/spend`  | all of `src/`                    | 396     | 95.71% / 95.71%         | 93%   |

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
`@cat-factory/consensus`, and kernel's tested `ports/**` helpers. Spend is the package to widen
LAST: it is the only one with no `NoCoverage` left, so there is nothing in its scope a new file
would be joining.

Inside the packages already in scope, kernel's remaining `NoCoverage` is now concentrated in
`domain/catalog.ts`'s and `domain/seed.ts`'s data (the disposition for which is nothing) and in
`gates.ts`'s notification-card copy. The app-owned registry seams a deployment extends the platform
through are done: every one of them scores 100% except `pipeline-registry`, whose survivors are the
`findIndex` bounds inside its merge helpers.

## Reading the numbers

Two scores, both in the summary table and in Stryker's own output:

- **score** = detected / (detected + undetected), over EVERY mutant in scope.
- **covered-code score** = detected / (detected + survived), over the mutants a test actually ran.

where detected = `Killed` + `Timeout` and undetected = `Survived` + `NoCoverage`. The gap between
the two is untested code inside the scope, not weak assertions: kernel's `domain/` still holds
modules with no tests at all beside modules tested thoroughly. The covered-code score is the fair
read on the tests that exist; the total is the honest read on the scope.

Closing that gap is therefore mostly a question of which module gets its FIRST test, and the three
biggest moves so far were all exactly that: `ip-host.logic` / `llm-output` / `subtasks.logic` /
`errors`, then `models` / `validation-detectors` plus the multi-repo half of `gate-logic`, then the
app-owned registry seams (pipeline / provider / VCS / judge / step-resolver / task-type /
prompt-fragment) with the pure resolution helpers around them. The second round took kernel from
66.29% to 78.79% by moving 566 mutants out of `NoCoverage`, which is also the clearest illustration
of why the two columns move differently: the total gained 12.5 points while the covered score
gained 5.5, because a first test enlarges the covered denominator at the same time as it kills.

The third round shows the same asymmetry at a smaller scale, measured on ONE scope with the new
test files moved aside and back (78.95% / 83.63% → 81.78% / 84.51%): 145 mutants left `NoCoverage`
and 174 more were killed, so the total gained 2.8 points while the covered score gained 0.9. The
extra 29 kills are the part worth noticing: they landed in modules that ALREADY had tests, because
exercising a seam end to end reaches code its own file's suite drives past.

**Read the report's PER-FILE undetected counts, not the headline score, when deciding what to
work on.** They rank the work differently, and they also say which disposition applies: a file
whose count is nearly all `NoCoverage` wants a test file, while a high `Survived` count on a
tested module wants assertions. Where the mutants sit in a data table rather than in logic, the
answer is nothing at all. `domain/seed.ts` is the standing example of the last case: it carries one of the
largest counts in kernel, and most of it is string literals in the demo board and the built-in
pipeline catalog. Pinning those means asserting shipped copy line by line, which is the
re-pinned-unread test CLAUDE.md's testing conventions warn about; the logic around the data (the
named-step lowering, version defaulting, the seed's structural invariants) is what is worth
holding.

`Ignored`, `CompileError` and `RuntimeError` are excluded from both denominators.

### The floor is a ratchet

`minimumScore` in each package's config becomes Stryker's `thresholds.break`: below it, `stryker
run` exits non-zero and the nightly job goes red.

**A floor is the measured total truncated to a whole percent, less two points** (kernel 78.79 →
78 → 76, gates 85.25 → 85 → 83, spend 95.71 → 95 → 93). The margin is not provisional slack
waiting to be reclaimed. It is sized to the one thing that moves this number without any test
having changed: **the denominator**.

The total score is `detected / (detected + survived + NoCoverage)` over the whole `mutate` scope,
so every file the scope gains re-bases it. A new `domain/` module arriving before its tests drops
the total by roughly `its mutants / total`, about 1.6 points for a 150-mutant one. Two points is
therefore about one ordinary module's worth of room: enough that unrelated growth cannot turn the
nightly red, small enough that a real regression still does.

This is not a hypothetical. Kernel went 5,805 → 5,956 → 6,034 → 6,084 → 6,115 → 6,152 mutants
across the baselines behind this table, purely from ordinary main-branch work, and one of those
steps landed WHILE the floor was being set: `prompt-fragment-registry.ts` arrived with no test file,
adding 20 `NoCoverage` mutants and moving the total 66.36 → 66.29 on its own. One module, no test
regression anywhere, and a floor pinned to the measured value would already have been that much
closer to red. (The last step is the same story with the sign flipped: the 37 mutants between 6,115
and 6,152 arrived on main while this table's third round was being measured, which is why the
before-and-after above is a pair of runs on ONE scope rather than a comparison against the row the
previous round left behind.)

The scope can also SHRINK, and for a good reason: deleting a branch nothing could distinguish (one
of the three dispositions below) removes its mutants from the denominator. Spend went 400 → 396
that way. Neither direction is a regression, which is what the margin is there to absorb.

Do not reason about that margin from runner speed. An earlier revision of this file argued the
floors needed none, because a `Timeout` counts as DETECTED and so a slower runner "can only score
the same or higher". Both halves fail. It is one-directional (a FASTER runner than the measuring
machine turns timeout-kills back into survivors, which lowers the score), and the cushion it
appeals to is mostly not there: every measurement behind the table above found **zero** timeouts in
gates and spend, and nine in kernel, worth 0.15 points. Runner speed is the small term here;
scope growth is the large one.

The covered-code score is the metric that is immune to scope growth, and it is deliberately NOT
the ratchet. It has the opposite bias: writing the FIRST test for an untested module moves that
module's mutants out of `NoCoverage` and into the covered denominator, so a first test that is
good rather than exhaustive lowers the covered score while raising the total. Ratcheting it would
penalise exactly the work that closes the gap between the two columns. Neither ratio moves only on
regression, which is why the instrument is a floor with margin rather than a cleverer metric.

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

Three more Stryker behaviours worth knowing before reading a report:

- **Static mutants are ignored.** A mutant in code that only runs while the module loads (a
  top-level constant, the ~50-entry default price table) cannot be attributed to a test under
  per-test coverage, so Stryker would re-run the whole suite for each one. `ignoreStatic: true`
  leaves them out of the score instead of counting them as survived: "not measured" is honest,
  where a survived verdict would blame tests that structurally cannot kill it.
- **A value computed in a `describe` BODY is read from unmutated source.** A mutant is switched on
  per test at RUN time, and a describe body runs at COLLECTION time, before any switch is set. So a
  snapshot taken there is built from the original code and every assertion below reads the same
  frozen copy however the source is rewritten, reported as `Survived` rather than `NoCoverage` because
  the tests did run and did pass. It hides exactly the guard most worth having: the derive-from-the-
  source drift check the testing conventions ask for, whose whole design is to walk a registry once
  and assert a relation over it. `gates`' human-wait parity guard was one, and the entire
  `pollExhaustion: 'rearm'` declaration it exists to protect could be emptied with all four of its
  cases green. Build the snapshot in a helper the tests CALL, not in a `const` beside them.
- **Vitest coverage is off during mutation runs.** Stryker's vitest runner overrides
  `coverage.enabled`, so kernel's coverage-threshold ratchet does not fire inside a mutation run.
  The two ratchets answer different questions and do not interfere: coverage asks whether the code
  is tested at all, mutation asks whether the test asserts anything.

## If the nightly gets too long

The lever is Stryker's `--incremental` (a cached `stryker-incremental.json` restored between runs,
so only mutants affected by the diff are re-tested), not a narrower scope: dropping files from
`mutate` buys wall-clock by measuring less, which is the opposite of the point. Sharding a single
package across matrix jobs by directory is the other option, and worth it only for kernel.
