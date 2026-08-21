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
  arithmetic (`summarizeEstimate`). One level deep, so a twice-measured task keeps its current
  scores and the ones immediately before them rather than growing a chain on a board row.

`reviseTaskEstimate` supersedes nothing when the basis is UNCHANGED: two consecutive forecasts are
one forecast revised, and recording the earlier one would render a prediction/measurement comparison
that never happened.

## The dispatch shape, and the two refusals

`clone: { branch: 'base', full: true, prHead: true, requirePr: true }`, which is the `pr-reviewer`'s
shape rather than the `merger`'s, for one reason: **a merge deletes the pull request's branch, and
`refs/pull/<n>/head` outlives it.** A `pr` clone would work for a step running before the merge and
fail for the same step running after it. The harness fetches that ref into `origin/pr-head`
(GitHub) / the GitLab equivalent, and the prompt diffs `origin/<base>...origin/pr-head`.

`resolvePrefetchPrNumber` (`@cat-factory/server`'s `agents/jobBody.ts`) resolves the number from the
task's own declared PR fields (a `review` task's target, which is what the `pr-reviewer` wants) and
falls back to the pull request THIS RUN opened, which is what this kind wants. The task's
declaration wins; the two never compete for one dispatch, because a review task's run opens no PR.

Two things refuse rather than degrade:

- **No pull request at all ⇒ the DISPATCH is refused** (`requirePr`, now honoured on the explore
  surface too). A base checkout holds nothing to measure, and scoring it as though it were the
  change is worse than a failed step: it lands a fabricated measurement over a real forecast.
- **An unreadable reply ⇒ NOTHING is recorded.** The kind declares no `mapStructuredResult`, unlike
  its neighbours `merger` and `on-call`: their channels exist because the engine ACTS on the reply,
  which is why a garbage score there defaults to maximally severe. This one only RECORDS, so the
  cautious reading is to record nothing, keep the raw reply on the step, and leave the estimate the
  task already had. A defaulted 1/1/1 persisted as a measurement would silently move every gate
  that reads the estimate.

## Placement rules

- **After the producer**, since it needs the pull request. `assertValidGating`'s prerequisite is
  satisfied by EITHER producer (`producesTaskEstimate` in `@cat-factory/contracts`, read by the
  engine, the SPA's pipeline-health advisory and the builder's draft warning alike), because the
  rule is about the estimate FIELD being populated, not about which agent populated it.
- **Gatable, and shipped in no preset.** It costs a read-only container run per task, and the task a
  forecast put at the bottom of every axis is the one least worth measuring, so gating it is the
  usual configuration. No built-in pipeline carries the step: adding it is a builder decision.
- **After the `merger` is legitimate, and is the strongest placement**: the change has landed for
  real, and the engine already supports a trailing step there (the merger's resolver owns the
  block's terminal status, so `refreshBlockProgress` moves the bar without downgrading `done`,
  exactly as it does for the `disposer`). `refs/pull/<n>/head` is why the diff is still readable
  once the branch is gone.
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
