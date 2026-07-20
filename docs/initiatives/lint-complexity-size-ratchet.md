# Initiative: ratchet down oxlint complexity & size ceilings

**Status:** in progress — `max-nested-callbacks` AND `max-depth` at their final targets (4);
`max-lines` / `max-lines-per-function` at their free floors. `complexity` / `max-statements` /
`max-params` / the two size rules still need the DI-builder / god-file refactors to move ·
**Owner:** core · **Started:** 2026-07-20

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

## Tooling: the floor-finder (`scripts/lint-limits-report.mjs`)

Before planning a slice, run `node scripts/lint-limits-report.mjs` (add `--top N` for more
offenders, `--json` for machine output). It runs oxlint ONCE with every ratcheted rule forced to
`max: 0` and reports, per rule: the **live ceiling** in `.oxlintrc.json`, the actual **floor** (the
lowest `max` the tree passes at today — drop the ceiling here for free), the reasonable **target**,
and the **top offenders** you'd split to go below the floor. This replaces the hand-rolled
`oxlint --config <probe>.json` recipe that used to live in this doc. It is a reporting tool only —
enforcement stays in `.oxlintrc.json`.

## Goal & rationale

The repo lints with oxlint but enforced **nothing** about per-function complexity or
file/function size — the only size guard was the custom `scripts/check-file-size.mjs`
(a soft per-file line budget with ratcheted legacy allowances). Nothing stopped a function
from growing to a 141-branch, 157-statement monster (`loadNodeConfig`,
`buildNodeContainer`), and nothing flagged a 3,100-line function.

We now enforce seven oxlint rules, but to land them without a mass refactor we pinned each
ceiling at **the current worst offender** — so the rules pass today and act purely as a
**ratchet**: no new code may exceed today's worst case. This initiative is the plan to walk
those ceilings **down** to reasonable values, refactoring the offenders that block each step.

The end state: complexity/size limits at industry-reasonable values, enforced as `error`,
with the god-files (`ExecutionService`, `RunDispatcher`, the `container.ts` builders, the
conformance suites) split along cohesive seams — the same god-file re-accretion the
`check-file-size.mjs` guard already fights, now covered function-by-function too.

## The target pattern (how to run each slice)

The rules live in the root [`.oxlintrc.json`](../../.oxlintrc.json) `rules` block, each as
`["error", { "max": N }]`. A slice is:

1. Pick the next rule + its next step from the checklist below.
2. Refactor the handful of offenders above that step's threshold (split the function/file
   along a cohesive seam — the `RunDispatcher` controller extractions are the model; see the
   file-size guard notes in [`CLAUDE.md`](../../CLAUDE.md) → "Run the CI guard scripts").
3. Lower that rule's `max` in `.oxlintrc.json` to the step value and run the whole-tree lint
   (`pnpm lint`, i.e. `oxlint` from the repo root — **never** a file subset).
4. If green, commit + update this checklist row. If a straggler remains, either fold it into
   the same slice or hold the step until it's split — never bump the `max` back up.

**Finding the current floor for any rule** (what value passes right now) — run the floor-finder:

```sh
node scripts/lint-limits-report.mjs            # table: ceiling vs floor vs target + top offenders
node scripts/lint-limits-report.mjs --top 15   # more offenders per rule
```

## Baseline (landed) — ceilings pinned at today's max

Every rule below currently passes with **zero** violations because its `max` equals the
worst offender. These are the starting ceilings, not the goal.

| Rule                     | Ceiling now | Reasonable target | Worst offender today                                             |
| ------------------------ | ----------: | ----------------: | ---------------------------------------------------------------- |
| `complexity`             |         141 |            **20** | `runtimes/node/src/config.ts` (`loadNodeConfig`, 141)            |
| `max-statements`         |         157 |            **30** | `frontend/app/app/stores/ui/modals.ts` (157)                     |
| `max-lines-per-function` |    **2453** |           **150** | `internal/conformance/src/suites/core.ts` (2453)                 |
| `max-lines`              |    **2802** |          **1500** | `orchestration/src/modules/execution/ExecutionService.ts` (2802) |
| `max-params`             |          20 |             **6** | `runtimes/node/src/container-executor-deps.ts` (20)              |
| `max-depth`              |    **4** ✅ |             **4** | at target — 0 offenders above 4                                  |
| `max-nested-callbacks`   |    **4** ✅ |             **4** | at target — 0 offenders above 4                                  |

