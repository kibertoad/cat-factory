---
'@cat-factory/server': patch
---

mothership: allow-list the bootstrap / reference-architecture / env-config-repair management surface

In mothership mode the repo-bootstrap flow and the env-config-repair retry/stop path were only
partially remotely callable over `/internal/persistence`: the board-load reads
(`bootstrapJobRepository.listByWorkspace`/`listByServices`, `envConfigRepairJobRepository.listByWorkspace`)
were exposed, but the single-job reads and the write methods the flows drive came back
`unknown_method`, so a mothership-mode SPA could list bootstrap/repair runs but not start a
bootstrap, poll a single job's card, retry a failed run, or stop a running one. This completes the
`AgentRunController` retry/stop surface for those two run kinds (the execution-run branch landed
earlier) and makes the bootstrap modal + reference-architecture library functional. It widens
`REMOTE_PERSISTENCE_METHODS`, each with a correct scope rule:

- `bootstrapJobRepository.get`/`update` — the board-card poll (`GET .../bootstrap/jobs/:id`) and the
  retry/stop patches. Workspace-scoped on arg0 (the `workspace` rule).
- `bootstrapJobRepository.insert` — the record-based start/retry write. Bound by the `workspaceField`
  rule on the job's `workspaceId` FIELD (the row is stored under — and later read by — that
  workspace). The record's sibling ids (`blockId`, `referenceArchitectureId`) are not re-validated
  over the RPC: a foreign `referenceArchitectureId` is harmless because the retry run re-resolves it
  via the workspace-scoped `referenceArchitectureRepository.get`, which 404s a cross-workspace id.
- `referenceArchitectureRepository.get`/`listByWorkspace`/`update`/`softDelete` — the reference-arch
  library the bootstrap modal reads + edits and that a retry re-resolves its base repo from.
  Workspace-scoped on arg0; the record-based `insert` binds on the record's `workspaceId` field.
- `envConfigRepairJobRepository.get`/`update` — the repair retry (reads the prior failed job before
  starting a fresh one) and stop (patches the running job). Workspace-scoped on arg0; `insert` binds
  on the job's `workspaceId` field.

Each method is member-level (none of the bootstrap / reference-arch / env-config-repair endpoints is
admin-gated) and workspace-scoped, matching the block/pipeline mutation policy. These are the
non-core repositories the Node/local facade routes through the `pickRepoSource` seam, which already
sources them from the full-surface remote registry when `db` is undefined — so this is an allow-list
change only, symmetric by construction (the dispatcher reflects over each facade's registry).
Round-trip + cross-account-scope + missing-workspaceId (fail-closed) unit tests for every new method
are in `packages/server/test/persistenceRpc.spec.ts`; the static drift guard
(`runtimes/node/test/mothership-allowlist.spec.ts`) moves them out of `pending` — the whole
`bootstrapJob` (bar the serviceId-keyed `listByService` + the `blockServiceId` helper),
`referenceArchitecture`, and `envConfigRepairJob` repos are now remote.
