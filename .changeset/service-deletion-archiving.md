---
'@cat-factory/kernel': patch
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/workspaces': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
---

Share services across boards, archive services with unfinished tasks, and stop board deletion from
orphaning or destroying shared services.

- **Importing a repo that already backs an org service now MOUNTS the shared service** onto the
  current board (one shared subtree + task list) instead of failing with "already linked". Two teams
  in one organization can therefore work on the same service. Re-adding a repo already on the board
  is an idempotent no-op; a repo whose service lives on another board becomes addable (it mounts).
- **Deleting a board no longer destroys a service another board still mounts.** The delete cascade
  now RE-HOMES each shared service (its blocks + run history) to a surviving mounting board, so it
  lives on there. A service no other board mounts is still fully reclaimed, so its repo is
  re-addable — mirrored across the Cloudflare (D1) and Node (Drizzle) facades (new
  `WorkspaceRepository.delete(id, rehome)` + `WorkspaceMountRepository.listByServiceIds`).
- **Board (workspace) deletion reclaims its account-owned services** (the un-shared ones). A dangling
  service — account-scoped, looked up by `(installation_id, repo_github_id)` — used to keep the SAME
  repo from being re-added on any other board. The cascade removes the workspace's un-shared homed
  services, every board's mount of them, this board's own mounts, and its environments.
- **Services with unfinished tasks can no longer be deleted — they are archived instead.**
  Archiving hides a service (its frame + whole subtree) from the board while preserving every row;
  it can be restored at any time with no expiry. New `POST /blocks/:id/archive` and
  `POST /blocks/:id/restore` endpoints, an `archived` column on `blocks` (both runtimes), an
  `archivedServices` list in the workspace snapshot, and inspector/toolbar affordances in the SPA.
  An archived shared service is now correctly hidden on every board that mounts it (not just its
  home) and restorable from any of them.
- The acting tab now drops a deleted service from its local catalog after the delete commits, so a
  repo becomes re-addable immediately without waiting for a full refresh (the tab is not echoed its
  own board event).
