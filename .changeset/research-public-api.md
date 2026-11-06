---
'@cat-factory/contracts': minor
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

Projects and research reach the public API (OpenAPI 1.97.0): publish and read research
definitions, create projects and link services, create and run tasks under a project
(`PublicProjectTask` under `/api/v1/projects/{projectId}/tasks`), read a research project's
findings and revisions, and resume a run parked on a missing capability credential
(`POST /api/v1/runs/{runId}/credential/resume`). The `/api/v1/tasks/{taskId}` operations that
answer a `PublicTask` refuse a project task with `task_owned_by_project`; the run projection and
the event stream serve both. Research project pins gain a batched read, `listByProjectIds`, on
both runtimes. The SDKs are regenerated.
