---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Replace the deployment-level `TASK_SOURCES` env allow-list with a per-workspace,
UI-driven on/off toggle for each task source (Jira / GitHub Issues), persisted in DB.

A source is now offered to a workspace when it is **available** AND **enabled**:

- Availability is intrinsic, not a deployment switch. Jira is always registered (its
  credentials are per-workspace, entered in the UI) and is available once connected.
  GitHub Issues registers whenever the GitHub integration is configured and is available
  once the workspace has installed the GitHub App — it rides that App, so there is nothing
  to "connect" (the credentialless connect path now returns a clear error).
- `enabled` is the new per-workspace toggle (defaults to on). A workspace can disable
  GitHub Issues to use GitHub repos without offering their issues, or park a connected
  Jira without disconnecting it. A disabled source is hidden from the import/link UI and
  its import/search endpoints are refused (409).

New surface:

- `task_source_settings` table, mirrored D1 (migration `0008_task_source_settings.sql`)
  ⇄ Drizzle (`taskSourceSettings` + generated migration), behind a new
  `TaskSourceSettingsRepository` kernel port.
- `GET /workspaces/:ws/task-sources` now returns each source's descriptor plus
  `available` + `enabled`; `PUT /workspaces/:ws/task-sources/:source/enabled` toggles it.
- The SPA settings modal hosts the toggle, and import entry points key off the offered
  (available + enabled) set instead of raw connections.

BREAKING: the `TASK_SOURCES` env var (Cloudflare `wrangler.toml` / Node `.env`) and
`TasksConfig.sources` are removed. Delete `TASK_SOURCES` from any deployment config —
which sources a workspace uses is now controlled in the app, not by the operator.