> **First pass (landed):** the god-file split in #1266 dropped the two size-rule floors well
> below their pinned ceilings, so `max-lines` (3119 → **2802**) and `max-lines-per-function`
> (3103 → **2453**) tightened for free. `max-nested-callbacks` reached its **final** target
> (6 → **4**) after one test-file extraction, and `max-depth` moved to step 1 (6 → **5**) after
> two loop-body extractions. `complexity` / `max-statements` / `max-params` are unchanged —
> their floors equal their ceilings, so they need the DI-builder / god-file refactors before
> moving.
>
> **Second pass (landed):** `max-depth` reached its **final** target (5 → **4**) by hoisting the
> 18 depth-5 loop bodies into helpers — a shared `parseSubtasks` in `@cat-factory/kernel`
> (de-duplicating the four bootstrap / env-config-repair repo copies at the same time), the two
> `ExecutionWorkflow` poll loops (`drivePollLoop` / `driveGatePollLoop` + `pollOnce`), the
> benchmark harness's per-task fixture dispatch, `provision-detect`'s seed-dump child scan,
> `EnvironmentConnectionService`'s bootstrap commit/PR path, `WorkersAiLlmUpstream`'s assistant
> tool-call conversion, and the OTEL conformity metric fold. The size/complexity rules are still
> pinned at their ceilings pending the DI-builder / god-file refactors.

`max-lines`' final target of **1500** deliberately matches `check-file-size.mjs`'s default
budget, so the two guards agree on the file ceiling (the custom guard keeps its per-file
legacy allowances; oxlint enforces the flat global ceiling).

## Ratchet checklist (walk each `max` down; number in parens = offenders above that step)

Update the `Status` cell + the live `max` in `.oxlintrc.json` at the end of each slice.

### `complexity` — 141 → 20

| Step      | `max` | Offenders to split first                                                                                                                                     | Status    |
| --------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| baseline  |   141 | —                                                                                                                                                            | ✅ landed |
| 1         |    60 | (7) `buildNodeContainer` 139, `dispatchPersistenceCall` 101, `buildJobBody` 75, `FakeAgentExecutor.run` 68, `buildLocalContainer` 66, `pollAgentJobInner` 61 | ☐ todo    |
| 2         |    30 | (46) — `RunDispatcher` methods, `toRunResult`, `buildRegisteredAgentBody`, …                                                                                 | ☐ todo    |
| 3 (final) |    20 | (99) — ESLint's default; the long tail                                                                                                                       | ☐ todo    |

### `max-statements` — 157 → 30

| Step      | `max` | Offenders to split first                                                                                                                         | Status    |
| --------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| baseline  |   157 | —                                                                                                                                                | ✅ landed |
| 1         |    80 | (6) `ui/modals.ts` 157, `container.ts` 144, `rpc.ts` 122, `LlmProxyController` 108, `ContainerAgentExecutor` 98, `ComposeEnvironmentProvider` 94 | ☐ todo    |
| 2         |    50 | (29)                                                                                                                                             | ☐ todo    |
| 3 (final) |    30 | (105)                                                                                                                                            | ☐ todo    |

### `max-lines-per-function` — 3103 → 150

