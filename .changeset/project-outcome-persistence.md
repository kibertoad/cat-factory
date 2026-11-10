---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': patch
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Add project outcome persistence on both runtimes, for projects of any kind: account-published
project definitions (immutable per kind, key and version), the definition each project pins, an
atomic per-project outcome sequence, outcome revisions (first write wins, inline or offloaded body,
opaque to the platform) and the outcome-storage policy tiers. Migrations add five tables on D1
(`0115_project_outcomes.sql`) and Postgres. Deleting a project, or the board that homes it,
reclaims its records. Nothing writes these yet; the first project kind's run does in a later slice.
