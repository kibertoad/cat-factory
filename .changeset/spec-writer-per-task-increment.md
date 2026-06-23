---
'@cat-factory/executor-harness': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
---

Spec-writer now applies ONE task's requirements as an increment, not a service-wide aggregate.

The spec-writer used to receive `serviceTasks` — every task under the block's service
frame, merged or not — and fold them all into one document. So a run for a single task
("add CRUD for office tables") produced a spec covering five unrelated sibling resources,
and the spec-reviewer correctly read it as scope contamination. That violates the
branched-work model: a task's baseline is what's already merged, plus its own increment;
an unmerged sibling task does not exist for it.

The spec-writer now reads the spec already committed on its work branch (the baseline)
and applies ONLY the current task's clarified/reworked requirements as an increment —
adding what the task introduces and adjusting existing requirements only where the task
changes their behaviour. It translates the given requirements and does not invent or fill
gaps (that is the requirements step's job). The in-repo `spec.json` stays the complete
service spec; only the writer's editing scope narrows.

- Engine: removed `gatherServiceTasks` and the `serviceTasks` field from
  `AgentRunContext`. The dispatch feeds the single task (the block, whose description is
  already the reworked requirements).
- Reviewer: the `spec-companion` now judges fidelity to the requirements it was given and
  no longer penalises the writer for requirements it was never handed.
- Harness (`SpecJob.tasks` → `SpecJob.task`): the prompt is reframed as "baseline plus
  this task's increment". Image retagged 1.6.0 → 1.7.0 (deploy/backend `image:publish` +
  wrangler.toml) so the new digest rolls out.

Breaking: the `/spec` harness job shape changes (`tasks: []` → `task: {}`) and
`AgentRunContext.serviceTasks` is gone. No migration — stale in-flight jobs simply break.
