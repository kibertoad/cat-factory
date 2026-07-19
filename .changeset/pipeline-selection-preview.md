---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': minor
'@cat-factory/conformance': patch
---

Add an authored `description` to pipelines and preview a pipeline's steps + description when
selecting one.

Pipelines now carry an optional prose `description` (seeded for every built-in, editable on custom
pipelines in the builder), persisted alongside the step list on both runtimes (D1 + Postgres). The
pipeline pickers — in the add-task modal and the inspector run settings — are replaced with a rich
master–detail picker: hovering an option reveals that pipeline's description and its ordered agent
steps (with human-gated steps flagged), so you can see exactly what a pipeline does before choosing
it.
