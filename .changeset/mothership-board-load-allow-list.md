---
'@cat-factory/server': minor
---

Mothership mode (Phase 3 slice 1): widen the persistence-RPC allow-list to the workspace-scoped
board-load read surface. `PILOT_PERSISTENCE_METHODS` now exposes the reads a `GET /workspaces/:id`
snapshot assembles — `workspaceMountRepository.listByWorkspace`, `workspaceSettingsRepository.get`,
`mergePresetRepository.list`, `modelPresetRepository.list`, `serviceFragmentDefaultsRepository.get`,
`pipelineScheduleRepository.list`/`getByBlock`, `trackerSettingsRepository.get`,
`notificationRepository.listOpen`, `bootstrapJobRepository.listByWorkspace`,
`tokenUsageRepository.totalsSinceForWorkspace`, and the per-block reviews
(`requirementReviewRepository.getByBlock`, `clarityReviewRepository.getByBlock`,
`brainstormSessionRepository.getByBlockStage`).

Every newly-listed method takes the workspaceId as arg0, so they reuse the existing `workspace`
scope rule (resolve the owning account; reject anything outside the machine token's scope as 404).
Reads only — no new mutation is exposed, and the admin-gated mutations / global sweeper reads stay
excluded. No registry change was needed: the dispatcher already reflects over the full
`CoreDependencies` object, so allow-listing a method is enough. Round-trip + cross-account-scope
tests for every newly-listed method are in `packages/server/test/persistenceRpc.spec.ts`.

Still a DRAFT-gated initiative (see `docs/initiatives/mothership-mode.md`): the cross-service +
entity-id-keyed reads (which need a new scope kind), routing the direct-db stores through the
remote registry, and the fake-mothership integration test remain before the mothership boot can
ship.
