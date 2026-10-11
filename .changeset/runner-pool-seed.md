---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
---

A deployment can declare its runner pool once with `seedRunnerPool` on `start()` or `startLocal()`:
the same `{ config, secrets }` an admin submits through Infrastructure → Runner pool. The server
registers it on every existing workspace at boot and on each new one, and never replaces a pool a
workspace already has. On stock Node, where a runner pool is the only executor, a new board can then
run an agent with no Infrastructure step.

It is the third declared seed beside `seedEnvironmentHandlers` and `seedSharedStacks`, on the same
seam: a kernel `RunnerPoolSeeder` port, `createRunnerPoolSeeder` in `@cat-factory/integrations`
built beside the runners module, the `WorkspaceService.create` hook, and the shared boot backfill.
A failed registration is logged and skipped, and the next boot retries it. `RunnerPoolSeed` and
`RunnerBackendConfig` are re-exported from both runtimes for a deployment wrapper to type the seed.
The Worker does not take the option: there a pool is an optional target beside the built-in
containers.
