---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/workspaces': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
---

Generalize the board mount and the block and run owner stamp from services to mounted subjects,
ahead of projects. Internal break, with no behaviour change:

- `WorkspaceMount.serviceId` is now `subjectId`, on the internal board snapshot and the mount
  routes. The SPA ships with the same release.
- The `workspace_services` table is now `workspace_mounts` (`service_id` to `subject_id`), and
  `blocks.service_id` and `agent_runs.service_id` are now `owner_id`. Migrations rename them in
  place on D1 (`0113_mount_subjects.sql`) and Postgres.
- Kernel ports: `BlockRepository.listByOwners`/`setOwner`/`insert(…, ownerId)` and
  `findById(s)`'s `ownerId`, `ExecutionRepository.listByOwners`,
  `BootstrapJobRepository.listByOwners`, `WorkspaceMountRepository.listBySubjectIds`/
  `countBySubjectIds`/`removeBySubjects`, and `MountRehome` (was `ServiceRehome`).
- Mothership mode: these port methods are the `/internal/persistence` method names, and the mount
  record's `subjectId` is what the `serviceMount` scope rule reads, so a node and its mothership
  must run the same build. A node one build behind gets `unknown_method` on every board that
  mounts a service, and its mount writes are refused. Update the nodes together with the
  mothership.
