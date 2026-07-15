---
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
---

feat(spike): timeboxed research spike tasks — kind, pipeline, findings document, no-PR completion

Spike tasks now run as a real timeboxed investigation that produces a findings document
instead of falling through to a full code-and-PR build:

- A built-in read-only `spike` agent kind (`container-explore`, structured findings + a prose
  `summary`, opened in the `generic-structured` result view). Its backend post-op renders the
  findings to `docs/research/<slug>.md` (honouring `taskTypeFields.targetPath`) and commits them
  straight onto the base branch via the checkout-free `RepoFiles` port — no PR, no harness change.
- A seeded `pl_spike` pipeline (`requirements-review`(off by default) → `spike`) and a
  `spike → pl_spike` task-type default, so a spike no longer dispatches a coder + merge tail.
- A no-PR completion path in the engine: a task run that opened no pull requests now finishes
  `done` (like a frame-level run) instead of stalling at `pr_ready` behind a `pipeline_complete`
  notification whose confirm threw `no_pr_to_merge`. This benefits every PR-less pipeline.
- Spike creation collects research criteria (research question, success criteria, options to
  compare) alongside the time-box; all are folded into the spike prompt (the time-box as a
  scope-discipline directive). New copy is translated across all locales.

A repo-less spike (GitHub unwired, or a docs-only spike) settles on `step.custom` — the findings
render is skipped rather than failing the run.
