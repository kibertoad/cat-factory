---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/workspaces': patch
'@cat-factory/server': minor
'@cat-factory/agents': patch
'@cat-factory/integrations': patch
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': patch
---

Add projects: account-owned peers of services, mounted onto boards and holding tasks under a
`project` root block. A deployment registers project kinds on the new `ProjectKindRegistry`
(`projectKindRegistry` on `start()`, `startLocal()` and the Worker overrides); a kind decides
which task types a project takes. New workspace routes create a project, link it to services,
and mount or unmount it; the board snapshot carries `projectCatalog` and `projectKinds`.

Internal breaks: `WorkspaceMount` gains a required `subjectKind`, `blockTypeSchema` and
`blockLevelSchema` gain `project`, and the public, blueprint and fragment surfaces now take
`serviceFrameTypeSchema` (the same values they accepted before). Migrations add the `projects`
and `project_service_links` tables and `workspace_mounts.subject_kind` on D1 (`0114_projects.sql`)
and Postgres.

The workspace-delete re-home plan now keeps only subjects in the board's own account and mounted
on it, so deleting a seeded board can no longer re-home another board's service that shares a
frame id.
