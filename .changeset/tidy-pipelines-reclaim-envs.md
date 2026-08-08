---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': patch
'@cat-factory/agents': patch
---

Refuse a pipeline whose environment lifecycle does not add up when it is saved: a tester /
acceptance / human-test step with no live environment to run against (nothing provisioned one, or
the `disposer` reclaimed it first), a `deployer` that neither reclaims nor declares that its
environment outlives the run, or a `disposer` with nothing standing to reclaim. The rule is
enforced at pipeline create and update only, so a stored pipeline authored before it keeps running;
the builder shows the same faults inline off the one shared rule in `@cat-factory/contracts`, and
the run door now reads that same rule for the two faults that would genuinely dead-end a run,
rather than re-deriving the ordering beside it.

An environment that is MEANT to outlive its run stays expressible: the deployer step declares it
(`stepOptions.retainEnvironment`), which is also what lets the PR verification report render the
teardown leg as `retained` instead of a `pending` reclaim that is never coming. That adds one enum
value to the report's `teardown` field on `/api/v1` (spec 1.35.0, additive).

Every built-in preset that deploys now ends with a terminal `disposer` (`pl_build`, `pl_simple`,
`pl_full`, `pl_visual`, `pl_frontend`, `pl_tech_debt`), each with a version bump so seeded
workspaces are offered the reseed.
