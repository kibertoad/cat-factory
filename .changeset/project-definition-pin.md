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

A project pins a definition of its own kind when it is created. A project kind declares whether
its projects pin one (`definition: 'required' | 'optional'`), and creating such a project takes a
`definition` field naming the key, an optional version (the highest by default) and the values for
the definition's `inputs`. The project records the definition's version and content hash. The
refusals are `project_definition_required`, `project_definition_not_accepted`,
`project_definition_not_found` and `project_definition_inputs_invalid`.

Definitions are read through one port, `ProjectDefinitionSource`, keyed by kind: the ones a
deployment registers in code on a `ProjectDefinitionRegistry` (a new option on `start()`,
`startLocal()` and the Worker, constructed with each kind's spec validator) composed with an
account's stored ones. A mothership-mode node reads the registered ones from the mothership over
`GET /internal/project-definitions` and refuses with `project_definitions_unreachable` when it
cannot.

A project task's outcome sequence number is claimed per task (`reserveTaskSeq`), so a replayed or
retried start keeps its place; a taskless outcome still takes `reserveSeq` from the same order.
Adds the `project_task_seqs` table on D1 (`0116_project_task_seqs.sql`) and Postgres.
