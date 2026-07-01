---
'@cat-factory/server': patch
'@cat-factory/node-server': patch
'@cat-factory/worker': patch
---

Mothership mode: allow-list `agentRunRepository.getRef`, so the board's run controls (retry /
stop a failed or running run) are functional for execution runs in a no-Postgres mothership-mode
local node.

Wiring fix (both facades): `agentRunRepository` is the one repo surfaced on the container OUTSIDE
`CoreDependencies`, so the mothership `repositories` registry (`ServerContainer.repositories`,
reflected by `/internal/persistence`) was built from `dependencies` alone and did not carry it —
a remote `getRef` call came back `Repository 'agentRunRepository.getRef' is not wired`. Both
`buildNodeContainer` and the Cloudflare `buildContainer` now fold it into the registry explicitly,
so either facade acting as a mothership serves the retry/stop `getRef` read.

`AgentRunController` (`POST /workspaces/:ws/agent-runs/:id/{retry,stop}`) resolves a run's KIND via
`agentRunRepository.getRef(workspaceId, id)` before dispatching to the matching service. That read
was the last thing on the execution-run retry/stop path still coming back `unknown_method` over
`/internal/persistence`. It is now allow-listed, workspace-scoped on arg0 (reusing the existing
`workspace` rule — resolve the owning account, reject out-of-scope as 404). Every downstream
read+write the execution retry/stop services make (`executionRepository.get`/`deleteByBlock`/
`upsert`/`markFailed`, `blockRepository.update`, `pipelineRepository.get`, the budget/binary-storage
prechecks) was already exposed on the run/start path, so `getRef` is the only new entry.

The bootstrap + env-config-repair retry BRANCHES read their own repos (`bootstrapJobRepository.get`,
`referenceArchitectureRepository.get`, …) and stay `pending` — a later slice. The sweeper-only
`agentRunRepository.listStale`/`liveRunIds` stay mothership-internal.

Server-only allow-list change, symmetric by construction (the dispatcher reflects over each facade's
registry). Round-trip + cross-account-scope + off-allow-list unit tests cover it; the static
allow-list drift guard moves `getRef` out of `pending`; and the fake-mothership integration test
asserts the retry endpoint resolves a run's kind over the real RPC and 404s an unknown run id.
