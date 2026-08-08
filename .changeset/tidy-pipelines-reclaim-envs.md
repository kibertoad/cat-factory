---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': patch
'@cat-factory/agents': patch
---

Refuse a pipeline whose environment lifecycle does not add up when it is saved: a tester /
acceptance / human-test step with no `deployer` before it, a `deployer` with no `disposer` after it,
or a `disposer` with nothing before it to reclaim. The rule is enforced at pipeline create and
update only, so a stored pipeline authored before it keeps running; the builder shows the same
faults inline while a draft is being composed, off the one shared rule in `@cat-factory/contracts`.

Every built-in preset that deploys now ends with a terminal `disposer` (`pl_build`, `pl_simple`,
`pl_full`, `pl_visual`, `pl_frontend`, `pl_tech_debt`), each with a version bump so seeded
workspaces are offered the reseed. A workspace that wants its environment to outlive the run (to
poke at the live URL until the TTL sweep takes it) clones the preset and drops the Disposer.
