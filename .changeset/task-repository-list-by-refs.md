---
'@cat-factory/kernel': patch
'@cat-factory/integrations': patch
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
---

Fix the N+1 in linked-context resolution: `AgentContextBuilder` batch-resolves the tracker
issues a task's description names explicitly via a new `TaskRepository.listByRefs` port
method (one chunked-`IN` read per source, keyed by `(source, externalId)` refs) instead of a
`taskRepo.get` point-read per reference inside `Promise.all`. Implemented on both facades (D1
`D1TaskRepository` ⇄ Drizzle `DrizzleTaskRepository`) with a cross-runtime conformance
assertion. The `'jira'`/`'github'` source literals are de-hardcoded out of the engine into
`extractReferences`' typed `taskRefs`, the single place a reference shape binds to a task
source.

The new port method is also added to the mothership persistence-RPC allow-list
(`@cat-factory/server`), since `AgentContextBuilder` invokes `listByRefs` on every
container-agent dispatch — without the entry a no-Postgres mothership node fails every run
with `unknown_method`.
