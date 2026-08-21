---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Assess a task AFTER the work landed: the `task-reassessor` agent kind.

A task's complexity / risk / impact ratings were a forecast, made before anyone had written a line,
and nothing ever revisited them. A pipeline with no `task-estimator` (Simple build, the bug-fix
presets) had no ratings at all, and a forecast that turned out to be badly wrong left no trace of
having been wrong.

`task-reassessor` is the estimator's retrospective twin: a read-only container step that reads the
change the run actually made and scores the same three axes against it. Placed after the coder it
either corrects the forecast or produces the first ratings the task ever had, which are the two
cases this change exists for. It ships in NO preset (it costs a container run per task) and is
estimate-gatable, so the usual configuration is "measure what the forecast called large".

It is a KIND rather than a mode of the estimator, and the deciding reason is not taste: the
estimator is inline by construction (`INLINE_ENGINE_KINDS`, which the preset-satisfiability guard
keys off, so an inline step must resolve to an inline-usable model) and this one needs a checkout to
diff. One kind cannot be classified both ways, and either answer is wrong for half its uses. The
full argument, and the three secondary reasons, are in `backend/docs/task-assessment.md`.

Behaviour changes worth knowing:

- **`TaskEstimate` now says what it was formed on.** `basis` (`predicted` / `observed`) plus the last
  reading of the OTHER basis in `supersedes`, which a same-basis re-run inherits rather than
  overwrites, so a retried measurement cannot delete the forecast it is being compared against.
  Both are OPTIONAL on the type
  rather than defaulted into it, because the estimate is stored as a JSON blob read back with no
  schema pass: a row written before this change genuinely carries no basis, and absence reads as
  `predicted` (every one of those rows came from the estimator). A basis this build cannot name
  renders as unrecognised rather than being guessed onto a current member.
- **An estimate gate's prerequisite is now "a step that PRODUCES an estimate runs earlier"**, not
  "a `task-estimator` runs earlier". One `producesTaskEstimate` predicate in
  `@cat-factory/contracts`, read by the engine's validation, the SPA's pipeline-health advisory and
  the builder's draft warning, which each carried their own copy of the kind id.
- **`clone.prHead` now names WHICH pull request it fetches**, with a new `prHeadSource` field:
  `task` (the default, the `pr-reviewer`'s declared target, unchanged) or `run` (the PR this run
  opened, the assessor's subject). Declared rather than resolved by a `task ?? run` precedence,
  which would have silently widened the reviewer: a review task whose run also opened a pull request
  would start prefetching a head its review state knows nothing about.
- **`requirePr` now means two things, split by whether the kind writes on the pull request or reads
  it.** A WRITER (the in-place fixers) still refuses the dispatch, because cloning base would push
  its commits onto the default branch. A READER is SKIPPED before dispatch with a new
  `no_pull_request` step-skip reason: a base checkout holds nothing to measure, and failing would
  end a run whose work has already shipped over a reading nothing gates on. New copy in all ten
  locales.
- **A pipeline may no longer place a PR-reading step ahead of the step that opens the PR**
  (`assertValidPullRequestReaders`, refused at save and at run start). It would be skipped for want
  of a pull request the very next step creates. No stored pipeline predates the rule.
- **A block's terminal status now survives a trailing step that claims none.** `merger → assessor →
disposer` used to write `in_progress` over the merger's `done`, leaving `finalizeBlock`'s merger
  backstop to record a merged task as `pr_ready`. `settleStepAndAdvance` reads the block's own
  status rather than trusting the settling resolver's return value, which fixes the same latent bug
  for any future step placed after the merger.
- **The estimate badge states which reading it shows**, names the reading it replaced, and shows the
  earlier number beside each axis that actually MOVED. New `inspector.estimate.basis.*` and
  `supersededBasis` copy in all ten locales.

The step records NOTHING when its reply cannot be read, and the run CONTINUES: it returns PROSE
rather than declaring a structured output like its `merger` / `on-call` neighbours, because for a
structured explore kind the harness makes an unparseable reply a job failure. That is right for a
merger with a merge to decide and wrong for a step that runs after the change shipped, where it
would let a missing brace block a merge-ready pull request (or re-open a task already `done`). The
trade is the structured repair pass; the tolerant parse the inline estimator already uses is what
makes it cheap.
