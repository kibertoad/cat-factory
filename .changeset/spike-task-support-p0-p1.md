---
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/gitlab': minor
'@cat-factory/app': minor
---

feat(spike): timeboxed research spike tasks — kind, pipeline, findings document, PR + review delivery

Spike tasks now run as a real timeboxed investigation that produces a findings document
instead of falling through to a full code-and-PR build:

- A built-in read-only `spike` agent kind (`container-explore`, structured findings + a prose
  `summary`, opened in the `generic-structured` result view). Its backend post-op renders the
  findings to `docs/research/<slug>.md` (honouring `taskTypeFields.targetPath`) via the
  checkout-free `RepoFiles` port — no harness change.
- Findings are delivered as a PULL REQUEST by default (`pl_spike`: `requirements-review`(off) →
  `spike` → `conflicts` → `ci` → `human-review` → `merger`): the post-op commits to a work branch
  and opens a PR that the review/merge tail lands, so protected base branches are respected and
  review comments are handled by the existing `human-review` gate + `fixer`. A `pl_spike_direct`
  pipeline keeps the fast, no-PR path (commit straight to base) for unprotected repos. `spike →
pl_spike` is the task-type default, so a spike no longer dispatches a coder.
- New reusable engine seam: a `RepoOp` may open a pull request and return its ref, which the
  engine records as `block.pullRequest` (the same linkage a container-coding step produces), so a
  deterministic backend-rendered artifact can flow through the normal conflicts/CI/human-review/
  merge tail. `RepoFiles.openPullRequest` (and the underlying `GitHubClient`/`VcsClient` ports)
  now return the PR web `url` (`OpenedPullRequest`), provider-agnostically.
- A no-PR completion path in the engine: a task run that opened no pull requests now finishes
  `done` (like a frame-level run) instead of stalling at `pr_ready` behind a `pipeline_complete`
  notification whose confirm threw `no_pr_to_merge`. This benefits every PR-less pipeline.
- Spike creation collects research criteria (research question, success criteria, options to
  compare, target path) alongside the time-box; all are folded into the spike prompt (the
  time-box as a scope-discipline directive). New copy is translated across all locales.

A repo-less spike (GitHub unwired, or a docs-only spike) settles on `step.custom` — the findings
render is skipped rather than failing the run; a rejected direct commit is best-effort (the
findings already live on the step), while a PR-mode open failure is surfaced.
