---
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Document- and task-source integrations are now **always on** instead of opt-in.
The `DOCUMENTS_ENABLED` / `TASKS_ENABLED` flags are gone — tenants connect their
own Notion/Confluence/Jira sources interactively through the task-creation modal,
so there is no service-level toggle to forget. Each integration still requires its
encryption master key (`DOCUMENTS_ENCRYPTION_KEY` / `TASKS_ENCRYPTION_KEY`) to seal
per-workspace credentials at rest, but a missing key now **fails loudly at config
load** rather than silently dropping the feature from the UI. The Node facade serves
task sources only (it ships no document providers yet), so it requires
`TASKS_ENCRYPTION_KEY` but not `DOCUMENTS_ENCRYPTION_KEY`.
