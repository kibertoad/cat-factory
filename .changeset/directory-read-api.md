---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/workspaces': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': patch
---

`/api/v1/directory/*`: an account's workspaces, users, account memberships, workspace memberships
and linked repositories as keyset-paged snapshots, plus an ordered change feed whose changes carry
each entity's current state (or `null` once it is gone), for an integration keeping its own copy in
sync. A feed cursor older than the new `DIRECTORY_CHANGE_RETENTION_DAYS` (default 30) is refused
with the new `cursor_expired` conflict reason. OpenAPI 1.81.0.

Internal: the change-row mapping both facades share moves to kernel's `directoryChangeFromRow`.
The slice 1 `DirectoryChangeRepository` port becomes `DirectoryRepository` and joins
`CoreDependencies` as a required member, with its reads on the mothership allow-list.
