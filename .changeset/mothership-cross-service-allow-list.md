---
'@cat-factory/server': minor
---

Mothership mode (Phase 3 slice 2): widen the persistence-RPC allow-list to the cross-service
entity-id-keyed board-composition reads, via two new scope kinds that resolve the entity's owning
account server-side before the scope check.

- `serviceList` (arg0 = `serviceIds[]`): resolve each service's owning account; EVERY requested id
  must be in scope (a missing or out-of-scope service fails closed as 404); an empty list is a
  no-op read that binds no service. Exposes `serviceRepository.listByIds`,
  `blockRepository.listByServices`, `executionRepository.listByServices`,
  `bootstrapJobRepository.listByServices`, `pipelineScheduleRepository.listByServices`, and
  `workspaceMountRepository.countByServiceIds`.
- `block` (arg0 = blockId, no workspace arg): resolve the block's home workspace, then that
  workspace's account. Exposes `blockRepository.findById`.
- `serviceRepository.listByAccount` reuses the existing `account` rule, so the `null` (auth-disabled,
  unscoped) org listing is refused over a scoped machine token.

The two resolvers (`resolveBlockAccountId`, `resolveServiceAccountIds`) are wired in
`PersistenceController` and the dispatcher fails closed when a kind's resolver is absent. Round-trip,
cross-account-scope, unknown-id, and empty-list tests for every newly-listed method are in
`packages/server/test/persistenceRpc.spec.ts`.

`subscriptionActivationRepository.deleteByExecution` is deliberately NOT exposed: per the per-repo
bucket checklist it is the local-sqlite bucket, not the remote surface.

Still a DRAFT-gated initiative (see `docs/initiatives/mothership-mode.md`): routing the direct-db
stores through the remote registry when `db` is undefined, and the fake-mothership integration test,
remain before the mothership boot can ship.