| Step       | `max` | Offenders to split first                                                                                                                    | Status    |
| ---------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| baseline   |  3103 | —                                                                                                                                           | ✅ landed |
| free floor |  2453 | — (no refactor; #1266 split the old 3103 `suites/execution.ts` offender)                                                                    | ✅ landed |
| 1          |  1000 | (9) — the conformance `suites/core.ts` (2453/2451) + `execution-review.ts` / `execution-tester.ts` / `agents.ts` `describe` blocks dominate | ☐ todo    |
| 2          |   300 | (67)                                                                                                                                        | ☐ todo    |
| 3 (final)  |   150 | (232)                                                                                                                                       | ☐ todo    |

> Note: most `max-lines-per-function` offenders are **test files** (`conformance/src/suites/*`,
> big `describe`/`it` blocks). Consider whether the final target warrants a test-file
> `overrides` entry (a looser `max` for `**/*.spec.ts` / `**/*.test.ts` / `conformance/src/suites/*`)
> rather than forcing product-code limits onto Vitest suites. Decide at step 2.

### `max-lines` — 3119 → 1500

| Step       | `max` | Offenders to split first                                                                                                                                                                                                                                                           | Status    |
| ---------- | ----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| baseline   |  3119 | —                                                                                                                                                                                                                                                                                  | ✅ landed |
| free floor |  2802 | — (no refactor; #1266 split the old 3119 `suites/execution.ts` + `node/container.ts` offenders)                                                                                                                                                                                    | ✅ landed |
| 1          |  2000 | (9) `ExecutionService.ts` 2802, `cloudflare/container.ts` 2710, `node/container.ts` 2583, `suites/core.ts` 2471, `RunDispatcher.ts` 2397, `provision-detect.logic.ts` 2280, `node/db/schema.ts` 2262, `server/test/persistenceRpc.spec.ts` 2148, `orchestration/container.ts` 1934 | ☐ todo    |
| 2 (final)  |  1500 | (13) — aligns with `check-file-size.mjs`                                                                                                                                                                                                                                           | ☐ todo    |

### `max-params` — 20 → 6

| Step      | `max` | Offenders to split first                                                                   | Status    |
| --------- | ----: | ------------------------------------------------------------------------------------------ | --------- |
| baseline  |    20 | —                                                                                          | ✅ landed |
| 1         |    10 | (1) `buildNodeContainer` (20 positional args → options object)                             | ☐ todo    |
| 2         |     8 | (5) `DeployerStepController` 10, `cloudflare/container.ts` 9, `RequirementReviewService` 9 | ☐ todo    |
| 3 (final) |     6 | (16)                                                                                       | ☐ todo    |

### `max-depth` — 6 → 4

| Step      | `max` | Offenders to split first                                                                                                                                                                                                                                                                              | Status    |
| --------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| baseline  |     6 | —                                                                                                                                                                                                                                                                                                     | ✅ landed |
| 1         |     5 | (2) `RequirementReviewService.ts` (→ `applyRecommendationToTarget`), `observability-otel/src/conformity.test.ts` (→ `accumulateMetric`)                                                                                                                                                               | ✅ landed |
| 2 (final) |     4 | (18) — ESLint's default; hoisted into helpers: shared `parseSubtasks` (kernel, de-dupes 4 repo copies), `ExecutionWorkflow` poll loops, benchmark per-task dispatch, `provision-detect` seed scan, `EnvironmentConnectionService` commit/PR path, `WorkersAiLlmUpstream` tool-calls, OTEL metric fold | ✅ landed |

### `max-nested-callbacks` — 6 → 4

| Step      | `max` | Offenders to split first                                                                                                                                                          | Status    |
| --------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| baseline  |     6 | —                                                                                                                                                                                 | ✅ landed |
| 1 → final |     4 | (1) `agents/src/repo-ops/render.test.ts` (→ `collectSpecIds`) — splitting the lone 6-offender dropped the floor straight to 4, so this jumped to the **final** target in one step | ✅ landed |

## Conventions & gotchas carried between iterations

- **Never raise a `max` back up.** Once a step lands, the ceiling only moves down. If a new
  PR would exceed a live ceiling, the PR splits its code — that is the whole point.
- **`error`, not `warn`.** The rules match the repo's `correctness: error` posture so a
  regression fails CI (`pnpm lint`), not just prints a warning.
- **Whole-tree lint only.** Verify a step with `pnpm lint` / `oxlint` from the repo root —
  never pass file paths (same rule as `oxfmt`; see CLAUDE.md).
- **Test suites dominate the size rules.** `internal/conformance/src/suites/*` are the top
  `max-lines` / `max-lines-per-function` offenders and are legitimately large table-driven
  suites — prefer an `overrides` looser ceiling for test globs over contorting them (decide
  by `max-lines-per-function` step 2).
- **`max-lines` overlaps `check-file-size.mjs`.** They are complementary, not redundant: the
  custom guard carries per-file ratcheted allowances for named legacy files; oxlint's
  `max-lines` is one flat global number. Keep the final oxlint target (1500) equal to the
  guard's default budget so they don't disagree.
- **DI builders are the recurring complexity/param sink.** `buildNodeContainer` /
  `buildLocalContainer` / `cloudflare` `container.ts` top `complexity`, `max-params`, and
  `max-lines` at once — splitting them (grouped sub-builders, an options object instead of
  positional args) knocks out several rules' step 1 in one refactor.
- **No changeset needed for a step that only edits `.oxlintrc.json`** (root tooling config,
  not a published package). A step that also refactors a **versioned package's** source needs
  that package's changeset as usual — even a test-file-only touch (`*.test.ts` under a published
  package's `src/`) counts as a package change to `changeset status`, so cover it with a patch.
- **Re-run the floor-finder before every slice.** A file split landed for the file-size guard (or
  any unrelated refactor) can drop a rule's floor below its pinned ceiling, opening a **free**
  tightening with no work — exactly how `max-lines` / `max-lines-per-function` moved in the first
  pass after #1266 split the conformance god-file. `node scripts/lint-limits-report.mjs` surfaces
  that gap (ceiling > floor).
