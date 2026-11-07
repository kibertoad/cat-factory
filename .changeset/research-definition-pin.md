---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': patch
---

A research project pins its research definition when it is created. A project kind declares the
data it keeps (`data: 'research'`), and creating a project of such a kind takes a `research` field
naming the definition key, an optional version (the highest by default) and the values for the
definition's `inputs`. The project records the definition's version and content hash.

Definitions are read through one port, `ResearchDefinitionSource`: the ones a deployment
registers in code on a `ResearchDefinitionRegistry` (a new option on `start()`, `startLocal()` and
the Worker) composed with an account's stored ones. A mothership-mode node reads the registered
ones from the mothership over `GET /internal/research-definitions` and refuses with
`research_definitions_unreachable` when it cannot.

A research task's findings sequence number is now claimed per task (`reserveTaskSeq`), so a
replayed or retried start keeps its place. This replaces the per-call `reserveSeq` and adds the
`research_task_seqs` table on D1 (`0116_research_task_seqs.sql`) and Postgres.
