# Initiative: ratchet down oxlint complexity & size ceilings

**Status:** in progress — baseline ceilings landed (all rules pinned at today's max) ·
**Owner:** core · **Started:** 2026-07-20

> This is the durable source of truth for a multi-PR initiative. Read it first before
> picking up the next slice; update the checklist at the end of each PR.

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

**Finding the current floor for any rule** (what value passes right now) — enable it at
`max: 0/1` and read the actual counts oxlint reports:

```sh
# messages read "has a complexity of N" / "has too many statements (N)" / "(N)" lines etc.
oxlint --config <probe>.json --format json . | \
  node -e 'JSON.parse(require("fs").readFileSync(0)).diagnostics...'  # group by code, take max
```

## Baseline (landed) — ceilings pinned at today's max

Every rule below currently passes with **zero** violations because its `max` equals the
worst offender. These are the starting ceilings, not the goal.

| Rule | Ceiling now | Reasonable target | Worst offender today |
|---|---:|---:|---|
| `complexity` | 141 | **20** | `runtimes/node/src/config.ts` (`loadNodeConfig`, 141) |
| `max-statements` | 157 | **30** | `frontend/app/app/stores/ui/modals.ts` (157) |
| `max-lines-per-function` | 3103 | **150** | `internal/conformance/src/suites/execution.ts` (3103) |
| `max-lines` | 3119 | **1500** | `internal/conformance/src/suites/execution.ts` (3119) |
| `max-params` | 20 | **6** | `runtimes/node/src/container.ts` (`buildNodeContainer`, 20) |
| `max-depth` | 6 | **4** | `RequirementReviewService.ts`, a conformance test (6) |
| `max-nested-callbacks` | 6 | **4** | `agents/src/repo-ops/render.test.ts` (6) |

`max-lines`' final target of **1500** deliberately matches `check-file-size.mjs`'s default
budget, so the two guards agree on the file ceiling (the custom guard keeps its per-file
legacy allowances; oxlint enforces the flat global ceiling).

## Ratchet checklist (walk each `max` down; number in parens = offenders above that step)

Update the `Status` cell + the live `max` in `.oxlintrc.json` at the end of each slice.

### `complexity` — 141 → 20

| Step | `max` | Offenders to split first | Status |
|---|---:|---|---|
| baseline | 141 | — | ✅ landed |
| 1 | 60 | (7) `buildNodeContainer` 139, `dispatchPersistenceCall` 101, `buildJobBody` 75, `FakeAgentExecutor.run` 68, `buildLocalContainer` 66, `pollAgentJobInner` 61 | ☐ todo |
| 2 | 30 | (46) — `RunDispatcher` methods, `toRunResult`, `buildRegisteredAgentBody`, … | ☐ todo |
| 3 (final) | 20 | (99) — ESLint's default; the long tail | ☐ todo |

### `max-statements` — 157 → 30

| Step | `max` | Offenders to split first | Status |
|---|---:|---|---|
| baseline | 157 | — | ✅ landed |
| 1 | 80 | (6) `ui/modals.ts` 157, `container.ts` 144, `rpc.ts` 122, `LlmProxyController` 108, `ContainerAgentExecutor` 98, `ComposeEnvironmentProvider` 94 | ☐ todo |
| 2 | 50 | (29) | ☐ todo |
| 3 (final) | 30 | (105) | ☐ todo |

### `max-lines-per-function` — 3103 → 150

| Step | `max` | Offenders to split first | Status |
|---|---:|---|---|
| baseline | 3103 | — | ✅ landed |
| 1 | 1000 | (9) — the conformance `suites/execution.ts` + `suites/core.ts` `describe` blocks dominate (3103/3101/2973/2453/2451) | ☐ todo |
| 2 | 300 | (67) | ☐ todo |
| 3 (final) | 150 | (229) | ☐ todo |

> Note: most `max-lines-per-function` offenders are **test files** (`conformance/src/suites/*`,
> big `describe`/`it` blocks). Consider whether the final target warrants a test-file
> `overrides` entry (a looser `max` for `**/*.spec.ts` / `**/*.test.ts` / `conformance/src/suites/*`)
> rather than forcing product-code limits onto Vitest suites. Decide at step 2.

### `max-lines` — 3119 → 1500

| Step | `max` | Offenders to split first | Status |
|---|---:|---|---|
| baseline | 3119 | — | ✅ landed |
| 1 | 2000 | (9) `suites/execution.ts` 3119, `node/container.ts` 3085, `RunDispatcher.ts` 2882, `ExecutionService.ts` 2802, `cloudflare/container.ts` 2710, `suites/core.ts` 2471, `provision-detect.logic.ts` 2280, `node/db/schema.ts` 2262 | ☐ todo |
| 2 (final) | 1500 | (14) — aligns with `check-file-size.mjs` | ☐ todo |

### `max-params` — 20 → 6

| Step | `max` | Offenders to split first | Status |
|---|---:|---|---|
| baseline | 20 | — | ✅ landed |
| 1 | 10 | (1) `buildNodeContainer` (20 positional args → options object) | ☐ todo |
| 2 | 8 | (5) `DeployerStepController` 10, `cloudflare/container.ts` 9, `RequirementReviewService` 9 | ☐ todo |
| 3 (final) | 6 | (16) | ☐ todo |

### `max-depth` — 6 → 4

| Step | `max` | Offenders to split first | Status |
|---|---:|---|---|
| baseline | 6 | — | ✅ landed |
| 1 | 5 | (2) `RequirementReviewService.ts`, `observability-otel/src/conformity.test.ts` | ☐ todo |
| 2 (final) | 4 | (23) — ESLint's default | ☐ todo |

### `max-nested-callbacks` — 6 → 4

| Step | `max` | Offenders to split first | Status |
|---|---:|---|---|
| baseline | 6 | — | ✅ landed |
| 1 | 5 | (1) `agents/src/repo-ops/render.test.ts` | ☐ todo |
| 2 (final) | 4 | (5) | ☐ todo |

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
  that package's changeset as usual.
