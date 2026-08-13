---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/conformance': minor
'@cat-factory/local-server': patch
---

Stop a refused work-branch push from failing a run whose work is already on the branch.

The harness checkpoint-pushes the agent's commits every 60s so an evicted container's work
survives, which makes it its own competing writer: a commit is published within a minute of being
made, the agent cannot see that from inside the container, and amending it afterwards is ordinary
git hygiene (the delivery contract even asks it to validate AFTER committing, which is exactly the
sequence that produces an amend). The final push was then refused as a non-fast-forward and the
whole run failed with a complete scaffold sitting on the branch.

Every push after the first now carries `--force-with-lease` against the sha THIS pass published,
read back from its own remote-tracking ref. That is the whole discrimination: the run's own rewrite
lands, and a second writer's commits (a concurrent dispatch, a person) still refuse the push as
`(stale info)`, which is the "never clobber another run's work" property the resume design leans
on. A tip the run merely CLONED is never leased against, so a rewrite of an earlier run's published
commits is refused rather than forced away.

A refused push is no longer a generic `git` fault. It reports the new `branch-contended` failure
cause, and the engine recovers by re-dispatching the step once (`MAX_BRANCH_CONTENTION_RECOVERIES`,
recorded on `PipelineStep.branchContentionRecoveries`): the fresh dispatch resumes the branch as it
now stands, so the agent continues on top of whatever is on it. Past the budget the run fails with
a remedy naming which of the two causes it was, rather than git's own "use `git pull`" hint, which
is advice for a person at a terminal.

The `build` prompt bumps to v6 with the matching half of the rule stated to the agent: add commits,
never rewrite them.

Also fixes a git failure printing its stderr twice (`execFile` already folds it into the rejection
message), which made one refused push read as two attempts.
