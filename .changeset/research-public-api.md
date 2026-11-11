---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': patch
'@cat-factory/node-server': patch
'@cat-factory/local-server': patch
'@cat-factory/app': patch
'@cat-factory/sdk': minor
'@cat-factory/mcp-server': minor
'@cat-factory/gatekeeper-bindings': minor
---

Projects reach the public API (OpenAPI 1.97.0), for every project kind: list the project kinds and
read each one's JSON Schemas, publish and read a kind's definitions, create projects and link
services, create and run tasks under a project (`PublicProjectTask` under
`/api/v1/projects/{projectId}/tasks`), read a project's outcomes and the view its kind computes, and
resume a run parked on a missing capability credential
(`POST /api/v1/runs/{runId}/credential/resume`). A definition's spec, an outcome's body and a
project's view are opaque in the spec. The `/api/v1/tasks/{taskId}` operations that answer a
`PublicTask` refuse a project task with `task_owned_by_project`; the run projection and the event
stream serve both.

A `ProjectKindModule` may now declare `view` (its reading of a project's outcomes) and `schemas`
(the valibot schemas of its spec, outcome body and view); the research kind declares both.
Publishing goes through `ProjectDefinitionPublisher`, which validates the spec with the kind's
module through the new `validateProjectDefinition`. `ProjectRecordRepository` gains a batched
`listPins` on both runtimes. The SDKs are regenerated.
