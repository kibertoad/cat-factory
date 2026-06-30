---
'@cat-factory/node-server': minor
'@cat-factory/server': minor
---

Mothership mode (Phase 3 slice 4): the fake-mothership functional integration test — the merge
gate's exit criteria — plus the agent-context run-path repo surface it surfaced.

New test `runtimes/local/test/mothership-integration.spec.ts` boots a stock Node mothership
(`buildNodeContainer` over real Postgres) on a 127.0.0.1 loopback and a no-Postgres mothership-mode
`buildLocalContainer` whose `CoreRepositories` are the RPC-backed remote registry pointing at it,
then asserts the two things the build-only tests can't: a board **loads** over the remote
persistence RPC, and a run **drives to a persisted terminal state** (`done`) over it, with the
execution read back straight from the mothership's Postgres. Only the agent executor is faked; the
whole persistence path is real, so an un-allow-listed method, a mis-scoped call, or an unrouted
direct-db store fails the test instead of a developer's first board load.

Standing it up surfaced that `AgentContextBuilder` resolves a block's linked docs/tasks and its
provisioned environment on EVERY agent dispatch — so those feature-flagged sub-helper repos are on
the board-load + run path, not off it as previously assumed. Fixes:

- `@cat-factory/node-server`: in mothership mode (`db` undefined) route the context-builder
  run-path repos — `documentRepository`, `taskRepository`, `environmentRegistryRepository` /
  `environmentConnectionRepository` — from the remote registry (the sub-helpers built them directly
  over the absent `db`). Their connect/provision surfaces stay db-direct (off the run path).
- `@cat-factory/server`: widen `PILOT_PERSISTENCE_METHODS` to the run/board methods the path
  exercises, each workspace-scoped: `documentRepository.{listByBlock,get,getByUrl}`,
  `taskRepository.{listByBlock,get,getByUrl}`, `environmentRegistryRepository.{getByBlock,get}`, the
  run-start `modelPresetRepository.getDefault`, the board-load lazy default-preset seeds
  `mergePresetRepository.upsert` / `modelPresetRepository.upsert`, and the completion notification
  raise + inbox transitions `notificationRepository.{findOpenByBlock,upsertOpenForBlock,upsert}`.
  (`*.getByUrl` resolves a URL named in a block's description, and `notificationRepository.upsert`
  backs block-less raises + inbox act/dismiss/escalate — both squarely on the same run/post-run
  path as the reads they sit next to, so omitting them would fail any task whose description
  contains a link, or any inbox action after a run.) Round-trip + cross-account-scope unit tests
  for each are added to `persistenceRpc.spec.ts`, and the integration test patches a task with a
  URL + Jira/GitHub refs and enables the environment integration so these reads round-trip over the
  RPC end-to-end (not just in the unit suite).

Still DRAFT-gated (`docs/initiatives/mothership-mode.md`): decrypting a remotely-sealed provisioned
environment's access cipher needs the mothership's key (a later secrets-delegation slice); the
kaizen-grading, LLM-metric and subscription-activation calls a run also makes degrade as best-effort
no-ops over the remote (telemetry is Phase 5 local-first; activation is the local-sqlite bucket); and
the remaining sub-helper surfaces (fragments / slack connect/provision) are follow-ups.
