---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/agents': minor
'@cat-factory/server': minor
'@cat-factory/observability-otel': minor
'@cat-factory/conformance': minor
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
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
which is the sha the push itself named: `pushBranch` pushes `<sha>:refs/heads/<branch>` and returns
it, rather than reading `refs/remotes/origin/<branch>` back afterwards, which a fresh coding run's
single-branch clone never creates. That is the whole discrimination: the run's own rewrite lands, and
a second writer's commits (a concurrent dispatch, a person) still refuse the push as `(stale info)`,
which is the "never clobber another run's work" property the resume design leans on.

The lease is withheld entirely unless the branch still contains the tip this pass started from
(`workBranchLease`), because the lease alone does not bound the force to this pass's own commits: a
resumed run that had already landed one checkpoint would otherwise force over the commits it
resumed from and take an earlier run's work with them.

A refused push is no longer a generic `git` fault. It reports the new `branch-contended` failure
cause, and the engine recovers by re-dispatching the step once (`MAX_BRANCH_CONTENTION_RECOVERIES`,
recorded on `PipelineStep.branchContentionRecoveries` and projected by the debug API): the fresh
dispatch resumes the branch as it now stands, so the agent continues on top of whatever is on it.
Past the budget the run fails with a remedy naming which of the two causes it was, rather than git's
own "use `git pull`" hint, which is advice for a person at a terminal. Each refusal also increments
the new `container.branch_contended` operational counter, since a re-dispatch that a run reports as
a clean success is invisible per run and costs a whole agent run twice.

The checkpoint also stops re-pushing an unchanged branch. Its gate was "the branch advanced past the
pre-run tip", which stays true forever once it has, so every tick issued a push: an hour-long run
that commits eight times spent ~60 authenticated round trips, ~52 of them answering "Everything
up-to-date" and each counting against the host's push rate limits. It now pushes only an
UNPUBLISHED tip, which makes the interval a loss window rather than a rate (one push per commit the
agent makes, whatever the model or the run's length) and leaves the durability guarantee unchanged.

The `build` prompt bumps to v6 with the matching half of the rule stated to the agent: add commits,
never rewrite them.

`/api/v1/debug/runs/:runId` gains `branchContentionRecoveries` per step (OpenAPI 1.52.0, additive):
a run that recovered reports as an ordinary success, so nothing else tells a post-mortem that one
agent pass was paid for twice.

Also fixes a git failure printing its stderr twice (`execFile` already folds it into the rejection
message), which made one refused push read as two attempts.
