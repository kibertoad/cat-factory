---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': patch
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Judges: a registry seam for deployment-authored rubric evaluators that can block or bounce a run.

Three engine paths already shared one shape — an LLM produces a structured assessment, the engine
compares it to a per-task threshold, and the run advances, parks or escalates (requirements
auto-pass, the `merger`, `on-call`). That latent "verdict gate" family is now promoted into a
**fourth step-taxonomy bucket**: agents / polling gates / one-shot engine steps / **judges**.

A judge step runs an LLM assessment of the run's work against a **rubric**, and the engine
compares the verdict's score to the task's merge preset before disposing: advance, park for a
human, **bounce** the producing step with the findings as its rework brief, or fail the run.
Adding one is a registry entry, not a copy of the machinery — the same promise `registerGate`
makes for polling gates.

- **`JudgeRegistry`** (`@cat-factory/kernel`, app-owned + empty by default) threaded through
  `CoreDependencies.judgeRegistry` beside `gateRegistry`. A registration supplies only its
  differentiators: the rubric, an optional `parseVerdict`, `threshold`/`attemptBudget` read off
  the preset, `onFail` (`park` / `bounce` / `fail`) and `bounceTargets`.
- **One generic driver** in the engine owns the state machine, threshold comparison, park,
  bounce budget, persistence and emission. All live state rides `step.judge` — no side table, so
  it is runtime-symmetric by construction.
- **No per-facade wiring**: the verdict producer is an injectable `JudgeAssessor` whose default
  is built from the model-provider dependencies every facade already wires. An
  absent/disabled assessor makes every judge step a **pass-through**, so existing pipelines are
  byte-for-byte unchanged.
- Two new merge-preset knobs, `judgeMinScore` (default 0.7) and `judgeMaxBounces` (default 1),
  mirrored D1 ⇄ Drizzle. The built-in presets' seed version bumps to 5, so existing workspaces
  are advised to reseed.
- A rubric's per-workspace override is an ordinary **prompt-library fragment**
  (`JudgeRubric.fragmentId`), so the feature adds no rubric storage.
- The verdict is a first-class section of the **PR verification report**, rendered through the
  `hostMarkdown` helpers and scrubbed like every other model-authored field.
- A parked verdict is answerable from the SPA's new judge window **and** from
  `POST /api/v1/runs/:runId/decisions/judge/resolve` — both call the same service method.
- `validateRegistrations` accepts the `judgeRegistry`: a judge kind counts as a legal pipeline
  step, its `presentation.resultView` is checked like an agent kind's, and a judge kind that
  collides with a gate kind is a boot error (the gate handler would silently claim the step).
- A judge's deployment-default model is its own `CoreDependencies.judgeModel` /
  `judgeResolveModel`, falling back to the inline reviewers' — the fallback is what keeps
  "no per-facade wiring" true; the named deps are so the answer is in the dependency contract.

Also adds `GATE_CLEARED_NOTIFICATION_TYPES` to `@cat-factory/contracts` — the shared list of
auto-raised parking cards the engine dismisses once a run advances past the park it raised them
for. `NotificationService.clearWaitingDecision` now iterates that contract instead of a
hard-coded literal, so a new parking surface cannot be added to the notification union while
staying invisible to the clear (which left an answered card open for the escalation sweep to
flip red as "Overdue").

The `merger` is deliberately NOT rewritten onto this: it owns terminal block status and a real,
credential-bearing merge, and stays a privileged built-in. See
`docs/initiatives/judge-registry.md`.
