# Task assessment: the forecast and the measurement

A task's three triage scores (`complexity` / `risk` / `impact`, each 0..1) have TWO producers at
opposite ends of a run, and the difference between them is the whole design:

| Kind              | Surface                                       | Reads                                     | Writes               |
| ----------------- | --------------------------------------------- | ----------------------------------------- | -------------------- |
| `task-estimator`  | inline (no checkout)                          | the clarified requirements + spec context | `basis: 'predicted'` |
| `task-reassessor` | `container-explore` (base + `origin/pr-head`) | the diff the run actually landed          | `basis: 'observed'`  |

Both write ONE field, `Block.estimate` (`taskEstimateSchema` in `@cat-factory/contracts`), which is
the platform's current best answer about the size of the task. What the estimate is FOR (gating a
step, gating a consensus panel, the fork-decision auto-propose, the board's impact sort) is
unchanged and documented with the mechanism that reads it:
[`pipeline-catalog-collapse.md`](../../docs/initiatives/pipeline-catalog-collapse.md) for estimate
gating, [`consensus-panels.md`](./consensus-panels.md) for the panel tiers. The user-facing account
of both steps lives on the website
([choosing a pipeline](https://www.catfactory.ai/guide/choosing-a-pipeline.html#estimating-and-gating-expensive-steps));
this doc is the internal design.

## Why a second KIND, not a second mode of the estimator

The obvious alternative was one kind that behaves differently depending on where it sits. Four
things in this repository say otherwise, and the first is decisive:

1. **The estimator is INLINE by construction.** It is a member of `INLINE_ENGINE_KINDS`
   (`agents/kinds/step-surface.ts`), which is what `isInlineModelStep` answers and what the
   preset-satisfiability guard keys off: an inline `generateText` call cannot use a container-only
   subscription token, so an inline step has to resolve to an inline-usable model. A
   post-implementation reading needs a real checkout to diff. One kind cannot be classified both
   ways, and either classification is wrong for half of its uses: `inline` falsely refuses a run
   whose model is container-only, `container` silently drops the check on the pre-implementation
   step that needed it.
2. **The precedent is already here.** `merger` is the estimator's other retrospective twin: same
   three axes, same JSON contract, a separate kind because it runs on a checkout at the end of a
   run. `TRIAGE_JSON_CONTRACT` exists precisely so the contract is stated once across kinds.
3. **A prompt override replaces a kind's WHOLE role text.** A dual-mode kind's override would have
   to reproduce both modes' instructions, and a workspace that rewrote it for the pre-implementation
   case would silently degrade the other one.
4. **Consensus eligibility differs.** The estimator is consensus-eligible (a panel scoring a
   description is a genuinely better estimate); the reassessor must NOT be, because a panel
   participant has no checkout (`dispatchDeliversCheckout`) and this kind's entire input is the
   checkout.

## What the record says

`TaskEstimate` carries `basis` plus, when a reading REPLACED one of the other basis, the scores it
replaced (`supersedes`). Three properties hold it together:

- **`basis` is OPTIONAL on the type, not defaulted into it.** The estimate is persisted as a JSON
  blob and read back with a plain `JSON.parse` (no schema pass, see `optJsonField` in the mappers),
  so a row written before the vocabulary existed genuinely carries no basis. Absence READS as
  `predicted` (every one of those rows came from the estimator), and a value this build cannot name
  renders as unrecognised rather than being guessed onto a current member. Both readers state all
  three cases: `basisTitle` in `estimation/estimate.logic.ts` (backend prose) and
  `estimateBasisLabelKey` in the SPA's `utils/estimateGating.ts` (a translation key), each narrowing
  with the SAME `isTaskEstimateBasis` predicate, derived from the picklist's own options.
- **The basis comes from the CALLER, never off the reply.** `coerceTaskEstimate` takes it as an
  argument, so a model claiming `"basis": "observed"` cannot promote its own forecast into a
  measurement of a change nobody read.
- **The delta is COMPUTED.** The reassessor is deliberately not told the earlier forecast: an
  assessment handed the number it is revising anchors on it, and what moved between two records is
  arithmetic (`summarizeEstimate`).

`supersedes` holds the last reading of the OTHER basis rather than simply the previous record, and
`reviseTaskEstimate` (which BOTH producers' resolvers write through, from ONE factory, so the rule
cannot depend on which one ran last) is where that is decided. A same-basis re-run INHERITS the pair
instead of overwriting it: two consecutive forecasts are one forecast revised, so recording the earlier one
would render a prediction/measurement comparison that never happened, while dropping what the
record already carried would let a RETRIED measurement delete the forecast the comparison exists
for. One level deep either way, so a board row holds the pair and never a chain.

The prior record is read at settle time rather than taken from the run context (which was built at
dispatch, and a container job can outlive minutes of other writes), and that read plus the write is
not one atomic step. The bounded consequence is worth stating rather than implying: two runs settling
an estimate on the SAME block at the same time both write a valid current reading, and the loser's
`supersedes` pair is lost. Never the current scores, which are the last writer's real reading either
way, and never a mixture of the two.

## The dispatch shape, and what a missing pull request means

`clone: { branch: 'base', full: true, prHead: true, prHeadSource: 'run', requirePr: true }`, which is
the `pr-reviewer`'s shape rather than the `merger`'s, for one reason: **a merge deletes the pull
request's branch, and `refs/pull/<n>/head` outlives it.** A `pr` clone would work for a step running
before the merge and fail for the same step running after it. The harness fetches that ref into
`origin/pr-head` (GitHub) / the GitLab equivalent, and the prompt diffs
`origin/<base>...origin/pr-head`.

**Which pull request is DECLARED, never resolved by precedence.** `prHeadSource` names the source:
`task` (the default) is the PR the task itself declares in `prNumber`/`prUrl`, which is the
`pr-reviewer`'s subject; `run` is the PR this run opened, which is this kind's. One resolver answers
it, `resolvePrHeadNumber` (`@cat-factory/agents`), and both readers of the declaration go through it:
the run preamble asking whether the step has anything to read, and the job body asking what the
harness should fetch. A `task ?? run` fallback was the first shape and is the wrong one: it reads as
harmless and silently widens whichever kind already had a source, so a review task whose run also
opened a pull request would start prefetching a head its review state knows nothing about, while the
prompt and the diff preOp still described the declared one.

Two things then do NOT happen, and each replaces something worse:

- **No pull request at all means the STEP IS SKIPPED, and the run continues.** `requirePr` says the
  kind cannot fall back to the base branch, and what that costs splits by whether the kind writes on
  the pull request or reads it. A WRITER (the in-place fixers, `branch: 'pr'`) refuses at dispatch,
  because cloning base would push its commits onto the default branch. A READER has no such hazard
  and a different one: a base checkout holds nothing to measure and would be scored as though it
  were the change, but FAILING would end a run whose work has already shipped over a reading nothing
  gates on. So `runStepPreamble` skips it beside the estimate gate and the run condition, recording
  `skipReason: 'no_pull_request'`, which the SPA maps to translated copy. The refusal in
  `resolvePrefetchPrNumber` stays as the invariant's backstop.
- **An unreadable reply means NOTHING is recorded, and the run CONTINUES.** This is the one place the
  kind deliberately diverges from the two assessors it otherwise copies. `merger` and `on-call`
  declare a STRUCTURED output and map it onto an engine channel, and for a structured explore kind
  the harness treats an unparseable reply as a job failure (`failureCause: 'no-usable-output'`).
  Both are right for them: the engine has a merge to decide and would have nothing to decide it
  with, and a garbage score defaulting to maximally severe routes that decision to a human.

  Neither is right here, for the reason the skip above is a skip. So the kind declares PROSE and no
  `mapStructuredResult`: the reply lands on `step.output`, the resolver reads the scores out of it
  with the same tolerant parse the inline estimator uses, and an unreadable one keeps the raw text
  and leaves the estimate the task already had. The trade is the structured repair pass, which a
  failing step buys and this does not; `extractJson` tolerating fences and surrounding prose is what
  makes that trade cheap. Recording a defaulted 1/1/1 as a measurement was never an option: it would
  silently move every gate that reads the estimate.

### Why the prompt REPLACES the generic one

The kind declares `userPrompt`, not the `on-call`'s `userPromptSuffix`, and what that drops is the
point rather than a casualty. The generic block-context prompt ends with the fold of every prior
step's output, and at this position in a pipeline that fold CONTAINS THE FORECAST: the estimator's
own `step.output` is `summarizeEstimate`, in percentages. An assessment handed the number it is
revising anchors on it, and the delta is arithmetic the platform does from the two records.

What a replacement must NOT drop is the account of what the work was, so the prompt re-states the
task description and runs `ownServiceSection` itself. The impact axis is a blast radius, and a bare
title names no software for one to be judged against: a model given none supplies one, which is the
rule CLAUDE.md states for `ownService` generally.

## Placement rules

- **After the step that opens the pull request, and that is enforced at SAVE.**
  `assertValidPullRequestReaders` refuses a pipeline that opens a pull request with this step ahead
  of the step that opens it: at that point in the run nothing has been pushed, so it would be
  skipped for want of a PR the very next step creates, and an estimate gate downstream that counted
  it as its producer would read nothing. An ORDERING rule rather than a presence one, so the narrow
  chain that measures a change the BLOCK already carries is left alone.
- **An estimate gate's prerequisite is satisfied by EITHER producer** (`producesTaskEstimate` in
  `@cat-factory/contracts`, read by the engine, the SPA's pipeline-health advisory and the builder's
  draft warning alike), because the rule is about the estimate FIELD being populated, not about which
  agent populated it. The ordering rule above is what keeps that from admitting a producer placed
  where it can never produce.
- **Gatable, and shipped in no preset.** It costs a read-only container run per task, and the task a
  forecast put at the bottom of every axis is the one least worth measuring, so gating it is the
  usual configuration. No built-in pipeline carries the step: adding it is a builder decision. The
  palette offers it only to code-shipping purposes (`purposes: ['build']`), since a document,
  research, planning or review pipeline opens no pull request for it to read.
- **After the `merger` is legitimate, and is the strongest placement**: the change has landed for
  real. `refs/pull/<n>/head` is why the diff is still readable once the branch is gone. What makes a
  trailing step safe there is the BLOCK's own status, not the previous resolver's return value.
  `resolverOwnsTerminalStatus` answers only for the step settling right now, so with
  `merger` then `task-reassessor` then `disposer` the merger's claim is honoured as the run advances
  past the merger and lost one step later: `in_progress` goes over a real merge, and
  `finalizeBlock`'s merger backstop then rewrites the merged task as `pr_ready`.
  `settleStepAndAdvance` reads the block instead (`blockIsTerminal`), so a `done` or `pr_ready`
  block only ever has its progress bar moved by the steps that follow.
- **A gated step placed after it reads the MEASUREMENT.** That is deliberate and it is better
  information than the forecast, but it is a real behaviour difference from the same gate placed
  earlier, and the builder's step-condition preview says only that the step is conditional.

## Known gap: assessing a task whose run already finished

The step covers both cases WITHIN a run: it corrects a forecast, or produces the first ratings a
pipeline with no estimator would never have had. What it does not yet cover is a task that finished
some earlier run and has no assessment, because there is no way to run one step against a settled
task: a new run on a `done` block moves it out of `done` (`RunStateMachine.finalizeBlock` returns
early only for a block that is STILL `done` when the run settles, and the run flips it to
`in_progress` on the way), so a standalone assessment preset would raise a spurious
`pipeline_complete` card on already-shipped work. Fixing that is about re-run semantics for a
terminal task, not about this kind, so it is deliberately out of scope here.

## Where the pieces live

| Concern                        | File                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Kind id + role prompt          | `backend/packages/agents/src/agents/prompts/roles.ts`                           |
| Dispatch shape (registration)  | `backend/packages/agents/src/agents/kinds/built-in-container.ts`                |
| Task prompt + shape hint       | `backend/packages/agents/src/agents/prompts/built-in-container.ts`              |
| PR-head number resolution      | `backend/packages/server/src/agents/jobBody.ts`                                 |
| Coercion / revision / summary  | `backend/packages/orchestration/src/modules/estimation/estimate.logic.ts`       |
| Persisting it on the block     | `backend/packages/orchestration/src/modules/execution/dispatcher-registries.ts` |
| The shared "produces one" rule | `backend/packages/contracts/src/agent-gating.ts`                                |
| The record's shape             | `backend/packages/contracts/src/consensus.ts`                                   |
| The badge                      | `frontend/app/app/components/panels/inspector/TaskEstimateBadge.vue`            |
| The badge's basis labels       | `frontend/app/app/utils/estimateGating.ts`                                      |
| The no-pull-request skip       | `backend/packages/orchestration/src/modules/execution/stepPreamble.ts`          |
| The placement rule             | `backend/packages/orchestration/src/modules/pipelines/pipelineShape.ts`         |
| The skip reason's copy         | `frontend/app/app/utils/pipelineRender.ts`                                      |
