---
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/worker': minor
---

Deduplicate GitHub sync effort within an org.

Incremental-sync cursors were keyed per `(workspace_id, repo_github_id, kind)`, so two
workspaces in the same account that both tracked a repo each kept their own ETag/`since`
cursor and each reconcile pass fetched the repo from GitHub independently — N API
round-trips for one repo per org.

- Sync cursors are now keyed by `(installation_id, repo_github_id, kind)` (D1 migration
  `0032`): a repo is fetched from GitHub **once per org**.
- `GitHubSyncService.syncRepo` fans each projection out to **every** workspace in the org
  that links the repo, so one fetch keeps all the boards consistent; a second workspace's
  reconcile pass becomes a cheap conditional `304`. A `full` pass (used at repo-link time)
  bypasses the shared cursor so a freshly-linked workspace is still fully populated.

Projection reads stay per-workspace and unchanged. Verified: the worker GitHub suite
(28 tests) passes with the installation-scoped cursor + fan-out.
