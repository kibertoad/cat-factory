---
'@cat-factory/contracts': minor
'@cat-factory/orchestration': minor
'@cat-factory/app': minor
'@cat-factory/kernel': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Service-level default test environment. A service frame now carries a
`defaultTestEnvironment` (docker-compose **local** vs **ephemeral**) that a task is
spawned with; each task can still override it per-task via its `tester.environment`
agent config. The engine resolves the effective environment at run time (task pin →
service default → built-in `ephemeral`) and materialises it onto the run context, so
the Tester job body, the prompt and the start-time infra gate all agree. Set the
default in the service inspector's Test infrastructure panel; the task inspector shows
the inherited value and labels it "inherited from service" until overridden.

The cloud-provider and instance-size controls are now explained as **hints for
ephemeral-environment provisioning** and tucked into a collapsed-by-default section.

Persisted on both runtimes (D1 migration `0009_default_test_environment` ⇄ Drizzle
`default_test_environment` column); the cross-runtime conformance suite asserts the
inheritance + per-task override on each.
