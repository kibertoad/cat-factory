---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/integrations': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
---

PR deep-review: park a review run on its findings for a human to select which to act on.

The read-only `pr-reviewer` no longer finishes a review task the moment it returns. Its
sliced, prioritized findings are now recorded onto the run's `pr-reviewer` step
(`step.prReview`) and the run PARKS for a human to visually SELECT which findings matter
through a dedicated multi-select window (findings grouped by slice, severity badges), then
resolve. A `pr_review_ready` inbox card (routable to Slack) is raised on park. A clean PR
(no findings) passes through and finishes as before.

All review state rides the step (no side table), so D1 ⇄ Drizzle parity is free; a
cross-runtime conformance assertion covers the park → select → resolve loop. The two
terminal resolutions — feed the selected findings to a Fixer, or post them as inline PR
review comments — are the tracked follow-up; this ships the slicing → park → multi-select
loop with a neutral `finish` resolution.
