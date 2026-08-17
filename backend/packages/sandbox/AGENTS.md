# `@cat-factory/sandbox`: parallel prompt/model testing surface

Versioned prompt candidates, experiment matrices, and judge + objective grading: deliberately
isolated from the core product so it can be extracted. Pairs with `@cat-factory/sandbox-fixtures`
(the graded no-repo fixtures it grades against).

**Entry:** `src/index.ts`. Logic in `matrix.logic.ts`, `promptVersions.logic.ts`, `rubrics.ts`
(the judge's dimensions), `expectations.ts` (the deterministic objective scorer), `baselines.ts`,
`fixtures.ts`, `workspacePrompts.ts`. Open questions and the container-cell decision:
[`sandbox-coverage-expansion.md`](../../../docs/initiatives/sandbox-coverage-expansion.md).

A stored `systemText` is the **SHIPPED BASE prompt** (`shippedBasePromptFor`: the same unit a
per-workspace agent prompt override holds), and the run composes the rest back on at RUN time via
`composedSystemPromptFor(kind, registry, text)`, exactly as production dispatch composes an
override. That is what lets a graded candidate be PROMOTED to the live prompt unchanged. Reading the
text off `PROMPT_VERSIONS` instead is the trap: for an inline ENGINE kind that constant is the
COMPOSED prompt (role plus directives), so a candidate cloned from it doubled the directives on
promotion. `workspacePrompts.ts` projects the workspace's own revision log into read-only
`origin: 'workspace'` versions so an experiment can measure against the prompt that is actually
running, not only against what the product ships.

**A catalog entry answers two different execution questions, and conflating them was a bug both
ways.** `bucket` is how PRODUCTION dispatches the kind; `sandboxRun` is how the SANDBOX runs a cell
for it. The code `reviewer` is `container` + `inline` (production clones the PR branch, the Sandbox
does not), the `coder` is `container` + `unsupported` (its deliverable is a pushed commit). One
merged field described the reviewer as inline while its composed prompt told it to diff a branch,
and advertised the coder as testable while every draft for it was refused at create.
`unsupportedReason` is the ONE place the refusal is DECIDED, as a bounded CODE rather than a
sentence: `sandboxAdmission.ts` turns it into the API message an operator sees and the SPA maps it
to translated copy under the field, so the catalog holds no prose a locale cannot reach.
`statesMissingCheckout` derives the third fact from those two, so the run-driver can state the
absent checkout rather than grade a candidate on failing to run `git diff`.

**Container cells, when they land, must SUPPRESS the workspace prompt override.** Their dispatch
goes through `dispatchSystemPromptFor`, which reads the override off the run context, and an
experiment must run its SELECTED candidate. Passed through unchanged, every prompt column of the
grid returns identical scores with nothing saying why. Full model:
[`agent-prompt-overrides.md`](../../docs/agent-prompt-overrides.md).

**A rubric is a claim about what the task IS.** `SANDBOX_TASK_TYPES` is exported as a value and the
`RUBRICS` table is a total `Record`, so adding a task type fails to compile until it has dimensions.
The first three are byte-identical copies of the offline benchmark harness's, pinned by
`benchmark-harness/test/rubrics.conformity.test.ts`; the rest are Sandbox-only (the harness has no
runner for them), which is why that guard asserts a one-way relation rather than list equality.
Grading a design critique or a bug triage on `requirement-review` was wrong in the one way that
mattered: its `product_scope` dimension docks a finding for being technical, which is what those two
stages are for.

**`matchHints` are matched as whole tokens.** A trailing `*` makes the last token a prefix
(`idempoten*`). Without it a bare stem is a DEAD hint that scores "missed" for every answer while
reading as a perfectly sensible fixture.
