---
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Document- and task-source integrations are now **always on** instead of opt-in, and
credential encryption is consolidated onto a single shared key.

The `DOCUMENTS_ENABLED` / `TASKS_ENABLED` flags are gone — tenants connect their own
Notion/Confluence/Jira sources interactively through the task-creation modal, so there
is no service-level toggle to forget. A missing encryption key now **fails loudly at
config load** rather than silently dropping the feature from the UI.

**Breaking — single encryption key.** The per-integration `DOCUMENTS_ENCRYPTION_KEY`,
`TASKS_ENCRYPTION_KEY`, `ENVIRONMENTS_ENCRYPTION_KEY` and `RUNNERS_ENCRYPTION_KEY` env
vars are **removed**. One shared **`ENCRYPTION_KEY`** now backs all four integrations
(the cipher already domain-separates per integration via its HKDF `info` tag, so a
single master key is safe). Deployments must set `ENCRYPTION_KEY`; the always-on
document/task sources refuse to boot without it, and the opt-in environment/runner
integrations read it too. The Node facade serves task sources only (it ships no
document providers yet), so it requires `ENCRYPTION_KEY` but no document-source wiring.
