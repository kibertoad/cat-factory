---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/workspaces': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/conformance': minor
'@cat-factory/app': minor
---

Make invalid-state pipelines more robust. On app open, a startup advisory surfaces pipelines that
reference a nonexistent agent kind or have an invalid shape (delete a custom one, reseed a built-in)
and built-in pipelines whose seeded definition is newer than the stored copy (reseed to adopt it).

Built-in pipelines now carry a per-pipeline `version` (persisted on both runtimes via a new D1
migration and a Drizzle column), the snapshot ships the current catalog versions
(`pipelineCatalogVersions`), and a new `POST /workspaces/:ws/pipelines/:id/reseed` endpoint restores a
built-in's canonical definition while preserving its labels/archive state.

BREAKING: existing workspaces' persisted built-in pipelines have no stored `version`, so they read as
"update available" once until reseeded — intentional adoption of the now-versioned definitions.
