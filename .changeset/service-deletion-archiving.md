---
'@cat-factory/contracts': patch
'@cat-factory/orchestration': patch
'@cat-factory/workspaces': patch
'@cat-factory/server': patch
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/app': patch
---

Fix stale service debris on board deletion and add service archiving.

- **Board (workspace) deletion now reclaims its account-owned services.** Deleting a board
  used to leave its `services` + `workspace_services` (and `environments`) rows behind. Because
  `services` is account-scoped and looked up by `(installation_id, repo_github_id)` with no
  workspace scope, a dangling service kept the SAME repo from being re-added on any other board
  ("already linked / already exists"). The delete cascade now removes the workspace's homed
  services, every board's mount of them, this board's own mounts, and its environments — mirrored
  across the Cloudflare (D1) and Node (Drizzle) facades.
- **Services with unfinished tasks can no longer be deleted — they are archived instead.**
  Archiving hides a service (its frame + whole subtree) from the board while preserving every row;
  it can be restored at any time with no expiry. New `POST /blocks/:id/archive` and
  `POST /blocks/:id/restore` endpoints, an `archived` column on `blocks` (both runtimes), an
  `archivedServices` list in the workspace snapshot, and inspector/toolbar affordances in the SPA.
- The acting tab now drops a deleted service from its local catalog after the delete commits, so a
  repo becomes re-addable immediately without waiting for a full refresh (the tab is not echoed its
  own board event).
