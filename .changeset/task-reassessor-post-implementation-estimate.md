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

- **`TaskEstimate` now says what it was formed on.** `basis` (`predicted` / `observed`) plus, when a
  measurement replaced a forecast, that forecast in `supersedes`. Both are OPTIONAL on the type
  rather than defaulted into it, because the estimate is stored as a JSON blob read back with no
  schema pass: a row written before this change genuinely carries no basis, and absence reads as
  `predicted` (every one of those rows came from the estimator). A basis this build cannot name
  renders as unrecognised rather than being guessed onto a current member.
- **An estimate gate's prerequisite is now "a step that PRODUCES an estimate runs earlier"**, not
  "a `task-estimator` runs earlier". One `producesTaskEstimate` predicate in
  `@cat-factory/contracts`, read by the engine's validation, the SPA's pipeline-health advisory and
  the builder's draft warning, which each carried their own copy of the kind id.
- **`clone.prHead` resolves a second source, and `requirePr` now binds the explore surface.** The
  prefetched pull request is the task's declared target (a `review` task's, unchanged) or, failing
  that, the PR this run opened. A `prHead` kind that declares `requirePr` and resolves neither
  REFUSES the dispatch instead of quietly reading a base checkout, which for an assessor would mean
  scoring an empty diff as a trivial change.
- **The estimate badge states which reading it shows**, and shows the superseded forecast beside
  each axis. New `inspector.estimate.basis.*` copy in all ten locales.

The step records NOTHING when its reply cannot be read, leaving the forecast standing. That is why
it declares no `mapStructuredResult`, unlike its `merger` / `on-call` neighbours: their channels
default a garbage score to maximally severe because the ENGINE acts on it, while a fabricated
measurement here would silently move every gate that reads the estimate.
